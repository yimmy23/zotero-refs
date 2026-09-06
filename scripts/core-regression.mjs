import console from "node:console";
import process from "node:process";
import { setImmediate } from "node:timers";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

// Deterministic synthetic fixtures only: no Zotero process, profile, or network.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ref = (title, DOI, year = "2024") => ({
  title,
  text: title,
  authors: ["Smith"],
  year,
  identifiers: DOI ? { DOI } : {},
});
function item(id, title, DOI, libraryID = 1, date = "2024") {
  const fields = { title, DOI, date, extra: "", url: "" };
  return {
    id,
    libraryID,
    key: `KEY${id}`,
    fields,
    deleted: false,
    isRegularItem: () => true,
    getField: (name) => fields[name] || "",
  };
}
async function load(file, zotero = {}, extraExports = "", globals = {}) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  const compiled = await build({
    stdin: {
      contents: source + extraExports,
      resolveDir: path.dirname(path.join(root, file)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    console,
    Zotero: {
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1 },
      Promise: { delay: async () => {} },
      ...zotero,
    },
    addon: { data: {} },
    ztoolkit: { log: () => {} },
    PathUtils: { join: path.join },
    IOUtils: { exists: async () => false },
    Components: { utils: { isDeadWrapper: () => false } },
    ...globals,
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return { ...context.module.exports, context };
}

test("HTTP separates response formats and authentication contexts", async () => {
  let calls = 0;
  const { http } = await load("src/core/http.ts", {
    HTTP: {
      request: async (_method, _url, options) => {
        calls++;
        return {
          status: 200,
          response: `${options.responseType}:${options.headers?.token || "public"}`,
        };
      },
    },
  });
  assert.equal(await http.getText("https://example.test/work"), "text:public");
  assert.equal(await http.getJSON("https://example.test/work"), "json:public");
  assert.equal(
    await http.getJSON("https://example.test/work", {
      headers: { token: "test-token" },
    }),
    "json:test-token",
  );
  assert.equal(calls, 3);
});

test("HTTP gate transfers released capacity without exceeding its limit", async () => {
  const { HostGate } = await load(
    "src/core/http.ts",
    {},
    "\nexport { HostGate };\n",
  );
  const gate = new HostGate(1);
  await gate.acquire();
  let waitingEntered = false;
  const waiting = gate.acquire().then(() => {
    waitingEntered = true;
  });
  gate.release();
  let newcomerEntered = false;
  const newcomer = gate.acquire().then(() => {
    newcomerEntered = true;
  });
  await waiting;
  assert.equal(waitingEntered, true);
  assert.equal(newcomerEntered, false);
  gate.release();
  await newcomer;
  gate.release();
});

test("Library edits remove stale identifier/title matches", async () => {
  const entry = item(1, "Original article title", "10.1234/old");
  let observer;
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: { getAll: async () => [entry], get: () => entry },
    Notifier: {
      registerObserver: (value) => {
        observer = value;
        return "test";
      },
    },
  });
  libraryIndex.register();
  assert.equal((await libraryIndex.match(ref("", "10.1234/old")))?.id, 1);
  entry.fields.DOI = "10.1234/new";
  entry.fields.title = "Revised article title";
  observer.notify("modify", "item", [1]);
  assert.equal(await libraryIndex.match(ref("", "10.1234/old")), undefined);
  assert.equal(
    await libraryIndex.match(ref("Original article title")),
    undefined,
  );
  assert.equal((await libraryIndex.match(ref("", "10.1234/new")))?.id, 1);
});

test("Library prefix matching requires year and rejects identifier conflicts", async () => {
  const title = "A sufficiently long clinical trial title";
  const entry = item(1, `${title}: follow-up`, "10.1234/actual");
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: { getAll: async () => [entry], get: () => entry },
  });
  assert.equal(await libraryIndex.match(ref(title, undefined, "")), undefined);
  assert.equal(
    await libraryIndex.match(ref(title, "10.1234/different")),
    undefined,
  );
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2024")))?.id,
    1,
  );
});

test("Library negative prefix memoization includes publication year", async () => {
  const title = "A sufficiently long clinical trial title";
  const entry = item(1, `${title}: follow-up`, "10.1234/actual");
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: { getAll: async () => [entry], get: () => entry },
  });
  assert.equal(
    await libraryIndex.match(ref(title, undefined, "2000")),
    undefined,
  );
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2024")))?.id,
    1,
  );
});

test("Same-title articles retain every year-specific candidate", async () => {
  const title = "Identical clinical trial title";
  const entries = [
    item(1, title, "10.1234/2020", 1, "2020"),
    item(2, title, "10.1234/2024", 1, "2024"),
  ];
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async () => entries,
      get: (id) => entries.find((entry) => entry.id === id),
    },
  });
  const older = ref(title, undefined, "2020");
  assert.equal((await libraryIndex.match(older))?.id, 1);
  assert.equal(older.identifiers.DOI, "10.1234/2020");
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2024")))?.id,
    2,
  );
  assert.equal(
    await libraryIndex.match(ref(title, undefined, "2022")),
    undefined,
  );
  assert.equal(await libraryIndex.match(ref(title, undefined, "")), undefined);
  assert.equal(
    (await libraryIndex.match(ref(title, "10.1234/2020", "2099")))?.id,
    1,
    "An explicit identifier wins over an erroneous year",
  );
});

test("Exact-title matching rejects ambiguous and identifier-conflicting candidates", async () => {
  const title = "Identical clinical trial title";
  const entries = [
    item(1, title, "10.1234/first"),
    item(2, title, "10.1234/second"),
  ];
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async () => entries,
      get: (id) => entries.find((entry) => entry.id === id),
    },
  });
  const ambiguous = ref(title);
  assert.equal(await libraryIndex.match(ambiguous), undefined);
  assert.equal(ambiguous.identifiers.DOI, undefined);
  assert.equal(
    await libraryIndex.match(ref(title, "10.1234/neither")),
    undefined,
  );
  // URL-form DOI bypasses the raw DOI map and must disambiguate title candidates.
  assert.equal(
    (await libraryIndex.match(ref(title, "https://doi.org/10.1234/first")))?.id,
    1,
  );
});

test("Prefix matching retains duplicate-title candidates and separates identifier contexts", async () => {
  const title = "A sufficiently long clinical trial title";
  const entries = [
    item(1, `${title}: follow-up`, "10.1234/first"),
    item(2, `${title}: follow-up`, "10.1234/second"),
  ];
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async () => entries,
      get: (id) => entries.find((entry) => entry.id === id),
    },
  });
  assert.equal(await libraryIndex.match(ref(title)), undefined);
  assert.equal(
    await libraryIndex.match(ref(title, "10.1234/neither")),
    undefined,
  );
  assert.equal(
    (await libraryIndex.match(ref(title, "https://doi.org/10.1234/first")))?.id,
    1,
  );
  assert.equal(
    (await libraryIndex.match(ref(title, "https://doi.org/10.1234/second")))
      ?.id,
    2,
  );
});

test("Notifier additions and edits preserve all same-title candidates", async () => {
  const title = "Identical clinical trial title";
  const entries = [item(1, title, "10.1234/first")];
  let observer,
    builds = 0;
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async () => {
        builds++;
        return entries;
      },
      get: (id) => entries.find((entry) => entry.id === id),
    },
    Notifier: {
      registerObserver: (value) => {
        observer = value;
        return "test";
      },
    },
  });
  libraryIndex.register();
  assert.equal((await libraryIndex.match(ref(title)))?.id, 1);
  entries.push(item(2, title, "10.1234/second"));
  observer.notify("add", "item", [2]);
  assert.equal(await libraryIndex.match(ref(title)), undefined);
  assert.equal(
    builds,
    1,
    "Adding a same-title item should patch the index incrementally",
  );
  entries[1].fields.date = "2020";
  observer.notify("modify", "item", [2]);
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2020")))?.id,
    2,
  );
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2024")))?.id,
    1,
  );
});

test("Prefix candidate filtering uses years and retains its scan limit", async () => {
  const title = "A sufficiently long clinical trial title";
  const entries = [
    item(1, `${title}: follow-up`, "10.1234/2020", 1, "2020"),
    item(2, `${title}: follow-up`, "10.1234/2024", 1, "2024"),
  ];
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async () => entries,
      get: (id) => entries.find((entry) => entry.id === id),
    },
  });
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2020")))?.id,
    1,
  );
  assert.equal(
    (await libraryIndex.match(ref(title, undefined, "2024")))?.id,
    2,
  );
  // One long-title bucket must not bypass the prefix candidate scan limit.
  entries.splice(
    0,
    entries.length,
    ...Array.from({ length: 5001 }, (_, i) =>
      item(i + 1, `${title}: follow-up`, `10.1234/${i + 1}`),
    ),
  );
  libraryIndex.invalidate();
  assert.equal(
    await libraryIndex.match(ref(title, "https://doi.org/10.1234/1")),
    undefined,
  );
});

test("Library builds recover after a temporary getAll failure", async () => {
  const entry = item(1, "A clinical paper", "10.1234/actual");
  let calls = 0;
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async () => {
        if (++calls === 1) throw Error("test failure");
        return [entry];
      },
      get: () => entry,
    },
  });
  await assert.rejects(libraryIndex.match(ref("", "10.1234/actual")));
  assert.equal((await libraryIndex.match(ref("", "10.1234/actual")))?.id, 1);
});

test("Concurrent library lookups never return items from another library", async () => {
  const entries = [
    item(1, "Shared title", "10.1234/shared", 1),
    item(2, "Shared title", "10.1234/shared", 2),
  ];
  const { libraryIndex } = await load("src/core/libmatch.ts", {
    Items: {
      getAll: async (libraryID) =>
        entries.filter((entry) => entry.libraryID === libraryID),
      get: (id) => entries.find((entry) => entry.id === id),
    },
  });
  const matches = await Promise.all(
    [1, 2, 1, 2].map((libraryID) =>
      libraryIndex.match(ref("", "10.1234/shared"), libraryID),
    ),
  );
  assert.deepEqual(
    matches.map((entry) => entry?.libraryID),
    [1, 2, 1, 2],
  );
});

test("Title-based popup candidates reject derivative search results", async () => {
  const { infoCandidates, sources } = await load("src/sources/index.ts");
  for (const source of Object.values(sources)) {
    source.getInfoByTitle = async () =>
      ref("Review of the original trial", "10.1234/wrong");
  }
  const candidates = infoCandidates(ref("The original trial"));
  assert.equal(
    (await Promise.all(candidates.thunks.map((fn) => fn()))).filter(Boolean)
      .length,
    0,
  );
  sources.crossref.getInfoByTitle = async () =>
    ref("The original trial", "10.1234/right");
  assert.equal(
    (await infoCandidates(ref("The original trial")).thunks[0]())?.identifiers
      .DOI,
    "10.1234/right",
  );
});

test("Every import entry point respects declined retracted-paper confirmation", async () => {
  const { importReference, importAll, context } = await load(
    "src/core/importer.ts",
  );
  let prompts = 0;
  context.Services = {
    prompt: {
      confirm: () => {
        prompts++;
        return false;
      },
    },
  };
  context.Zotero.getMainWindow = () => ({});
  const retracted = {
    ...ref("Retracted synthetic paper", "10.1234/retracted"),
    retracted: true,
  };
  assert.equal(await importReference({}, retracted), null);
  const batch = await importAll({}, [retracted], undefined, () => {});
  assert.equal(batch.ok, 0);
  assert.equal(prompts, 2);
});

test("Provider DOI requests preserve reserved characters in the identifier", async () => {
  const urls = [];
  const { sources } = await load("src/sources/index.ts", {
    HTTP: {
      request: async (_method, url) => {
        urls.push(new URL(url));
        return { status: 404 };
      },
    },
  });
  await sources.openalex.getInfoByDOI("10.1234/a?b#c");
  await sources.semanticscholar.getInfoByDOI("10.1234/a?b#c");
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.hash, "");
    assert.ok(decodeURIComponent(url.pathname).endsWith("10.1234/a?b#c"));
  }
});

test("Fusion never enriches a PDF DOI with a conflicting API record", async () => {
  const { fuseReferences } = await load("src/core/fuse.ts");
  const title = "A sufficiently long clinical trial title";
  const original = {
    ...ref(title, "10.1234/pdf"),
    text: `Smith. ${title}. 2024.`,
    number: 1,
  };
  const result = await fuseReferences(
    [original],
    [ref(title, "10.1234/api")],
    "crossref",
  );
  assert.equal(result.stats.title, 0);
  assert.equal(result.stats.unmatched, 1);
});

test("Fusion never verifies position from a publication year alone", async () => {
  const { fuseReferences } = await load("src/core/fuse.ts");
  const pdf = [1, 2, 3].map((n) => ({
    ...ref(`Original trial ${n}`),
    text: `Jones J. Original trial ${n}. 2020.`,
    year: "2020",
    number: n,
  }));
  const api = [1, 2, 3].map((n) => ({
    ...ref("", `10.1234/foreign-${n}`, "2020"),
    authors: [],
  }));
  for (const title of [undefined, "Short"]) {
    const fused = await fuseReferences(pdf, api, "crossref", async () => ({
      identifiers: {},
      authors: [],
      title,
      year: "2020",
    }));
    assert.equal(fused.stats.positional, 0);
    assert.ok(fused.refs.every((r) => !r.identifiers.DOI));
  }
});

test("Fusion rejects derivative titles even without API authors", async () => {
  const { fuseReferences } = await load("src/core/fuse.ts");
  const title = "A randomized trial of immunotherapy in lung cancer";
  const pdf = {
    ...ref(`Replication study: ${title}`, undefined, "2020"),
    text: `Jones J. Replication study: ${title}. Journal. 2020; 1:10-20.`,
    authors: ["Jones J"],
  };
  const api = { ...ref(title, "10.1234/original", "2020"), authors: [] };
  const rejected = await fuseReferences([pdf], [api], "semanticscholar");
  assert.equal(rejected.stats.title, 0);
  assert.equal(rejected.refs[0].identifiers.DOI, undefined);
  const accepted = await fuseReferences(
    [{ ...pdf, title, text: `Jones J. ${title}. Journal. 2020; 1:10-20.` }],
    [api],
    "semanticscholar",
  );
  assert.equal(accepted.stats.title, 1);
});

test("Fusion volume and page fallback requires author corroboration", async () => {
  const { fuseReferences } = await load("src/core/fuse.ts");
  const pdf = {
    ...ref("An original study", undefined, "2020"),
    text: "Jones J. An original study. Journal. 2020; 12:100-110.",
  };
  const api = {
    ...ref("", "10.1234/unrelated", "2020"),
    authors: [],
    text: "2020, 12, 100",
  };
  assert.equal(
    (await fuseReferences([pdf], [api], "crossref")).stats.volPage,
    0,
  );
  assert.equal(
    (await fuseReferences([pdf], [{ ...api, authors: ["Jones"] }], "crossref"))
      .stats.volPage,
    1,
  );
});

test("CNKI bibliography matching rejects short-title and ambiguous candidates", async () => {
  let candidates = [
    { title: "肺癌", fileName: "WRONG", tableName: "CJFD", dbSource: "CJFD" },
    {
      title: "非小细胞肺癌免疫治疗进展",
      fileName: "RIGHT",
      tableName: "CJFD",
      dbSource: "CJFD",
    },
  ];
  const { fetchFileInfo } = await load(
    "src/sources/cnki.ts",
    {
      HTTP: {
        request: async (_method, url) => ({
          status: 200,
          response: url.includes("/paperInfo?")
            ? {
                code: 200,
                content: {
                  paper: {
                    bibliography: [
                      {
                        title:
                          "[1] 张三. 非小细胞肺癌免疫治疗进展[J]. 中华肿瘤杂志, 2020, 12(1): 10-20.",
                      },
                    ],
                  },
                },
              }
            : { code: 200, content: { refer: candidates } },
        }),
      },
    },
    "\nexport {fetchFileInfo};\n",
  );
  const result = await fetchFileInfo("HOST", "synthetic", "synthetic");
  assert.ok(result[0].identifiers.CNKI.includes("FileName=RIGHT"));
  candidates = [...candidates, { ...candidates[1], fileName: "DUPLICATE" }];
  assert.equal(
    (await fetchFileInfo("HOST", "synthetic", "synthetic"))[0].identifiers.CNKI,
    undefined,
  );
  candidates = candidates.slice(0, 1);
  assert.equal(
    (await fetchFileInfo("HOST", "synthetic", "synthetic"))[0].identifiers.CNKI,
    undefined,
  );
});

test("Storage serializes overlapping flushes and writes the newest snapshot last", async () => {
  let active = 0;
  let maximum = 0;
  const writes = [];
  const releases = [];
  const win = { closed: false, setTimeout: () => 1, clearTimeout: () => {} };
  const { refStorage } = await load("src/core/storage.ts", {
    DataDirectory: { dir: "/synthetic" },
    getMainWindow: () => win,
    File: {
      putContentsAsync: async (_path, content) => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => releases.push(resolve));
        writes.push(JSON.parse(content));
        active--;
      },
    },
  });
  const entry = item(1, "Host", "");
  await refStorage.set(entry, "API", [ref("Old snapshot")]);
  const shown = await refStorage.get(entry, "API");
  shown[0].libItemID = 99;
  shown[0].identifiers.DOI = "10.1234/runtime-only";
  shown[0].authors.push("Runtime Author");
  const fresh = await refStorage.get(entry, "API");
  assert.equal(fresh[0].libItemID, undefined);
  assert.equal(fresh[0].identifiers.DOI, undefined);
  assert.ok(!fresh[0].authors.includes("Runtime Author"));
  const first = refStorage.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await refStorage.set(entry, "API", [ref("New snapshot")]);
  const second = refStorage.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 1);
  releases.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await second;
  assert.equal(writes.at(-1).items["1/KEY1"].API.refs[0].title, "New snapshot");
});

test("A crafted cache key cannot modify Object.prototype", async () => {
  const raw = JSON.stringify({
    v: 2,
    items: JSON.parse(
      '{"__proto__":{"polluted":{"t":1,"refs":[{"title":"Synthetic","authors":[],"identifiers":{}}]}}}',
    ),
  });
  const { refStorage, context } = await load(
    "src/core/storage.ts",
    {
      DataDirectory: { dir: "/synthetic" },
      File: { getContentsAsync: async () => raw },
    },
    "",
    { IOUtils: { exists: async () => true } },
  );
  await refStorage.get(item(1, "Host", ""), "API");
  assert.equal(vm.runInContext("({}).polluted", context), undefined);
});

test("arXiv versions of the same work do not contradict a shared DOI", async () => {
  const { identifiersConflict } = await load("src/core/text.ts");
  assert.equal(
    identifiersConflict(
      { DOI: "10.1234/shared", arXiv: "2401.12345" },
      { DOI: "10.1234/shared", arXiv: "2401.12345v2" },
    ),
    false,
  );
  assert.equal(
    identifiersConflict({ arXiv: "2401.12345v1" }, { arXiv: "2401.54321v2" }),
    true,
  );
  assert.equal(
    identifiersConflict(
      { DOI: "10.1234/a", arXiv: "2401.12345" },
      { DOI: "10.1234/b", arXiv: "2401.12345v2" },
    ),
    true,
  );
});

test("Disabling cache bypasses old entries and does not cache failures", async () => {
  let hours = 1,
    calls = 0;
  const { http } = await load("src/core/http.ts", {
    Prefs: { get: () => hours },
    HTTP: {
      request: async () => ({
        status: ++calls <= 2 ? 200 : 404,
        response: calls,
      }),
    },
  });
  assert.equal(await http.getJSON("https://example.test/toggle"), 1);
  hours = 0;
  assert.equal(await http.getJSON("https://example.test/toggle"), 2);
  await http.getJSON("https://example.test/missing");
  await http.getJSON("https://example.test/missing");
  assert.equal(calls, 4);
});

test("arXiv and PubMed requests reserve provider-specific start intervals", async () => {
  let now = 0;
  const waits = [],
    starts = [];
  const { http } = await load(
    "src/core/http.ts",
    {
      Promise: {
        delay: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
      HTTP: {
        request: async (_method, url) => {
          starts.push([url, now]);
          return { status: 200, response: {} };
        },
      },
    },
    "",
    {
      Date: class extends Date {
        static now() {
          return now;
        }
      },
    },
  );
  await http.getJSON("https://export.arxiv.org/api/query?id_list=first");
  await http.getJSON("https://export.arxiv.org/api/query?id_list=second");
  await http.getJSON(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?id=1",
  );
  await http.getJSON(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?id=2",
  );
  assert.ok(starts[1][1] - starts[0][1] >= 3000);
  assert.ok(starts[3][1] - starts[2][1] >= 334);
});

test("OpenAlex sends an optional key in the header, never in the URL", async () => {
  let captured;
  const { openalex } = await load("src/sources/openalex.ts", {
    Prefs: {
      get: (key) => (key.endsWith("openAlexApiKey") ? "synthetic-key" : ""),
    },
    HTTP: {
      request: async (_method, url, options) => {
        captured = { url, options };
        return {
          status: 200,
          response: { id: "https://openalex.org/W1", title: "Synthetic paper" },
        };
      },
    },
  });
  const info = await openalex.getInfoByDOI("10.1234/example");
  assert.equal(info.title, "Synthetic paper");
  assert.equal(captured.options.headers.Authorization, "Bearer synthetic-key");
  assert.equal(captured.url.includes("synthetic-key"), false);
  assert.equal(captured.url.includes("mailto"), false);
});

async function checkResumePacing(host, interval, limit, sequential) {
  let now = 0;
  let active = 0;
  let maximum = 0;
  let complete = false;
  const starts = [];
  const timers = [];
  const delay = (ms) =>
    new Promise((resolve) => timers.push({ at: now + ms, resolve }));
  const { http } = await load(
    "src/core/http.ts",
    {
      Prefs: { get: () => 0 },
      Promise: { delay },
      HTTP: {
        request: async () => {
          starts.push(now);
          maximum = Math.max(maximum, ++active);
          // Keep NCBI responses in flight long enough to exercise all slots.
          await delay(sequential ? 10 : interval * 5);
          active--;
          return { status: 200, response: {} };
        },
      },
    },
    "",
    {
      Date: class extends Date {
        static now() {
          return now;
        }
      },
    },
  );
  const request = (i) => http.getJSON(`https://${host}/synthetic?id=${i}`);
  const pending = (
    sequential
      ? (async () => {
          for (let i = 0; i < 4; i++) await request(i);
        })()
      : Promise.all(Array.from({ length: 7 }, (_, i) => request(i)))
  ).then(() => {
    complete = true;
  });
  const tick = async (time) => {
    now = time;
    const due = timers.filter((timer) => timer.at <= now);
    for (const timer of due) {
      timers.splice(timers.indexOf(timer), 1);
      timer.resolve();
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  await new Promise((resolve) => setImmediate(resolve));
  if (sequential) await tick(10); // First response completes; rate timer is pending.
  await tick(10000); // Simulate all expired timers waking after Mac sleep.
  for (let i = 0; !complete && i < 100; i++) {
    assert.ok(timers.length, "Requests must not lose a concurrency slot");
    await tick(Math.min(...timers.map((timer) => timer.at)));
  }
  assert.equal(complete, true);
  await pending;
  assert.ok(
    maximum <= limit,
    `Observed ${maximum} concurrent requests (limit ${limit})`,
  );
  if (!sequential)
    assert.equal(maximum, limit, "Pacing must retain available concurrency");
  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i] - starts[i - 1] >= interval,
      `Request starts ${starts.join(", ")} must stay ${interval} ms apart after sleep`,
    );
  }
}

test("arXiv sequential requests stay spaced after an oversleeping timer", async () => {
  await checkResumePacing("export.arxiv.org", 3000, 1, true);
});

test("Concurrent PubMed requests stay spaced when expired timers wake together", async () => {
  await checkResumePacing("eutils.ncbi.nlm.nih.gov", 350, 3, false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} core regressions passed`);
process.exitCode = failed ? 1 : 0;
