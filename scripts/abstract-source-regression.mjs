import assert from "node:assert/strict";
import console from "node:console";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { DOMParser } from "@xmldom/xmldom";

// Actual bundled source, HTTP fixtures only. Never accesses a Zotero library.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const compiled = await build({
  entryPoints: [path.join(root, "src/sources/abstract.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
  plugins: [
    {
      name: "abstract-source-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/core\/http$/ }, () => ({
          path: "http",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const http = globalThis.testHTTP;",
          loader: "js",
        }));
      },
    },
  ],
});
const tests = [];
const test = (name, run) => tests.push([name, run]);
const title = "Synthetic long abstract retrieval and identity validation study";
const text =
  "A sufficiently detailed synthetic abstract describes the methods, results and conclusions without any private source data.";
const ref = (identifiers = { DOI: "10.5555/fixture" }, extra = {}) => ({
  identifiers,
  title,
  year: "2024",
  authors: ["Fixture A"],
  ...extra,
});
const row = (extra = {}) => ({
  source: "MED",
  id: "11111111",
  doi: "10.5555/fixture",
  title,
  pubYear: "2024",
  authorList: { author: [{ lastName: "Fixture" }] },
  abstractText: text,
  ...extra,
});
const response = (...rows) => ({
  hitCount: rows.length,
  resultList: { result: rows },
});
const noIDs = { esearchresult: { idlist: [], count: "0" } };
const xml = (pmid = "11111111", doi = "10.5555/fixture", abstract = text) =>
  `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ELocationID EIdType="doi">${doi}</ELocationID>${abstract === null ? "" : `<Abstract><AbstractText>${abstract}</AbstractText></Abstract>`}</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
const crossref = (doi, extra = {}) => ({
  message: {
    DOI: doi,
    publisher: "Fixture Publisher",
    title: [title],
    author: [{ family: "Fixture" }],
    "published-print": { "date-parts": [[2024]] },
    "alternative-id": ["S0025619611607350"],
    link: [
      {
        URL: "https://api.elsevier.com/content/article/PII:S0025619611607350?httpAccept=text/xml",
      },
    ],
    ...extra,
  },
});

function fixture(handler, initialTime = 1_000_000) {
  let now = initialTime;
  const requests = [];
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    console,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    ztoolkit: {
      log: () => {},
      getDOMParser: () =>
        new DOMParser({
          onError: () => {
            throw new Error("Invalid XML fixture");
          },
        }),
    },
    testHTTP: Object.fromEntries(
      ["getJSON", "getText"].map((method) => [
        method,
        async (url, options) => {
          const request = { url: new URL(url), options, method };
          requests.push(request);
          return handler(request, requests.length);
        },
      ]),
    ),
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return {
    ...context.module.exports,
    requests,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("DOI-only enrichment normalizes once, names the source and reuses a cloned cache result", async () => {
  const f = fixture(() =>
    response(
      row({
        abstractText: `<p>BACKGROUND: ${text}</p><p>RESULTS: H<sub>2</sub>O and 10<sup>−3</sup>; A &lt;threshold&gt; &amp;amp; B.</p>`,
      }),
    ),
  );
  const input = ref({ DOI: " https://doi.org/10.5555/FIXTURE " });
  const result = await f.fetchAbstract(input);
  assert.equal(result.source, "europepmc");
  assert.equal(result.identifiers.PMID, "11111111");
  assert.match(result.abstract, /H₂O and 10⁻³; A <threshold> &amp; B/);
  assert.equal(f.requests[0].url.searchParams.get("resultType"), "core");
  assert.equal(
    f.requests[0].url.searchParams.get("query"),
    'DOI:"10.5555/fixture"',
  );
  assert.equal(f.requests[0].options.noCache, true);
  assert.equal(f.requests[0].options.retries, 0);
  result.abstract = "mutated";
  result.identifiers.DOI = "10.5555/evil";
  assert.equal(f.cachedAbstract(input).identifiers.DOI, "10.5555/fixture");
  assert.notEqual((await f.fetchAbstract(input)).abstract, "mutated");
  assert.equal(f.requests.length, 1);
});

test("PMID-only lookup uses exact primary source identity", async () => {
  const f = fixture(() => response(row()));
  assert.equal(
    (await f.fetchAbstract(ref({ PMID: "11111111" }))).abstract,
    text,
  );
  assert.equal(
    f.requests[0].url.searchParams.get("query"),
    "EXT_ID:11111111 AND SRC:MED",
  );
});

test("Europe PMC enriches full byline names and retains collective authors", async () => {
  const f = fixture(() =>
    response(
      row({
        authorList: {
          author: [
            {
              firstName: "Alice B",
              lastName: "Fixture",
              fullName: "Fixture AB",
            },
            { fullName: "Study Consortium" },
            { firstName: "Charles", lastName: "Last" },
          ],
        },
      }),
    ),
  );
  const result = await f.fetchAbstract(ref());
  assert.deepEqual(Array.from(result.authors), [
    "Alice B Fixture",
    "Study Consortium",
    "Charles Last",
  ]);
});

test("incomplete source bylines never shift first and last author positions", async () => {
  for (const extra of [
    { authorString: "Fixture A, et al." },
    {
      authorList: {
        author: [
          { firstName: "Alice", lastName: "Fixture" },
          {},
          { fullName: "Last" },
        ],
      },
    },
  ]) {
    const f = fixture(() => response(row(extra)));
    assert.equal((await f.fetchAbstract(ref())).authors.length, 0);
  }
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk"
      ? response()
      : xml().replace(
          "<Article>",
          '<Article><AuthorList CompleteYN="N"><Author><LastName>Fixture</LastName><ForeName>Alice</ForeName></Author></AuthorList>',
        ),
  );
  assert.equal(
    (await f.fetchAbstract(ref({ PMID: "11111111" }))).authors.length,
    0,
  );
});

test("inflight requests are shared across hover instances", async () => {
  let done;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const a = f.fetchAbstract(ref());
  const b = f.fetchAbstract(ref());
  assert.equal(f.requests.length, 1);
  done(response(row()));
  const [left, right] = await Promise.all([a, b]);
  assert.equal(left.abstract, text);
  assert.equal(right.abstract, text);
  assert.notEqual(left, right);
});

test("contradictory DOI and PMID never consume a cached or returned abstract", async () => {
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk" ? response(row()) : xml(),
  );
  await f.fetchAbstract(ref());
  const wrong = ref(
    { DOI: "10.5555/fixture", PMID: "22222222" },
    { title: undefined },
  );
  assert.equal(f.cachedAbstract(wrong), null);
  assert.equal(await f.fetchAbstract(wrong), null);
});

test("wrong primary DOI is rejected even when EPMC returns the requested PMID", async () => {
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk"
      ? response(row({ doi: "10.5555/wrong" }))
      : xml("11111111", "10.5555/wrong"),
  );
  assert.equal(
    await f.fetchAbstract(
      ref({ DOI: "10.5555/fixture", PMID: "11111111" }, { title: undefined }),
    ),
    null,
  );
});

test("DOI-only PubMed fallback resolves PMID and verifies DOI in the primary XML record", async () => {
  const f = fixture(({ url }) => {
    if (url.hostname === "www.ebi.ac.uk") return response();
    if (url.pathname.endsWith("esearch.fcgi"))
      return { esearchresult: { idlist: ["11111111"], count: "1" } };
    return xml();
  });
  const result = await f.fetchAbstract(ref());
  assert.equal(result.source, "pubmed");
  assert.equal(result.abstract, text);
  assert.equal(f.requests.length, 3);
  assert.equal(
    f.requests[1].url.searchParams.get("term"),
    '"10.5555/fixture"[AID]',
  );
});

test("PubMed never verifies an expected DOI against an explicitly invalid ELocationID", async () => {
  const raw = xml().replace(
    '<ELocationID EIdType="doi">10.5555/fixture</ELocationID>',
    '<ELocationID EIdType="doi" ValidYN="N">10.5555/invalid-a</ELocationID><ELocationID EIdType="doi" ValidYN="Y">10.5555/valid-b</ELocationID>',
  );
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk" ? response() : raw,
  );
  assert.equal(
    await f.fetchAbstract(
      ref({ DOI: "10.5555/invalid-a", PMID: "11111111" }, { title: undefined }),
    ),
    null,
  );
  const result = await f.fetchAbstract(
    ref({ DOI: "10.5555/valid-b", PMID: "11111111" }, { title: undefined }),
  );
  assert.equal(result.identifiers.DOI, "10.5555/valid-b");
  assert.equal(result.abstract, text);
});

test("PubMed PMID-only enrichment skips invalid DOI A and chooses valid DOI B", async () => {
  const raw = xml().replace(
    '<ELocationID EIdType="doi">10.5555/fixture</ELocationID>',
    '<ELocationID EIdType="doi" ValidYN="N">10.5555/invalid-a</ELocationID><ELocationID EIdType="doi">10.5555/valid-b</ELocationID>',
  );
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk" ? response() : raw,
  );
  const result = await f.fetchAbstract(
    ref({ PMID: "11111111" }, { title: undefined }),
  );
  assert.equal(result.identifiers.DOI, "10.5555/valid-b");
  assert.equal(result.abstract, text);
});

test("PubMed fallback preserves scientific notation, section labels and escaped literal content", async () => {
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk"
      ? response(row({ abstractText: undefined }))
      : xml(
          "11111111",
          "10.5555/fixture",
          `<p>${text}</p>H<sub>2</sub>O, 10<sup>−3</sup>, x<sup><i>n</i>+1</sup>, &lt;i&gt; and &amp;amp;.`,
        ),
  );
  const result = await f.fetchAbstract(ref());
  assert.equal(result.source, "pubmed");
  assert.match(result.abstract, /H₂O, 10⁻³, x\^\(n\+1\), <i> and &amp;/);
});

test("PubMed fallback returns verified primary title and author metadata for popup matching", async () => {
  const actual = xml().replace(
    "<Article>",
    "<Article><ArticleTitle>Verified source title</ArticleTitle><Journal><Title>Source Journal</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>Fixture</LastName><ForeName>Alice</ForeName></Author></AuthorList>",
  );
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk" ? response() : actual,
  );
  const result = await f.fetchAbstract(ref({ PMID: "11111111" }));
  assert.equal(result.title, "Verified source title");
  assert.equal(result.authors[0], "Alice Fixture");
  assert.equal(result.year, "2024");
  assert.equal(result.primaryVenue, "Source Journal");
});

test("transient failures remain retryable immediately", async () => {
  let healthy = false;
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk"
      ? healthy
        ? response(row())
        : null
      : noIDs,
  );
  assert.equal(await f.fetchAbstract(ref()), null);
  healthy = true;
  assert.equal((await f.fetchAbstract(ref())).abstract, text);
});

test("a confirmed empty abstract is cached briefly then retried", async () => {
  const f = fixture(({ url }) =>
    url.hostname === "www.ebi.ac.uk" ? response() : noIDs,
  );
  assert.equal(await f.fetchAbstract(ref()), null);
  const count = f.requests.length;
  assert.equal(await f.fetchAbstract(ref()), null);
  assert.equal(f.requests.length, count);
  f.advance(5 * 60 * 1000 + 1);
  assert.equal(await f.fetchAbstract(ref()), null);
  assert.ok(f.requests.length > count);
});

test("positive cache expires and its size is bounded", async () => {
  const f = fixture(({ url }) => {
    const doi = /DOI:"([^"]+)"/.exec(url.searchParams.get("query"))?.[1];
    return response(
      row({ doi, id: String(10_000_000 + Number(doi.split("/").at(-1))) }),
    );
  });
  for (let i = 0; i < 110; i++)
    await f.fetchAbstract(ref({ DOI: `10.5555/${i}` }));
  assert.equal(f.cachedAbstract(ref({ DOI: "10.5555/0" })), null);
  assert.ok(f.cachedAbstract(ref({ DOI: "10.5555/109" })));
  f.advance(7 * 24 * 60 * 60 * 1000 + 1);
  assert.equal(f.cachedAbstract(ref({ DOI: "10.5555/109" })), null);
});

test("rapid hovering cannot enqueue more than the bounded pending limit", async () => {
  const releases = [];
  let waiting = true;
  const f = fixture(({ url }) => {
    const doi = /DOI:"([^"]+)"/.exec(url.searchParams.get("query"))?.[1];
    const result = response(row({ doi }));
    return waiting
      ? new Promise((resolve) => releases.push(() => resolve(result)))
      : result;
  });
  const jobs = Array.from({ length: 40 }, (_, index) =>
    f.fetchAbstract(ref({ DOI: `10.5555/pending${index}` })),
  );
  assert.equal(await f.fetchAbstract(ref({ DOI: "10.5555/overflow" })), null);
  assert.equal(f.requests.length, 40);
  releases.forEach((release) => release());
  await Promise.all(jobs);
  waiting = false;
  assert.ok(await f.fetchAbstract(ref({ DOI: "10.5555/overflow" })));
});

test("safe title-only lookup requires long exact title, year and first author", async () => {
  const f = fixture(() => response(row()));
  assert.equal((await f.fetchAbstract(ref({}))).abstract, text);
  assert.equal(f.requests[0].url.searchParams.get("query"), `TITLE:"${title}"`);
  for (const extra of [
    { title: "Short" },
    { year: undefined },
    { authors: [] },
  ]) {
    const before = f.requests.length;
    assert.equal(await f.fetchAbstract(ref({}, extra)), null);
    assert.equal(f.requests.length, before);
  }
});

test("title fallback rejects a title collision, wrong year, wrong author and truncated search", async () => {
  for (const body of [
    response(row(), row({ id: "22222222", doi: "10.5555/other" })),
    response(row({ title: `Review of ${title}` })),
    response(row({ pubYear: "2023" })),
    response(row({ authorList: { author: [{ lastName: "Other" }] } })),
    { ...response(row()), hitCount: 20 },
  ]) {
    const f = fixture(() => body);
    assert.equal(await f.fetchAbstract(ref({})), null);
  }
});

function aliasFixture(changes = {}) {
  return fixture(({ url }) => {
    if (url.hostname === "www.ebi.ac.uk")
      return url.searchParams.get("query").startsWith("TITLE:")
        ? response(row({ doi: "10.5555/alias" }))
        : response();
    if (url.hostname === "api.crossref.org") {
      const doi = decodeURIComponent(url.pathname.slice("/works/".length));
      return crossref(doi, doi === "10.5555/alias" ? changes : {});
    }
    return noIDs;
  });
}

test("a publisher-verified DOI alias fills the abstract without replacing the input DOI", async () => {
  const f = aliasFixture();
  const result = await f.fetchAbstract(ref());
  assert.equal(result.abstract, text);
  assert.equal(result.identifiers.DOI, "10.5555/fixture");
  assert.equal(result.identifiers.PMID, "11111111");
  assert.equal(result.url, "https://europepmc.org/article/MED/11111111");
});

test("DOI alias rejects publisher, PII, title, year, first-author and publication-link conflicts", async () => {
  for (const changes of [
    { publisher: "Other Publisher" },
    { "alternative-id": ["S1111111111111111"] },
    { title: ["A different unrelated article"] },
    { "published-print": { "date-parts": [[2023]] } },
    { author: [{ family: "Other" }] },
    {
      link: [
        { URL: "https://evil.test/content/article/PII:S0025619611607350" },
      ],
    },
  ])
    assert.equal(await aliasFixture(changes).fetchAbstract(ref()), null);
});

test("an external DTD is inert and internal entity declarations are rejected", async () => {
  for (const [declaration, expected] of [
    [
      '<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2026//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_260101.dtd">',
      text,
    ],
    [
      '<!DOCTYPE PubmedArticleSet [<!ENTITY test SYSTEM "file:///etc/passwd">]>',
      null,
    ],
  ]) {
    const f = fixture(({ url }) =>
      url.hostname === "www.ebi.ac.uk" ? response() : declaration + xml(),
    );
    const result = await f.fetchAbstract(
      ref({ PMID: "11111111" }, { title: undefined }),
    );
    assert.equal(result?.abstract || null, expected);
  }
});

test("new fallbacks stop after the request budget and exhaustion is never cached", async () => {
  let f;
  f = fixture(() => {
    f.advance(24_001);
    return response();
  });
  assert.equal(await f.fetchAbstract(ref()), null);
  assert.equal(f.requests.length, 1);
  assert.equal(await f.fetchAbstract(ref()), null);
  assert.equal(f.requests.length, 2);
});

test("existing abstracts and unusable identifiers trigger no network request", async () => {
  const f = fixture(() => {
    throw new Error("must not fetch");
  });
  assert.equal(await f.fetchAbstract(ref({}, { title: undefined })), null);
  assert.equal(
    await f.fetchAbstract(
      ref({ DOI: "garbage", PMID: "../123" }, { title: undefined }),
    ),
    null,
  );
  assert.equal(await f.fetchAbstract(ref(undefined, { abstract: text })), null);
  assert.equal(f.requests.length, 0);
});

for (const [name, run] of tests) {
  await run();
  console.log(`ok - ${name}`);
}
console.log(`PASS: ${tests.length} abstract source regressions`);
