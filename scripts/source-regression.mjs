import console from "node:console";
import process from "node:process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

// Synthetic fixtures against the bundled production modules. No network,
// Zotero profile or library is accessed.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function load(file, zotero = {}, stubs = {}, globals = {}) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  const compiled = await build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(path.join(root, file)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
    plugins: [
      {
        name: "source-regression-stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(stubs, args.path)) {
              return { path: args.path, namespace: "fixture" };
            }
          });
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
    Zotero: {
      Prefs: { get: () => undefined },
      Libraries: { userLibraryID: 1 },
      Promise: { delay: async () => {} },
      ...zotero,
    },
    addon: { data: {} },
    ztoolkit: { log: () => {} },
    ...globals,
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return context.module.exports;
}

async function sourceFixture(pageAt) {
  const requests = [];
  const { semanticscholar } = await load("src/sources/semanticscholar.ts", {
    Prefs: {
      get: (key) => {
        if (key.endsWith("cacheTTLHours")) return 168;
        if (key.endsWith("s2ApiKey")) return "fixture-api-key";
      },
    },
    HTTP: {
      request: async (method, url, options) => {
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get("offset") || 0);
        requests.push({ method, offset, url: parsed, options });
        const response = await pageAt(offset, requests.length);
        return response === null
          ? { status: 404, response: null }
          : { status: 200, response };
      },
    },
  });
  return {
    requests,
    references: (ids = { s2: "fixture-origin" }) =>
      semanticscholar.getReferences(ids),
  };
}

const paper = (id, overrides = {}) => ({
  citedPaper: {
    paperId: `paper-${id}`,
    title: `Fixture paper ${id}`,
    authors: [],
    year: 2024,
    ...overrides,
  },
});

test("S2 fetches references beyond the first 1,000 and reuses every cached page", async () => {
  const fixture = await sourceFixture((offset) =>
    offset === 0
      ? { data: Array.from({ length: 1000 }, (_, i) => paper(i)), next: 1000 }
      : { data: [paper(1000)] },
  );
  const refs = await fixture.references();
  assert.equal(refs.length, 1001);
  assert.equal(refs[1000].identifiers.s2, "paper-1000");
  assert.equal(refs[1000].number, 1001);
  assert.deepEqual(
    fixture.requests.map((r) => r.offset),
    [0, 1000],
  );
  for (const request of fixture.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.url.searchParams.get("limit"), "1000");
    assert.equal(request.options.headers["x-api-key"], "fixture-api-key");
  }
  assert.equal((await fixture.references()).length, 1001);
  assert.equal(fixture.requests.length, 2, "Second lookup must use HTTP cache");
});

test("S2 follows the supplied next offset and removes overlapping identifiers", async () => {
  const fixture = await sourceFixture((offset) =>
    offset === 0
      ? {
          data: [paper(1, { externalIds: { DOI: "10.1234/ABC" } }), paper(2)],
          next: 2,
        }
      : {
          data: [
            paper(2),
            paper(99, { externalIds: { DOI: "10.1234/abc" } }),
            { ...paper(3), contexts: ["Cited here"], intents: ["methodology"] },
          ],
        },
  );
  const refs = await fixture.references();
  assert.deepEqual(
    Array.from(refs, (r) => r.identifiers.s2),
    ["paper-1", "paper-2", "paper-3"],
  );
  assert.deepEqual(
    Array.from(refs, (r) => r.number),
    [1, 2, 3],
  );
  assert.equal(refs[2].description, "methodology: Cited here");
  assert.deepEqual(
    fixture.requests.map((r) => r.offset),
    [0, 2],
  );
});

test("S2 preserves distinct same-title papers and deduplicates unidentified repeats", async () => {
  const unidentified = paper("none", { paperId: null });
  const fixture = await sourceFixture(() => ({
    data: [
      paper(1, { title: "Shared title" }),
      paper(2, { title: "Shared title" }),
      unidentified,
      unidentified,
      { citedPaper: null },
      paper("blank", { paperId: null, title: null }),
    ],
  }));
  const refs = await fixture.references();
  assert.equal(refs.length, 3);
  assert.deepEqual(
    Array.from(refs, (r) => r.number),
    [1, 2, 3],
  );
});

test("S2 stops when the endpoint repeats an offset", async () => {
  const fixture = await sourceFixture((offset) => ({
    data: [paper(offset)],
    next: 1000,
  }));
  assert.equal((await fixture.references()).length, 2);
  assert.deepEqual(
    fixture.requests.map((r) => r.offset),
    [0, 1000],
  );
});

test("S2 stops when a later page repeats all prior results despite advancing next", async () => {
  const fixture = await sourceFixture((offset) => ({
    data: [paper(1)],
    next: offset + 1000,
  }));
  assert.equal((await fixture.references()).length, 1);
  assert.equal(fixture.requests.length, 2);
});

test("S2 rejects invalid next offsets without making another request", async () => {
  for (const next of [-1, 0, 1.5, "1000", Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = await sourceFixture(() => ({ data: [paper(1)], next }));
    assert.equal((await fixture.references()).length, 1);
    assert.equal(fixture.requests.length, 1, `Invalid cursor: ${next}`);
  }
});

test("S2 bounds pagination even when every page advances", async () => {
  const fixture = await sourceFixture((offset) => ({
    data: [paper(offset)],
    next: offset + 1000,
  }));
  const refs = await fixture.references();
  assert.equal(fixture.requests.length, 20);
  assert.equal(refs.length, 20);
  assert.equal(refs.at(-1).identifiers.s2, "paper-19000");
});

test("S2 keeps earlier references when a later page is unavailable or malformed", async () => {
  for (const missing of [null, { data: {} }, { data: [], next: 2000 }]) {
    const fixture = await sourceFixture((offset) =>
      offset === 0 ? { data: [paper(1)], next: 1000 } : missing,
    );
    assert.equal((await fixture.references()).length, 1);
    assert.equal(fixture.requests.length, 2);
  }
});

test("S2 missing identifiers and empty first pages return null", async () => {
  const fixture = await sourceFixture(() => ({ data: [] }));
  assert.equal(await fixture.references({}), null);
  assert.equal(fixture.requests.length, 0);
  assert.equal(await fixture.references(), null);
  assert.equal(fixture.requests.length, 1);
});

async function mappedAbstract(source, abstract) {
  const title = "A study of structured abstracts";
  const data = {
    crossref: {
      message: {
        DOI: "10.9999/abstract-fixture",
        title: [title],
        abstract,
        published: { "date-parts": [[2024, 1, 2]] },
      },
    },
    readpaper: { data: { list: [{ title, summary: abstract, year: 2024 }] } },
    connectedpapers: {
      results: [
        {
          title: { text: title },
          paperAbstract: { text: abstract },
          year: { text: "2024" },
        },
      ],
    },
  };
  const requests = [];
  const module = await load(`src/sources/${source}.ts`, {
    HTTP: {
      request: async (method, url) => {
        requests.push({ method, url });
        return { status: 200, response: data[source] };
      },
    },
  });
  const result =
    source === "crossref"
      ? await module.crossref.getInfoByDOI("10.9999/abstract-fixture")
      : await module[source].getInfoByTitle(title);
  assert.equal(requests.length, 1);
  assert.equal(result.title, title);
  assert.equal(result.year, "2024");
  return result.abstract;
}

test("Crossref JATS abstracts preserve section titles and complete paragraphs", async () => {
  const abstract = `<jats:abstract xmlns:jats="http://www.ncbi.nlm.nih.gov/JATS1">
    <jats:sec><jats:title>Background</jats:title><jats:p>First background paragraph.</jats:p>
    <jats:p>A second paragraph with <jats:italic>emphasis</jats:italic>.</jats:p></jats:sec>
    <jats:sec><jats:title>Methods</jats:title><jats:p>We enrolled 120 participants.</jats:p></jats:sec>
    <jats:sec><jats:title>Results</jats:title><jats:p>The response rate was 75%.</jats:p></jats:sec>
    <jats:sec><jats:title>Conclusions</jats:title><jats:p>Further validation is needed.</jats:p></jats:sec>
    </jats:abstract>`;
  assert.equal(
    await mappedAbstract("crossref", abstract),
    "Background\n\nFirst background paragraph.\n\nA second paragraph with emphasis.\n\nMethods\n\nWe enrolled 120 participants.\n\nResults\n\nThe response rate was 75%.\n\nConclusions\n\nFurther validation is needed.",
  );
});

test("ReadPaper HTML abstracts preserve headings and paragraph boundaries", async () => {
  assert.equal(
    await mappedAbstract(
      "readpaper",
      '<div><h3>Background</h3><p class="summary">An <b>important</b> question.</p><h3>Methods</h3><p>A prospective study.</p><h3>Results</h3><p>Response improved.</p><h3>Conclusions</h3><p>Follow-up is ongoing.</p></div>',
    ),
    "Background\n\nAn important question.\n\nMethods\n\nA prospective study.\n\nResults\n\nResponse improved.\n\nConclusions\n\nFollow-up is ongoing.",
  );
});

test("Connected Papers abstracts retain HTML and existing plain-text paragraph boundaries", async () => {
  const expected =
    "Background: The clinical question.\n\nMethods: A cohort study.\n\nResults: Response improved.\n\nConclusions: Longer follow-up is needed.";
  for (const input of [
    "<p>Background: The clinical question.</p><p>Methods: A cohort study.</p><p>Results: Response improved.</p><p>Conclusions: Longer follow-up is needed.</p>",
    expected,
  ]) {
    assert.equal(await mappedAbstract("connectedpapers", input), expected);
  }
});

test("Abstract source mappers preserve comparisons and decode encoded text only once", async () => {
  const input =
    "<p>Results: P&lt;0.001 and response &gt;90%; A&lt;B and C&gt;D.</p><p>&lt;em&gt;Literal&lt;/em&gt; and &amp;lt;0.05.</p>";
  for (const source of ["crossref", "readpaper", "connectedpapers"]) {
    assert.equal(
      await mappedAbstract(source, input),
      "Results: P<0.001 and response >90%; A<B and C>D.\n\n<em>Literal</em> and &lt;0.05.",
      source,
    );
  }
});

test("Abstract source mappers leave missing, empty and non-text abstracts undefined", async () => {
  for (const source of ["crossref", "readpaper", "connectedpapers"]) {
    for (const input of [undefined, null, "", "  \n\t", "<p> </p>", {}]) {
      assert.equal(await mappedAbstract(source, input), undefined, source);
    }
  }
});

const chineseTitle = "非小细胞肺癌患者围术期免疫治疗临床研究进展";
const chineseRef = (identifiers = {}) => ({
  title: chineseTitle,
  text: `张三. ${chineseTitle}. 2020.`,
  authors: ["张三"],
  year: "2020",
  identifiers,
});
const hostItem = { libraryID: 7, getCollections: () => [23] };

async function importerFixture(overrides = {}) {
  const calls = { identifiers: [], options: [], metadata: 0, cnki: 0, doi: 0 };
  const mocks = {
    search: async () => {
      calls.cnki++;
      return null;
    },
    cnkiInfo: async () => null,
    cnkiImport: async () => null,
    resolveDOI: async () => {
      calls.doi++;
      return null;
    },
    translated: { id: 123 },
    ...overrides,
  };
  const { importReference } = await load(
    "src/core/importer.ts",
    {
      Translate: {
        Search: class {
          setIdentifier(ids) {
            calls.identifiers.push({ ...ids });
          }
          async getTranslators() {
            return ["fixture-translator"];
          }
          setTranslator() {}
          async translate(options) {
            calls.options.push({ ...options });
            return mocks.translated ? [mocks.translated] : [];
          }
        },
      },
      Item: class {
        constructor() {
          calls.metadata++;
          throw new Error("Unexpected metadata-only import");
        }
      },
    },
    {
      "./libmatch":
        "export const libraryIndex={match:async()=>undefined}; export const isRelated=()=>false;",
      "../utils/locale": "export const getString=(key)=>key;",
      "../sources":
        "export const sources={cnki:{getInfoByTitle:(...args)=>mocks.cnkiInfo(...args)}}; export const resolveDOIByTitle=(...args)=>mocks.resolveDOI(...args);",
      "../sources/cnki":
        "export const searchCNKI=(...args)=>mocks.search(...args); export const importCNKIItem=(...args)=>mocks.cnkiImport(...args);",
    },
    { mocks },
  );
  return { calls, importReference };
}

test("Chinese CNKI misses still import existing DOI, PMID and arXiv identifiers", async () => {
  for (const ids of [
    { DOI: "10.9999/valid-chinese-article" },
    { PMID: "12345678" },
    { arXiv: "2401.12345" },
  ]) {
    const { calls, importReference } = await importerFixture();
    assert.equal((await importReference(hostItem, chineseRef(ids))).id, 123);
    assert.equal(calls.cnki, 1, "Fixture must reach the Chinese CNKI path");
    assert.deepEqual(calls.identifiers, [ids]);
    assert.equal(calls.options[0].libraryID, 7);
    assert.deepEqual(calls.options[0].collections, [23]);
    assert.equal(calls.options[0].saveAttachments, true);
    assert.equal(calls.metadata, 0);
  }
});

test("Chinese no-identifier misses and failed translators do not create weak metadata items", async () => {
  const empty = await importerFixture();
  assert.equal(await empty.importReference(hostItem, chineseRef()), null);
  assert.equal(empty.calls.cnki, 1);
  assert.equal(empty.calls.identifiers.length, 0);
  assert.equal(empty.calls.metadata, 0);
  assert.equal(empty.calls.doi, 0);

  const failed = await importerFixture({ translated: null });
  assert.equal(
    await failed.importReference(
      hostItem,
      chineseRef({ DOI: "10.9999/missing" }),
    ),
    null,
  );
  assert.equal(failed.calls.identifiers.length, 1);
  assert.equal(failed.calls.metadata, 0);
});

test("A successful exact-title CNKI translator remains preferred", async () => {
  const imported = { id: 456 };
  const { calls, importReference } = await importerFixture({
    search: async () => [
      { title: chineseTitle, url: "https://cnki.test/work" },
    ],
    cnkiImport: async () => imported,
  });
  assert.equal(
    await importReference(hostItem, chineseRef({ DOI: "10.9999/cnki" })),
    imported,
  );
  assert.equal(calls.identifiers.length, 0);
  assert.equal(calls.metadata, 0);
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
  `${tests.length - failed}/${tests.length} source regressions passed`,
);
if (failed) process.exitCode = 1;
