import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { DOMParser } from "@xmldom/xmldom";

// Production modules with synthetic, offline Zotero/API fixtures only.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, run) => tests.push([name, run]);
async function load(file, extra = "", zotero = {}, globals = {}) {
  const compiled = await build({
    stdin: {
      contents: (await fs.readFile(path.join(root, file), "utf8")) + extra,
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
      DataDirectory: { dir: "/synthetic" },
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1 },
      Promise: { delay: async () => {} },
      ...zotero,
    },
    addon: { data: {} },
    ztoolkit: { log: () => {}, getDOMParser: () => new DOMParser() },
    PathUtils: { join: path.join },
    IOUtils: { exists: async () => false },
    Components: { utils: { isDeadWrapper: () => false } },
    ...globals,
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return context.module.exports;
}
const ref = (extra = {}) => ({
  identifiers: {},
  title: "Synthetic clinical article with enough title evidence",
  text: "Molina JR. Synthetic clinical article with enough title evidence. Source Journal. 2008;12:100.",
  authors: ["Molina JR"],
  year: "2008",
  ...extra,
});

test("author names preserve initials, particles, comma forms, suffixes and single-field groups", async () => {
  const { parseAuthorName, authorFamilyName } = await load(
    "src/core/authorNames.ts",
  );
  for (const [name, expected] of [
    ["Molina JR", { firstName: "JR", lastName: "Molina" }],
    ["Julian R. Molina", { firstName: "Julian R.", lastName: "Molina" }],
    ["Molina, Julian R.", { firstName: "Julian R.", lastName: "Molina" }],
    ["de la Cruz A B", { firstName: "A B", lastName: "de la Cruz" }],
    ["Alice van der Waals", { firstName: "Alice", lastName: "van der Waals" }],
    ["John Smith, Jr.", { firstName: "John", lastName: "Smith Jr." }],
    ["王小明", { lastName: "王小明", fieldMode: 1 }],
    [
      "The Clinical Trial Consortium",
      { lastName: "The Clinical Trial Consortium", fieldMode: 1 },
    ],
    ["Molina JR et al.", { firstName: "JR", lastName: "Molina" }],
    ["LI Y", { lastName: "LI Y", fieldMode: 1 }],
    ["CHU AB", { lastName: "CHU AB", fieldMode: 1 }],
    ["CHU A B", { lastName: "CHU A B", fieldMode: 1 }],
    ["LI, Y", { firstName: "Y", lastName: "LI" }],
  ])
    assert.deepEqual(
      JSON.parse(JSON.stringify(parseAuthorName(name))),
      expected,
      name,
    );
  for (const name of ["et al.", "...", "…", "等", ""])
    assert.equal(parseAuthorName(name), undefined);
  assert.equal(authorFamilyName("John Smith Jr."), "Smith");
});

test("fusion corroborates the same author with given-family and surname-initials formats", async () => {
  const { fuseReferences } = await load("src/core/fuse.ts");
  for (const name of ["Julian R Molina", "Molina JR", "Molina, Julian R"]) {
    const result = await fuseReferences(
      [ref()],
      [ref({ authors: [name], identifiers: { DOI: "10.5555/right" } })],
      "semanticscholar",
    );
    assert.equal(result.stats.title, 1, name);
    assert.equal(result.refs[0].identifiers.DOI, "10.5555/right");
  }
  const wrong = await fuseReferences(
    [ref()],
    [
      ref({
        authors: ["Julian R Other"],
        identifiers: { DOI: "10.5555/wrong" },
      }),
    ],
    "semanticscholar",
  );
  assert.equal(wrong.refs[0].identifiers.DOI, undefined);
});

test("fusion carries the truncation status of the selected byline", async () => {
  const { fuseReferences } = await load("src/core/fuse.ts");
  const doi = { DOI: "10.5555/exact" };
  const truncated = await fuseReferences(
    [ref({ identifiers: doi })],
    [
      ref({
        identifiers: doi,
        authors: ["Julian Molina"],
        authorsTruncated: true,
      }),
    ],
    "openalex",
  );
  assert.equal(truncated.refs[0].authorsTruncated, true);
  const complete = await fuseReferences(
    [ref({ identifiers: doi, authorsTruncated: true })],
    [ref({ identifiers: doi, authors: ["Julian Molina"] })],
    "crossref",
  );
  assert.equal(complete.refs[0].authorsTruncated, undefined);
});

test("metadata imports never save initials or et al as surnames or fabricated creators", async () => {
  let creators;
  const { createItemFromInfo } = await load("src/core/importer.ts", "", {
    Item: class {
      constructor() {
        this.itemTypeID = 1;
      }
      setField() {}
      getField() {
        return "";
      }
      setCreators(value) {
        creators = value;
      }
      addToCollection() {}
      async saveTx() {}
    },
    ItemFields: { getID: (value) => value, isValidForType: () => true },
  });
  await createItemFromInfo(
    ref({
      authors: [
        "Molina JR et al.",
        "et al.",
        "Alice van der Waals",
        "Study Consortium",
        "王小明",
        "LI Y",
      ],
    }),
    [],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(creators)), [
    { creatorType: "author", firstName: "JR", lastName: "Molina" },
    { creatorType: "author", firstName: "Alice", lastName: "van der Waals" },
    { creatorType: "author", lastName: "Study Consortium", fieldMode: 1 },
    { creatorType: "author", lastName: "王小明", fieldMode: 1 },
    { creatorType: "author", lastName: "LI Y", fieldMode: 1 },
  ]);
});

test("Crossref retains given and family names including a collective name", async () => {
  const { mapWork } = await load(
    "src/sources/crossref.ts",
    "\nexport { mapWork };\n",
  );
  const result = mapWork({
    DOI: "10.5555/fixture",
    title: ["Source title"],
    author: [
      { given: "Julian R.", family: "Molina" },
      { name: "Study Consortium" },
      { given: "Alice", family: "van der Waals" },
    ],
  });
  assert.deepEqual(Array.from(result.authors), [
    "Julian R. Molina",
    "Study Consortium",
    "Alice van der Waals",
  ]);
});

test("OpenAlex cap and omitted names cannot masquerade as a complete byline", async () => {
  const { mapWork } = await load(
    "src/sources/openalex.ts",
    "\nexport { mapWork };\n",
  );
  const authorships = Array.from({ length: 100 }, (_, index) => ({
    author: { display_name: `Author ${index}` },
    author_position: index === 0 ? "first" : "middle",
  }));
  assert.equal(mapWork({ authorships }).authorsTruncated, true);
  assert.equal(
    mapWork({
      authorships: [{ author: { display_name: "Alice" } }],
      is_authors_truncated: true,
    }).authorsTruncated,
    true,
  );
  assert.equal(
    mapWork({ authorships: [{ author: { display_name: "Alice" } }, {}] })
      .authorsTruncated,
    true,
  );
  authorships[99].author_position = "last";
  assert.equal(mapWork({ authorships }).authorsTruncated, undefined);
});

test("persistent reference snapshots preserve only a boolean truncation marker", async () => {
  const { sanitizeRef } = await load(
    "src/core/storage.ts",
    "\nexport { sanitizeRef };\n",
  );
  assert.equal(
    sanitizeRef(ref({ authorsTruncated: true })).authorsTruncated,
    true,
  );
  assert.equal(
    sanitizeRef(ref({ authorsTruncated: "true" })).authorsTruncated,
    undefined,
  );
});

test("PubMed prefers the full EFetch byline over initial-only ESummary names", async () => {
  const { pubmed } = await load("src/sources/pubmed.ts", "", {
    HTTP: {
      request: async (_method, url) => ({
        status: 200,
        response: url.includes("esummary")
          ? {
              result: {
                11111111: {
                  title: "Source title",
                  authors: [{ name: "Molina JR" }],
                  articleids: [],
                  pubdate: "2008",
                },
              },
            }
          : "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>11111111</PMID><Article><AuthorList><Author><LastName>Molina</LastName><ForeName>Julian R</ForeName></Author></AuthorList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>",
      }),
    },
  });
  assert.deepEqual(
    Array.from((await pubmed.getInfoByPMID("11111111")).authors),
    ["Julian R Molina"],
  );
});

test("CNKI uses the valid reader reference list when successful paperInfo has no bibliography", async () => {
  for (const bibliography of [[], undefined]) {
    const { fetchFileInfo } = await load(
      "src/sources/cnki.ts",
      "\nexport { fetchFileInfo };\n",
      {
        HTTP: {
          request: async (_method, url) => ({
            status: 200,
            response: url.includes("/paperInfo?")
              ? { code: 200, content: { paper: { bibliography } } }
              : {
                  code: 200,
                  content: {
                    refer: [
                      {
                        citationNumber: "2",
                        title: "Second",
                        fileName: "SECOND",
                        tableName: "CJFD",
                        dbSource: "CJFD",
                        author: "王五",
                        year: "2024",
                      },
                      {
                        citationNumber: "1",
                        title: "First",
                        fileName: "FIRST",
                        tableName: "CJFD",
                        dbSource: "CJFD",
                        author: "张三",
                        year: "2023",
                      },
                    ],
                  },
                },
          }),
        },
      },
    );
    const result = await fetchFileInfo("HOST", "synthetic", "synthetic");
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "First");
    assert.equal(result[1].title, "Second");
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const batchItem = (id) => ({
  id,
  key: `ITEM${id}`,
  libraryID: 1,
  fields: {
    title: "Original synthetic host paper",
    DOI: `10.5555/host${id}`,
    date: "2024",
  },
  relatedItems: [],
  saves: 0,
  getField(key) {
    return this.fields[key] || "";
  },
  getCollections: () => [7],
  addRelatedItem(item) {
    this.relatedItems.push(item.key);
  },
  async saveTx() {
    this.saves++;
  },
});
async function batchFixture(options = {}) {
  const addonState = { data: { alive: true } };
  const host = batchItem(1);
  const targets = [2, 3].map((id) =>
    ref({ identifiers: { DOI: `10.5555/reference${id}` } }),
  );
  const entered = deferred();
  const release = deferred();
  const created = [];
  const windows = [];
  class ProgressWindow {
    constructor() {
      this.lines = [];
      this.win = { close() {}, addDescription() {} };
      windows.push(this);
    }
    createLine(line) {
      this.lines.push(line);
      return this;
    }
    show() {
      return this;
    }
    changeLine(line) {
      this.lines.push(line);
    }
    changeHeadline(headline) {
      this.headline = headline;
    }
    startCloseTimer() {}
  }
  const api = await load(
    "src/core/importer.ts",
    '\nexport { runBatchImport } from "../ui/batchImport";\n',
    {
      Items: { getAll: async () => [] },
      getMainWindow: () => ({}),
      Translate: {
        Search: class {
          setIdentifier() {}
          getTranslators = async () => [{}];
          setTranslator() {}
          async translate(args) {
            const item = batchItem(created.length + 2);
            item.importOptions = args;
            created.push(item);
            if (created.length === (options.pauseAt || 1)) {
              entered.resolve();
              await release.promise;
            }
            return [item];
          }
        },
      },
    },
    {
      addon: addonState,
      Services: {
        prompt: { confirm: () => options.confirm?.(host) ?? true },
      },
      ztoolkit: { log: () => {}, ProgressWindow },
    },
  );
  return {
    ...api,
    host,
    targets,
    entered,
    release,
    created,
    windows,
    addonState,
  };
}

test("batch imports stop before association when the host changes or is deleted during translation", async () => {
  for (const [name, mutate] of [
    ["DOI", (host) => (host.fields.DOI = "10.5555/changed")],
    ["title", (host) => (host.fields.title = "Another paper")],
    ["year", (host) => (host.fields.date = "1990")],
    ["CNKI URL", (host) => (host.fields.url = "https://cnki.net/other")],
    ["library", (host) => (host.libraryID = 2)],
    ["deleted", (host) => (host.deleted = true)],
  ]) {
    const f = await batchFixture();
    const progress = [];
    const pending = f.importAll(f.host, f.targets, undefined, (...args) =>
      progress.push(args),
    );
    await f.entered.promise;
    mutate(f.host);
    f.release.resolve();
    assert.deepEqual(
      JSON.parse(JSON.stringify(await pending)),
      {
        ok: 0,
        fail: 0,
        stopped: 2,
      },
      name,
    );
    assert.equal(f.created.length, 1, `${name}: no subsequent import`);
    assert.equal(f.host.relatedItems.length, 0, `${name}: host relation`);
    assert.equal(
      f.created[0].relatedItems.length,
      0,
      `${name}: reverse relation`,
    );
    assert.equal(f.host.saves, 0, `${name}: obsolete host never saved`);
    assert.equal(f.targets[0].libItemID, undefined, name);
    assert.equal(progress.length, 0, name);
  }
});

test("unchanged host identity allows normal imports and bidirectional relations", async () => {
  const f = await batchFixture();
  const pending = f.importAll(f.host, f.targets, undefined, () => {});
  await f.entered.promise;
  f.host.fields.abstractNote = "An unrelated metadata edit";
  f.release.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: 2,
    fail: 0,
    stopped: 0,
  });
  assert.deepEqual(f.host.relatedItems, ["ITEM2", "ITEM3"]);
  assert.equal(f.host.saves, 2);
  for (let i = 0; i < f.created.length; i++) {
    assert.deepEqual(f.created[i].relatedItems, ["ITEM1"]);
    assert.equal(f.created[i].saves, 1);
    assert.equal(f.created[i].importOptions.libraryID, 1);
    assert.deepEqual(f.created[i].importOptions.collections, [7]);
    assert.equal(f.targets[i].libItemID, f.created[i].id);
  }
});

test("a host edit preserves completed batch relations but stops the current and remaining references", async () => {
  const f = await batchFixture({ pauseAt: 2 });
  f.targets.push(ref({ identifiers: { DOI: "10.5555/reference4" } }));
  const pending = f.importAll(f.host, f.targets, undefined, () => {});
  await f.entered.promise;
  f.host.fields.DOI = "10.5555/other";
  f.release.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: 1,
    fail: 0,
    stopped: 2,
  });
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.host.relatedItems, ["ITEM2"]);
  assert.deepEqual(f.created[0].relatedItems, ["ITEM1"]);
  assert.deepEqual(f.created[1].relatedItems, []);
  assert.equal(f.targets[1].libItemID, undefined);
});

test("closing the batch progress window cancels an in-flight relation and subsequent imports", async () => {
  const f = await batchFixture();
  const pending = f.runBatchImport(f.host, f.targets, "Batch");
  await f.entered.promise;
  f.windows[0].win.close();
  f.release.resolve();
  const result = await pending;
  assert.equal(result.ok, 0);
  assert.equal(result.stopped, 2);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.host.relatedItems, []);
  assert.deepEqual(f.created[0].relatedItems, []);
  assert.equal(f.windows[0].headline, undefined);
  assert.match(f.windows[1].lines[0].text, /import-cancelled/);
});

test("plugin shutdown stops in-flight batches without recreating progress UI", async () => {
  const f = await batchFixture();
  const pending = f.runBatchImport(f.host, f.targets, "Batch");
  await f.entered.promise;
  f.addonState.data.alive = false;
  f.release.resolve();
  const result = await pending;
  assert.equal(result.ok, 0);
  assert.equal(result.stopped, 2);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.host.relatedItems, []);
  assert.deepEqual(f.created[0].relatedItems, []);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].headline, undefined);
});

test("batch confirmation cannot start imports for a host edited while the dialog is open", async () => {
  const f = await batchFixture({
    confirm(host) {
      host.fields.DOI = "10.5555/changed-in-dialog";
      return true;
    },
  });
  const result = await f.runBatchImport(f.host, f.targets, "Batch");
  assert.equal(result.ok, 0);
  assert.equal(result.stopped, 2);
  assert.equal(f.created.length, 0);
  assert.equal(f.windows[0].headline, undefined);
  assert.match(f.windows[1].lines[0].text, /import-cancelled/);
});

for (const [name, run] of tests) {
  await run();
  console.log(`ok - ${name}`);
}
console.log(
  `PASS: ${tests.length} author, source and batch identity regressions`,
);
