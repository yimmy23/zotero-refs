import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { DOMParser } from "@xmldom/xmldom";

// The actual XML parser, not mocked selectors or a regex approximation.
// All committed XML is synthetic; public live responses stay in .scaffold.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = await fs.readFile(
  path.join(root, "src/sources/pubmed.ts"),
  "utf8",
);
const compiled = await build({
  stdin: {
    contents: source,
    resolveDir: path.join(root, "src/sources"),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
  plugins: [
    {
      name: "synthetic-network",
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
const requests = [];
let summary = {};
let fetched = "";
const context = vm.createContext({
  module: { exports: {} },
  ztoolkit: {
    log: () => {},
    getDOMParser: () =>
      new DOMParser({
        onError: () => {
          throw new Error("Invalid fixture XML");
        },
      }),
  },
  testHTTP: {
    getJSON: async (url) => {
      requests.push(url);
      return summary;
    },
    getText: async (url) => {
      requests.push(url);
      return fetched;
    },
  },
});
vm.runInContext(compiled.outputFiles[0].text, context);
const { pubmed, extractAbstractRecord } = context.module.exports;
const extractAbstractText = (raw, pmid) =>
  extractAbstractRecord(raw, pmid)?.abstract;
const article = (pmid, content = "", metadata = "") =>
  `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID><Article><ArticleTitle>Do not return this title</ArticleTitle><AuthorList><Author><LastName>Fixture</LastName><AffiliationInfo><Affiliation>Do not return affiliation</Affiliation></AffiliationInfo></Author></AuthorList>${content}</Article>${metadata}</MedlineCitation></PubmedArticle>`;
const document = (...articles) =>
  `<?xml version="1.0" encoding="UTF-8"?><PubmedArticleSet>${articles.join("")}</PubmedArticleSet>`;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("only the requested article's abstract is returned", () => {
  const raw = document(
    article(
      "11111111",
      "<Abstract><AbstractText>Primary abstract.</AbstractText></Abstract>",
    ),
  );
  assert.equal(extractAbstractText(raw, "11111111"), "Primary abstract.");
});
test("an absent or empty abstract never falls back to title or affiliations", () => {
  for (const content of [
    "",
    "<Abstract/>",
    "<Abstract><AbstractText> \n </AbstractText></Abstract>",
  ]) {
    assert.equal(
      extractAbstractText(document(article("11111111", content)), "11111111"),
      undefined,
    );
  }
});
test("a batch response uses exact PMID matching rather than its first article", () => {
  const raw = document(
    article(
      "11111111",
      "<Abstract><AbstractText>Wrong abstract.</AbstractText></Abstract>",
    ),
    article(
      "22222222",
      "<Abstract><AbstractText>Right abstract.</AbstractText></Abstract>",
    ),
  );
  assert.equal(extractAbstractText(raw, "22222222"), "Right abstract.");
  assert.equal(extractAbstractText(raw, "33333333"), undefined);
  assert.equal(extractAbstractText(raw, "1111111"), undefined);
});
test("a PMID in related citations cannot impersonate the primary record", () => {
  const raw = document(
    article(
      "11111111",
      "<Abstract><AbstractText>Wrong abstract.</AbstractText></Abstract>",
      "<CommentsCorrectionsList><CommentsCorrections><PMID>22222222</PMID></CommentsCorrections></CommentsCorrectionsList>",
    ),
  );
  assert.equal(extractAbstractText(raw, "22222222"), undefined);
});
test("abstract-like content in other structures is ignored", () => {
  const raw = document(
    article(
      "11111111",
      "<Supplement><Abstract><AbstractText>Wrong nested content.</AbstractText></Abstract></Supplement>",
      "<OtherAbstract><AbstractText>Wrong secondary abstract.</AbstractText></OtherAbstract>",
    ),
  );
  assert.equal(extractAbstractText(raw, "11111111"), undefined);
});
test("structured labels and paragraph order survive without duplicating metadata", () => {
  const raw = document(
    article(
      "11111111",
      '<Abstract><AbstractText Label=" BACKGROUND ">  Initial\n question. </AbstractText><AbstractText Label="METHODS" NlmCategory="METHODS">Local   methods.</AbstractText><AbstractText Label="RESULTS"> </AbstractText><AbstractText Label="CONCLUSIONS">Final result.</AbstractText></Abstract>',
    ),
  );
  assert.equal(
    extractAbstractText(raw, "11111111"),
    "BACKGROUND: Initial question.\n\nMETHODS: Local methods.\n\nCONCLUSIONS: Final result.",
  );
});
test("XML entities and inline markup are decoded once without losing comparisons", () => {
  const raw = document(
    article(
      "11111111",
      '<Abstract><AbstractText Label="SAFETY &amp; EFFICACY">A &lt;threshold&gt; &amp; B &#x2264; C. <i>Italic</i> and <sup>2</sup>.</AbstractText></Abstract>',
    ),
  );
  assert.equal(
    extractAbstractText(raw, "11111111"),
    "SAFETY & EFFICACY: A <threshold> & B ≤ C. Italic and ².",
  );
});
test("malformed XML, parser errors and wrong document roots return no abstract", () => {
  for (const raw of [
    "<PubmedArticleSet><unclosed>",
    "<parsererror>Invalid XML</parsererror>",
    "<wrapper>" +
      document(
        article(
          "11111111",
          "<Abstract><AbstractText>Wrong root.</AbstractText></Abstract>",
        ),
      ) +
      "</wrapper>",
  ]) {
    assert.equal(extractAbstractText(raw, "11111111"), undefined);
  }
});
test("the provider requests XML and preserves summary metadata when no abstract exists", async () => {
  requests.length = 0;
  summary = {
    result: {
      11111111: {
        title: "Synthetic article",
        authors: [{ name: "First Author" }],
        pubdate: "2024 Mar",
        fulljournalname: "Synthetic Journal",
        articleids: [{ idtype: "doi", value: "10.5555/fixture" }],
        pubtype: ["Journal Article"],
      },
    },
  };
  fetched = document(article("11111111"));
  const result = await pubmed.getInfoByPMID("11111111");
  assert.equal(result.title, "Synthetic article");
  assert.equal(result.year, "2024");
  assert.equal(result.identifiers.DOI, "10.5555/fixture");
  assert.equal(result.abstract, undefined);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /efetch\.fcgi\?db=pubmed&id=11111111&retmode=xml$/);
  fetched = document(
    article(
      "11111111",
      "<Abstract><AbstractText>Provider abstract.</AbstractText></Abstract>",
    ),
  );
  assert.equal(
    (await pubmed.getInfoByPMID("11111111")).abstract,
    "Provider abstract.",
  );
});

for (const [name, fn] of tests) {
  await fn();
  console.log(`PASS ${name}`);
}
console.log(
  `PubMed regression: ${tests.length}/${tests.length} checks passed (real XML DOM, synthetic records).`,
);
