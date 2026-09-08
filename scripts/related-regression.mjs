import console from "node:console";
import process from "node:process";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

// Bundle the real fusion/registry/provider modules against synthetic HTTP.
// No Zotero, credentials, profile, network or production build is used.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const ref = (identifiers = {}, title = "Fixture paper", extra = {}) => ({
  identifiers,
  title,
  authors: ["Fixture Author"],
  ...extra,
});
const snapshot = (source, items, status = "ready") => ({
  source,
  status,
  items,
});
const defer = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function load({
  providers,
  http = async () => {
    throw new Error("Unexpected HTTP");
  },
} = {}) {
  const stubs = {
    "../core/http":
      "export const http = {getJSON: (...args) => fixtureHTTP(...args)};",
    "../utils/prefs": "export const getPref = () => undefined;",
    "../utils/locale": "export const getString = key => key;",
    "../core/text":
      "export const cleanText = v => typeof v === 'string' ? v : ''; export const identifiersToURL = () => ''; export const hostIdentifiers = () => ({}); export const isChinese = () => false; export const titlesMatch = () => false;",
  };
  for (const name of [
    "arxiv",
    "cnki",
    "connectedpapers",
    "crossref",
    "pubmed",
    "readpaper",
    "unpaywall",
  ]) {
    stubs[`./${name}`] = `export const ${name} = {};`;
  }
  if (providers) {
    stubs["./semanticscholar"] =
      "export const semanticscholar = {getRelated: (...args) => fixtureProviders.semanticscholar(...args)};";
    stubs["./openalex"] =
      "export const openalex = {getRelated: (...args) => fixtureProviders.openalex(...args)};";
  }
  const compiled = await build({
    stdin: {
      contents:
        'export * from "./src/core/related"; export {getRelatedByAPI} from "./src/sources/index"; export {openalex} from "./src/sources/openalex"; export {semanticscholar} from "./src/sources/semanticscholar";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
    plugins: [
      {
        name: "related-fixtures",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            Object.hasOwn(stubs, args.path)
              ? { path: args.path, namespace: "fixture" }
              : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: stubs[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    console,
    fixtureHTTP: http,
    fixtureProviders: providers,
    ztoolkit: { log: () => {} },
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return context.module.exports;
}
const pure = await load();

test("identity normalizes namespaced DOI, PMID, OpenAlex, S2 and arXiv", () => {
  const pairs = [
    [
      { DOI: " DOI: https://DX.doi.org/10.1234/ABC%2FDef " },
      { DOI: "10.1234/abc/def" },
    ],
    [
      { PMID: "https://pubmed.ncbi.nlm.nih.gov/012345/" },
      { PMID: "PMID:12345" },
    ],
    [{ openAlex: "https://openalex.org/W123" }, { openAlex: "w123" }],
    [
      { s2: "https://www.semanticscholar.org/paper/some-title/ABC123" },
      { s2: "abc123" },
    ],
    [
      { arXiv: "https://arxiv.org/pdf/2301.12345v2.pdf" },
      { arXiv: "arXiv:2301.12345v1" },
    ],
    [
      { arXiv: "https://arxiv.org/abs/hep-th/9901001v3" },
      { arXiv: "hep-th/9901001" },
    ],
  ];
  for (const [a, b] of pairs) {
    assert.equal(
      pure.sameRelatedPaper(ref(a), ref(b)),
      true,
      JSON.stringify(a),
    );
    assert.equal(pure.sameRelatedPaper(ref(b), ref(a)), true);
  }
});

test("every explicit namespace conflict vetoes shared identifiers", () => {
  for (const [namespace, left, right] of [
    ["DOI", "10.1234/a", "10.1234/b"],
    ["PMID", "111", "222"],
    ["arXiv", "2301.12345", "2301.12346"],
    ["openAlex", "W1", "W2"],
    ["s2", "aaa", "bbb"],
    ["CNKI", "record-a", "record-b"],
  ]) {
    const common =
      namespace === "DOI" ? { PMID: "999" } : { DOI: "10.1234/shared" };
    assert.equal(
      pure.sameRelatedPaper(
        ref({ ...common, [namespace]: left }),
        ref({ ...common, [namespace]: right }),
      ),
      false,
      namespace,
    );
  }
  assert.equal(
    pure.sameRelatedPaper(
      ref({ PMID: "999", DOI: "invalid" }),
      ref({ PMID: "999", DOI: "10.1234/real" }),
    ),
    false,
  );
});

test("same title never filters distinct/no-ID papers and IDs stay namespaced", () => {
  const longTitle =
    "This exactly equal sufficiently long title still cannot establish identity";
  assert.equal(
    pure.sameRelatedPaper(ref({}, longTitle), ref({}, longTitle)),
    false,
  );
  assert.equal(
    pure.sameRelatedPaper(ref({ DOI: "10.1234/a" }), ref({ DOI: "10.1234/b" })),
    false,
  );
  assert.equal(
    pure.sameRelatedPaper(ref({ PMID: "123" }), ref({ s2: "123" })),
    false,
  );
  assert.equal(
    pure.sameRelatedPaper(ref({ DOI: "unknown" }), ref({ DOI: "unknown" })),
    false,
  );
  const result = pure.fuseRelated([
    snapshot("semanticscholar", [ref(), ref()]),
  ]);
  assert.equal(result.items.length, 2);
});

test("RRF uses original ranks and one vote per source, never citation counts", () => {
  const a = ref({ DOI: "10.1234/a" }, "A", {
    source: "semanticscholar",
    citationCount: 0,
  });
  const b = ref({ DOI: "10.1234/b" }, "B", { citationCount: 900000 });
  const result = pure.fuseRelated([
    snapshot("semanticscholar", [a, a, b]),
    snapshot("openalex", [
      pure.withRelatedRank(
        ref({ DOI: "10.1234/a", openAlex: "W1" }, "OA title", {
          source: "openalex",
        }),
        4,
      ),
    ]),
  ]);
  assert.equal(result.items.length, 2);
  assert.deepEqual(plain(result.items[0].evidence), [
    { source: "semanticscholar", rank: 1 },
    { source: "openalex", rank: 4 },
  ]);
  assert.equal(result.items[0].score, 1 / 61 + 1 / 64);
  assert.equal(result.items[1].score, 1 / 63);
  assert.equal(result.items[0].ref.title, "A");
  assert.equal(result.items[0].ref.source, "semanticscholar");
  assert.equal(result.items[0].ref.identifiers.openAlex, "W1");
  assert.equal(Object.getOwnPropertySymbols(result.items[0].ref).length, 0);
  assert.equal(result.items[0].ref.number, undefined);
});

test("fusion has fixed source ties and retains the entire bounded pool", () => {
  const s2 = snapshot(
    "semanticscholar",
    Array.from({ length: 60 }, (_, i) => ref({ s2: `s${i}` })),
  );
  const oa = snapshot(
    "openalex",
    Array.from({ length: 60 }, (_, i) => ref({ openAlex: `W${i}` })),
  );
  assert.deepEqual(
    plain(pure.fuseRelated([s2, oa])),
    plain(pure.fuseRelated([oa, s2])),
  );
  const result = pure.fuseRelated([oa, s2], 400);
  assert.equal(result.items.length, 80);
  assert.deepEqual(
    plain(result.sources.map((source) => source.count)),
    [40, 40],
  );
  assert.equal(result.items[0].evidence[0].source, "semanticscholar");
  assert.equal(result.items[1].evidence[0].source, "openalex");
});

test("conflicting records and ambiguous identifier bridges are preserved", () => {
  const result = pure.fuseRelated([
    snapshot("semanticscholar", [
      ref({ DOI: "10.1234/a" }),
      ref({ PMID: "123" }),
    ]),
    snapshot("openalex", [
      ref({ DOI: "10.1234/a", PMID: "123" }),
      ref({ DOI: "10.1234/b", PMID: "123" }),
    ]),
  ]);
  assert.equal(result.items.length, 3);
  assert.ok(result.items.every((candidate) => candidate.evidence.length <= 2));
  const conflict = pure.fuseRelated([
    snapshot("semanticscholar", [ref({ DOI: "10.1234/a", PMID: "1" })]),
    snapshot("openalex", [ref({ DOI: "10.1234/b", PMID: "1" })]),
  ]);
  assert.equal(conflict.items.length, 2);
  assert.equal(conflict.items[0].ref.identifiers.DOI, "10.1234/a");
});

test("snapshot and fused refs deeply isolate input metadata", () => {
  const original = ref({ DOI: "10.1234/a" }, "Original", {
    tags: [{ text: "tag" }],
    firstAuthors: ["First"],
    correspondingAuthors: ["Last"],
    references: [ref({ PMID: "3" })],
  });
  const before = plain(original);
  const refs = pure.snapshotRelatedRefs([original]);
  const result = pure.fuseRelated([snapshot("semanticscholar", refs)]);
  const changed = result.items[0].ref;
  changed.authors[0] = "Changed";
  changed.identifiers.PMID = "2";
  changed.tags[0].text = "changed";
  changed.firstAuthors[0] = "changed";
  changed.correspondingAuthors[0] = "changed";
  changed.references[0].authors[0] = "changed";
  assert.deepEqual(plain(original), before);
  assert.deepEqual(
    plain(pure.fuseRelated([snapshot("semanticscholar", refs)]).items[0].ref),
    before,
  );
  original.title = "later input change";
  assert.equal(refs[0].title, "Original");
});

test("both sources start concurrently; either arrival order yields identical final/progress", async () => {
  const run = async (first) => {
    const pending = { semanticscholar: defer(), openalex: defer() };
    const started = [];
    const providers = Object.fromEntries(
      Object.entries(pending).map(([key, task]) => [
        key,
        (ids, limit) => {
          started.push([key, limit]);
          return task.promise;
        },
      ]),
    );
    const api = await load({ providers });
    const progress = [];
    const job = api.getRelatedByAPI({ DOI: "10.1234/host" }, 999, (value) =>
      progress.push(plain(value)),
    );
    assert.deepEqual(started, [
      ["semanticscholar", 40],
      ["openalex", 40],
    ]);
    const rows = {
      semanticscholar: [ref({ DOI: "10.1234/a" })],
      openalex: [
        ref({ DOI: "10.1234/a", openAlex: "W1" }),
        ref({ openAlex: "W2" }),
      ],
    };
    pending[first].resolve(rows[first]);
    await flush();
    assert.equal(progress.length, 2);
    assert.equal(progress[1].complete, false);
    assert.ok(progress[1].items.length > 0);
    const last = first === "openalex" ? "semanticscholar" : "openalex";
    pending[last].resolve(rows[last]);
    const result = plain(await job);
    assert.equal(result.complete, true);
    assert.deepEqual(progress.at(-1), result);
    return result;
  };
  assert.deepEqual(await run("openalex"), await run("semanticscholar"));
});

test("progress consumers cannot mutate the final result or settled snapshot", async () => {
  const second = defer();
  const input = ref({ DOI: "10.1234/a" }, "Clean");
  const api = await load({
    providers: {
      semanticscholar: async () => [input],
      openalex: () => second.promise,
    },
  });
  const job = api.getRelatedByAPI({}, 40, (result) => {
    if (result.items.length && !result.complete) {
      result.items[0].ref.title = "corrupt";
      result.items[0].ref.identifiers.DOI = "10.1234/corrupt";
      result.sources[0].status = "unavailable";
      input.title = "changed source object";
    }
  });
  await flush();
  second.resolve([]);
  const result = await job;
  assert.equal(result.items[0].ref.title, "Clean");
  assert.equal(result.items[0].ref.identifiers.DOI, "10.1234/a");
  assert.equal(result.sources[0].status, "ready");
});

test("empty, unavailable, partial failure and callback failure stay distinct", async () => {
  for (const [s2, oa, statuses] of [
    [[], [], ["ready", "ready"]],
    [null, null, ["unavailable", "unavailable"]],
    [[], null, ["ready", "unavailable"]],
  ]) {
    const api = await load({
      providers: { semanticscholar: async () => s2, openalex: async () => oa },
    });
    const result = await api.getRelatedByAPI({});
    assert.deepEqual(
      plain(result.sources.map((source) => source.status)),
      statuses,
    );
    assert.equal(result.complete, true);
    assert.equal(result.items.length, 0);
  }
  const api = await load({
    providers: {
      semanticscholar: async () => {
        throw new Error("offline");
      },
      openalex: async () => [ref({ openAlex: "W1" })],
    },
  });
  const result = await api.getRelatedByAPI({}, 40, () => {
    throw new Error("detached UI");
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(plain(result.sources.map((source) => source.status)), [
    "unavailable",
    "ready",
  ]);
});

test("cancellation prevents provider start and suppresses late state/progress", async () => {
  let starts = 0;
  const pending = defer();
  const api = await load({
    providers: {
      semanticscholar: () => {
        starts++;
        return pending.promise;
      },
      openalex: () => {
        starts++;
        return pending.promise;
      },
    },
  });
  const progress = [];
  const cancelled = await api.getRelatedByAPI(
    {},
    40,
    (v) => progress.push(v),
    () => false,
  );
  assert.equal(starts, 0);
  assert.equal(progress.length, 0);
  assert.equal(cancelled.complete, false);
  let active = true;
  const job = api.getRelatedByAPI(
    {},
    40,
    (v) => progress.push(v),
    () => active,
  );
  assert.equal(starts, 2);
  active = false;
  pending.resolve([ref({ PMID: "1" })]);
  const result = await job;
  assert.equal(progress.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.items.length, 0);
  assert.ok(result.sources.every((source) => source.status === "loading"));
});

test("S2 distinguishes valid empty/malformed responses and caps URL/list at 40", async () => {
  let response = { recommendedPapers: [] };
  const urls = [];
  const api = await load({
    http: async (url) => {
      urls.push(new URL(url));
      return response;
    },
  });
  assert.equal((await api.semanticscholar.getRelated({ PMID: "1" })).length, 0);
  for (response of [null, {}, { recommendedPapers: null }])
    assert.equal(await api.semanticscholar.getRelated({ PMID: "1" }), null);
  response = { recommendedPapers: [null, {}, { authors: "malformed" }] };
  assert.equal(await api.semanticscholar.getRelated({ PMID: "1" }), null);
  response = {
    recommendedPapers: Array.from({ length: 70 }, (_, i) => ({
      paperId: `s${i}`,
      title: `Paper ${i}`,
      authors: [],
    })),
  };
  assert.equal(
    (await api.semanticscholar.getRelated({ PMID: "1" }, 999)).length,
    40,
  );
  assert.equal(urls.at(-1).searchParams.get("limit"), "40");
  response = {
    recommendedPapers: [
      null,
      { paperId: "s1", title: "Second", authors: [] },
      { paperId: "s1", title: "Duplicate", authors: [] },
      { title: "No identity", authors: [] },
    ],
  };
  const rows = await api.semanticscholar.getRelated({ PMID: "1" });
  const fused = api.fuseRelated([snapshot("semanticscholar", rows)]);
  assert.deepEqual(
    plain(fused.items.map((candidate) => candidate.evidence[0].rank)),
    [2, 4],
  );
});

const work = (id) => ({
  id: `https://openalex.org/${id}`,
  title: `Paper ${id}`,
  authorships: [],
  ids: {},
});
test("OA preserves raw ordering, gaps and duplicates despite unordered hydration", async () => {
  const urls = [];
  const api = await load({
    http: async (url) => {
      urls.push(new URL(url));
      return urls.length === 1
        ? {
            id: "https://openalex.org/W99",
            related_works: ["https://openalex.org/W3", null, "W1", "W2", "W3"],
          }
        : { results: [work("W2"), work("W3"), work("W404")] };
    },
  });
  const rows = await api.openalex.getRelated({ openAlex: "W99" });
  assert.equal(urls[0].pathname, "/works/W99");
  assert.equal(urls[0].searchParams.get("select"), "id,related_works");
  assert.deepEqual(plain(rows.map((row) => row.identifiers.openAlex)), [
    "W3",
    "W2",
    "W3",
  ]);
  const fused = api.fuseRelated([snapshot("openalex", rows)]);
  assert.deepEqual(
    plain(fused.items.map((candidate) => candidate.evidence[0].rank)),
    [1, 4],
  );
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.has("sort"), false);
  assert.equal(urls[1].searchParams.get("filter"), "openalex_id:W3|W1|W2");
});

test("OA distinguishes missing host/batch from valid empty and bounds batch", async () => {
  const cases = [
    [null, null],
    [{ id: "W9" }, null],
    [{ id: "W9", related_works: [] }, []],
    [{ id: "W9", related_works: ["W1"] }, null, null],
    [{ id: "W9", related_works: ["W1"] }, {}, null],
    [{ id: "W9", related_works: ["W1"] }, { results: [] }, null],
    [
      { id: "W9", related_works: ["W1"] },
      { results: [null, { id: "W1", doi: 123 }] },
      null,
    ],
  ];
  for (const entry of cases) {
    let requests = 0;
    const api = await load({ http: async () => entry[requests++] });
    const result = await api.openalex.getRelated({ PMID: "1" });
    assert.deepEqual(plain(result), entry.at(-1));
  }
  const urls = [];
  const api = await load({
    http: async (url) => {
      urls.push(new URL(url));
      return urls.length === 1
        ? {
            id: "W99",
            related_works: Array.from({ length: 70 }, (_, i) => `W${i}`),
          }
        : { results: Array.from({ length: 70 }, (_, i) => work(`W${i}`)) };
    },
  });
  assert.equal((await api.openalex.getRelated({ PMID: "1" }, 999)).length, 40);
  assert.equal(urls[1].searchParams.get("per-page"), "40");
  assert.equal(urls[1].searchParams.get("filter").split("|").length, 40);
});

test("OA cancellation after host fetch prevents hydration, after batch discards results", async () => {
  for (const cancelAt of [1, 2]) {
    let requests = 0;
    let active = true;
    const api = await load({
      http: async () => {
        requests++;
        if (requests === cancelAt) active = false;
        return requests === 1
          ? { id: "W99", related_works: ["W1"] }
          : { results: [work("W1")] };
      },
    });
    assert.equal(
      await api.openalex.getRelated({ openAlex: "W99" }, 40, () => active),
      null,
    );
    assert.equal(requests, cancelAt);
  }
});

test("registry propagates cancellation to real OA two-stage fetch", async () => {
  const host = defer();
  let active = true;
  let batches = 0;
  const progress = [];
  const api = await load({
    http: async (url) => {
      if (url.includes("recommendations")) return { recommendedPapers: [] };
      if (url.includes("filter=")) {
        batches++;
        return { results: [] };
      }
      return host.promise;
    },
  });
  const job = api.getRelatedByAPI(
    { openAlex: "W99", PMID: "1" },
    40,
    (result) => progress.push(plain(result)),
    () => active,
  );
  await flush();
  const before = progress.length;
  active = false;
  host.resolve({ id: "W99", related_works: ["W1"] });
  const result = await job;
  assert.equal(batches, 0);
  assert.equal(progress.length, before);
  assert.equal(result.complete, false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} related regressions passed`,
);
if (failed) process.exitCode = 1;
