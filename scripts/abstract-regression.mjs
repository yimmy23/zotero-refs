import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/core/abstractText.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { normalizeAbstractText, abstractParagraphs } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const paragraphs = (raw, options) =>
  JSON.parse(JSON.stringify(abstractParagraphs(raw, options)));

test("HTML and JATS superscripts preserve scientific quantities", () => {
  assert.equal(
    normalizeAbstractText(
      "<p>Results: 4.5 × 10<sup>9</sup>/L; R<jats:sup>2</jats:sup>; CO<sub>2</sub>; 10<sup>−3</sup>.</p>",
    ),
    "Results: 4.5 × 10⁹/L; R²; CO₂; 10⁻³.",
  );
  assert.equal(
    normalizeAbstractText(
      "x<sup><i>n</i> + 1</sup>; y<sub>&amp;lt;</sub>; 10<sup>2",
    ),
    "x^(n + 1); y_(&lt;); 10²",
  );
});

test("abstract text keeps JATS structure, inline content and quoted tag attributes", () => {
  const raw =
    '<jats:abstract><jats:sec><jats:title>Background</jats:title><jats:p data-value="a > b">One <italic>important</italic> question.</jats:p></jats:sec><jats:sec><jats:title>Methods</jats:title><jats:p>Two cohorts.<br/>NCT03425643 [1].</jats:p></jats:sec></jats:abstract>';
  assert.equal(
    normalizeAbstractText(raw),
    "Background\n\nOne important question.\n\nMethods\n\nTwo cohorts.\n\nNCT03425643 [1].",
  );
  assert.deepEqual(paragraphs(raw), [
    { heading: "Background", text: "One important question." },
    { heading: "Methods", text: "Two cohorts." },
    { text: "NCT03425643 [1]." },
  ]);
});

test("abstract text preserves raw clinical inequalities and all numeric results", () => {
  const raw =
    "Results: P<0.001; HR 0.58 (95% CI 0.46 to 0.72). Patients >65 years had P<0.05; >90% completed treatment. CD8+ >10 and <20 cells. Conclusions: Benefit persisted.";
  assert.equal(normalizeAbstractText(raw), raw);
  assert.deepEqual(paragraphs(raw), [
    {
      heading: "Results",
      text: "P<0.001; HR 0.58 (95% CI 0.46 to 0.72). Patients >65 years had P<0.05; >90% completed treatment. CD8+ >10 and <20 cells.",
    },
    { heading: "Conclusions", text: "Benefit persisted." },
  ]);
});

test("letter comparisons and natural language are not mistaken for markup attributes", () => {
  for (const text of [
    "Results: A<B and C>D; all 180 patients were followed.",
    "Results: expression <baseline at day 7 and >baseline at day 14.",
    "Results: A<baseline>B. Comparison with untreated controls.",
    "Results: A<B + C>D; all results persisted.",
  ]) {
    assert.equal(normalizeAbstractText(text), text);
    assert.equal(normalizeAbstractText(normalizeAbstractText(text)), text);
  }
  assert.equal(
    normalizeAbstractText(
      "<b class=important>Real bold</b> <i hidden>italic</i> <jats:named-content content-type='gene'>EGFR</jats:named-content> <mml:mi>P</mml:mi>",
    ),
    "Real bold italic EGFR P",
  );
  assert.equal(normalizeAbstractText("A&lt;B and C&gt;D"), "A<B and C>D");
});

test("abstract entities preserve mathematical symbols, Unicode and unknown entities", () => {
  assert.equal(
    normalizeAbstractText(
      "P &lt; 0.05 &amp; age &ge;65 &le;80&nbsp;years; 10 &plusmn; 2 &times; 10&sup3; &ndash; &alpha; &#946; &#x394; &#128512; &unknown; &#x110000; &#55296; &#0;",
    ),
    "P < 0.05 & age ≥65 ≤80 years; 10 ± 2 × 10³ – α β Δ 😀 &unknown; &#x110000; &#55296; &#0;",
  );
  assert.equal(
    normalizeAbstractText("&amp;lt;script&amp;gt;"),
    "&lt;script&gt;",
    "entities are decoded only once",
  );
  assert.equal(
    normalizeAbstractText("&constructor; &toString; &hasOwnProperty;"),
    "&constructor; &toString; &hasOwnProperty;",
    "unknown entities must not read inherited object properties",
  );
});

test("plain-text paragraphs never parse literal tags or decode entities again", () => {
  const raw =
    "  Results: The literal <b> tag, A<B and C>D, and &amp; stay intact.\r\n\r\n  Methods: P<0.001.  ";
  assert.deepEqual(paragraphs(raw, { plainText: true }), [
    {
      heading: "Results",
      text: "The literal <b> tag, A<B and C>D, and &amp; stay intact.",
    },
    { heading: "Methods", text: "P<0.001." },
  ]);
  const normalized = normalizeAbstractText(
    "The literal &lt;b&gt; tag and &amp;lt; entity.",
  );
  assert.deepEqual(paragraphs(normalized, { plainText: true }), [
    { text: "The literal <b> tag and &lt; entity." },
  ]);
});

test("abstract markup is never executed and hidden script/style content is excluded", () => {
  const raw =
    '<p>Visible.</p><!-- hidden --><script>alert("secret")</script><style>p { color: red }</style><template>Hidden template.</template><p onclick="steal()">Safe <img src="x" onerror="steal()"/>text.</p>';
  assert.equal(normalizeAbstractText(raw), "Visible.\n\nSafe text.");
  assert.equal(
    normalizeAbstractText("Visible<script>unfinished secret"),
    "Visible",
  );
  assert.equal(
    normalizeAbstractText("Visible<!-- unfinished comment"),
    "Visible",
  );
  assert.equal(
    normalizeAbstractText("&lt;img src=x onerror=steal()&gt;"),
    "<img src=x onerror=steal()>",
    "decoded markup remains inert text for textContent consumers",
  );
});

test("unstructured abstracts retain existing paragraphs, not arbitrary sentences", () => {
  const raw =
    "  First sentence.\tSecond sentence!  \r\n\r\n  Another paragraph has methods and results.\n\n\nLast paragraph.  ";
  assert.equal(
    normalizeAbstractText(raw),
    "First sentence. Second sentence!\n\nAnother paragraph has methods and results.\n\nLast paragraph.",
  );
  assert.deepEqual(paragraphs(raw), [
    { text: "First sentence. Second sentence!" },
    { text: "Another paragraph has methods and results." },
    { text: "Last paragraph." },
  ]);
});

test("structured inline English and Chinese headings use the source wording", () => {
  assert.deepEqual(
    paragraphs(
      "BACKGROUND: Need. METHODS: Trial. Results: 30 cases. Conclusions and Relevance: Effective.",
    ),
    [
      { heading: "BACKGROUND", text: "Need." },
      { heading: "METHODS", text: "Trial." },
      { heading: "Results", text: "30 cases." },
      { heading: "Conclusions and Relevance", text: "Effective." },
    ],
  );
  assert.deepEqual(
    paragraphs(
      "背景：存在争议。方法：随机入组。结果：HR<0.8；P<0.001。结论：获益。",
    ),
    [
      { heading: "背景", text: "存在争议。" },
      { heading: "方法", text: "随机入组。" },
      { heading: "结果", text: "HR<0.8；P<0.001。" },
      { heading: "结论", text: "获益。" },
    ],
  );
});

test("ordinary prose, substring matches and headings without markers are not split", () => {
  for (const text of [
    "We used these methods: observation and follow-up. The results: uncertain.",
    "The Background was uncertain. Methods were considered. Results improved.",
    "We compared Methods: Bayesian and frequentist approaches.",
    "SomethingResults: important but not a heading.",
    "研究的方法：包括问卷。检测结果：阴性。",
  ])
    assert.deepEqual(paragraphs(text), [{ text }]);
  assert.deepEqual(
    paragraphs("methods: Prespecified methods. No random splitting."),
    [
      {
        heading: "methods",
        text: "Prespecified methods. No random splitting.",
      },
    ],
  );
});

test("heading-only lines, HTML blocks and empty text lose no source content", () => {
  assert.deepEqual(
    paragraphs(
      "<h2>Objective</h2><div>Study one.</div><h2>Results:</h2><p>Result one.</p><p>Result two.</p>",
    ),
    [
      { heading: "Objective", text: "Study one." },
      { heading: "Results", text: "Result one." },
      { text: "Result two." },
    ],
  );
  assert.deepEqual(paragraphs("Background\nMethods\nDetails.\nConclusion"), [
    { text: "Background" },
    { heading: "Methods", text: "Details." },
    { text: "Conclusion" },
  ]);
  assert.deepEqual(paragraphs("Background\nMethods: Details."), [
    { text: "Background" },
    { heading: "Methods", text: "Details." },
  ]);
  assert.deepEqual(paragraphs("Background: Methods: Details."), [
    { text: "Background" },
    { heading: "Methods", text: "Details." },
  ]);
  assert.deepEqual(paragraphs(""), []);
  assert.deepEqual(paragraphs("<p>  </p>"), []);
  assert.equal(
    normalizeAbstractText("<![CDATA[P<0.001; NCT03425643]]>"),
    "P<0.001; NCT03425643",
  );
});
