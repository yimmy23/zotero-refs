/** Neutral source-line fixtures; no PDF files, Zotero profile or network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { transformSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
const source = fileURLToPath(
  new URL("../src/pdf/groupedStudyReferences.ts", import.meta.url),
);
const m = { exports: {} };
new Function(
  "module",
  "exports",
  transformSync(fs.readFileSync(source, "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code,
)(m, m.exports);
const segment = m.exports.segmentGroupedStudyReferences;
const heading = "References to studies included in this review";
const spec = [
  [heading, 0],
  ["Alpha 2020 {published data only}", 0],
  ["Amber A, Brown B, Green C,", 16],
  ["White D, et al. A neutral clinical study.", 16],
  ["Journal of Examples 2020; 12(3):101-110.", 16],
  ["∗ Baker B, Cooper C. A distinct publication.", 16],
  ["Example Reviews 2021; 13(suppl 5):134.", 16],
  ["Beta 2021 {published and unpublished data}", 0],
  ["Baker B, Green C. Another source.", 16],
  ["Example Science 2021; 21:320a (abstr 1279).", 16],
  ["Gamma 2022 {unpublished data only}", 0],
  ["Carter C, White D. A fourth source.", 16],
  ["Example Research 2022; 41 Suppl (2):76.", 16],
  ["∗ Indicates the major publication for the study", 0],
];
const lines = (values = spec) =>
  values.map(([text, x], i) => ({
    text,
    x,
    _x: x + 80,
    y: 740 - i * 12,
    height: 8,
    width: 250,
    pageNum: 2,
    column: 0,
    _height: [8],
  }));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const clone = () => lines();
if (process.argv.includes("--adversarial-worker")) {
  const start = performance.now();
  const payloads = [
    "A-".repeat(12_000),
    "A A ".repeat(7_000),
    "1".repeat(31_000),
    "1 ".repeat(15_000),
    " ".repeat(31_000),
    "(".repeat(31_000),
    "A ::".repeat(7_000),
  ];
  for (const text of payloads) {
    const input = clone();
    input[2].text = text;
    segment(input);
  }
  console.log(
    JSON.stringify({ calls: payloads.length, ms: performance.now() - start }),
  );
  process.exit(0);
}

test("group labels are separate from four complete publication occurrences", () => {
  const input = clone(),
    before = JSON.stringify(input),
    r = segment(input);
  assert(r);
  assert.equal(r.refs.length, 4);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(
    r.entries.map((x) => x.lineIndices),
    [
      [2, 3, 4],
      [5, 6],
      [8, 9],
      [11, 12],
    ],
  );
  assert.deepEqual(
    r.refs.map((x) => x.y),
    [716, 680, 644, 608],
  );
  assert.equal(
    r.refs[0].text,
    spec
      .slice(2, 5)
      .map((x) => x[0])
      .join(" "),
  );
  assert.equal(r.entries[0].group, spec[1][0]);
  assert.equal(r.entries[1].group, spec[1][0]);
  assert(!r.refs.some((x) => x.text.includes("published data")));
});
test("every source line has exactly one role and publication indices never overlap", () => {
  const r = segment(clone());
  assert.deepEqual(
    r.decisions.map((x) => x.lineIndex),
    spec.map((_, i) => i),
  );
  assert.equal(r.decisions.filter((x) => x.label === "G").length, 3);
  assert.equal(r.decisions.filter((x) => x.label === "O").length, 2);
  assert.deepEqual(
    r.entries.flatMap((x) => x.lineIndices),
    r.decisions
      .filter((x) => x.label === "B" || x.label === "I")
      .map((x) => x.lineIndex),
  );
  for (const e of r.entries)
    assert.equal(r.decisions[e.lineIndices[0]].label, "B");
});
test("repeated publications in different study groups are retained", () => {
  const input = clone();
  input[8].text = input[11].text;
  input[9].text = input[12].text;
  const r = segment(input);
  assert.equal(r.refs.length, 4);
  assert.equal(r.refs[2].text, r.refs[3].text);
  assert.notEqual(r.entries[2].group, r.entries[3].group);
});
test("absent category and fewer than three explicit study labels use fallback", () => {
  const input = clone();
  input[0].text = "References";
  assert.equal(segment(input), null);
  input[0].text = heading;
  input[10].text = "Gamma 2022";
  assert.equal(segment(input), null);
  const ordinary = [{ text: "Smith A. A normal reference." }];
  Object.defineProperty(ordinary, 1, {
    get() {
      throw Error("ordinary path must not inspect later rows");
    },
  });
  ordinary.length = 10;
  assert.equal(segment(ordinary), null);
});
test("open author fields continue but incomplete citations cannot borrow another publication", () => {
  assert.equal(segment(clone()).refs.length, 4);
  for (const text of [
    "Amber A, Brown B. An incomplete study.",
    "Amber A, Brown B. A neutral title,",
    "Amber A, Brown B. A Randomized Trial,",
  ]) {
    const input = clone();
    input[2].text = text;
    input.splice(3, 2);
    const reset = lines(input.map((l) => [l.text, l.x]));
    assert.equal(segment(reset), null);
  }
});
test("title year ranges do not count as a publication ending", () => {
  const input = clone();
  input[2].text = "Amber A, Brown B. Historical reports 1990-2000.";
  input[3].text =
    "Research Reports, A guide to continuing education. Medical Education 2001;35:100-110.";
  input.splice(4, 1);
  const r = segment(lines(input.map((x) => [x.text, x.x])));
  assert(r);
  assert.equal(r.refs.length, 4);
  assert(
    r.refs[0].text.includes("Historical reports 1990-2000. Research Reports"),
  );
});
test("journal or volume tails without a first author are not complete source entries", () => {
  const input = clone();
  input[2].text = "Journal of Examples 2020;12:101-110.";
  input.splice(3, 2);
  assert.equal(segment(lines(input.map((x) => [x.text, x.x]))), null);
});
test("numbered entries anywhere in the body cannot be swallowed as continuation", () => {
  for (const prefix of ["[1] ", "(1) ", "1. ", "［１］ "]) {
    const input = clone();
    input[3].text = prefix + "Other A, Other B. Study. Journal 2020;3:10-20.";
    assert.equal(segment(input), null);
  }
});
test("literal source hyphens survive surname, compound and numeric wrapping", () => {
  const input = clone();
  input[2].text = "Amber A, Brown B, North-";
  input[3].text = "West C. Antigen-specific responses in T-";
  input[4].text = "lymphocytes. Journal 2020;12:101-110.";
  let r = segment(input);
  assert(r);
  assert(r.refs[0].text.includes("North-West"));
  assert(r.refs[0].text.includes("T-lymphocytes"));
  input[3].text = "West C. A study. Journal 2020;12:101 -";
  input[4].text = "110.";
  r = segment(input);
  assert(r);
  assert(r.refs[0].text.endsWith("101 - 110."));
});
test("DOI wraps retain a literal hyphen with no inserted identifier space", () => {
  const input = clone();
  input[2].text = "Amber A, Brown B. A study. doi:10.12345/source-";
  input[3].text = "identifier";
  input.splice(4, 1);
  const r = segment(lines(input.map((x) => [x.text, x.x])));
  assert(r);
  assert.equal(r.refs.length, 4);
  assert(r.refs[0].text.endsWith("10.12345/source-identifier"));
});
test("corporate authors, ongoing trials, handbooks and dated websites have explicit evidence", () => {
  const input = spec.map((x) => [...x]);
  input[11][0] = "Example Collaborative Group. A study.";
  input.splice(
    -1,
    0,
    ["References to ongoing studies", 0],
    ["TrialX {published data only}", 0],
    ["EXAMPLE Trial of source methods", 16],
    ["Ongoing study 01/12/2022.", 16],
    ["Additional references", 0],
    ["Manual 2023", 0],
    ["Smith A, Jones B (editors). A handbook.", 16],
    ["Oxford: Example Press, 2023.", 16],
    ["Controlled Resources", 0],
    ["Example Institute. Registered resources.", 16],
    ["www.example.org (accessed 19 October 2023).", 16],
  );
  const r = segment(lines(input));
  assert(r);
  assert.equal(r.refs.length, 7);
  assert(r.refs.some((x) => x.text.startsWith("Example Collaborative Group")));
});
test("unsupported report endings and an unclosed final publication decline the whole block", () => {
  const input = clone();
  input[9].text = "Unpublished methods report available from authors.";
  assert.equal(segment(input), null);
  input[9].text = spec[9][0];
  input[12].text = "A source without publication metadata.";
  assert.equal(segment(input), null);
});
test("metadata links follow an entry without changing its first source anchor", () => {
  const input = spec.map((x) => [...x]);
  input.splice(5, 0, ["DOI:10.12345/example", 16]);
  const ls = lines(input);
  ls[5].url = "https://doi.org/10.12345/example";
  const r = segment(ls);
  assert(r);
  assert.equal(r.refs.length, 4);
  assert.equal(r.refs[0].url, ls[5].url);
  assert.equal(r.refs[0].y, ls[2].y);
});
test("a soft blank line retains the current entry and receives an explicit outside role", () => {
  const input = spec.map((x) => [...x]);
  input.splice(4, 0, ["", 16]);
  const r = segment(lines(input));
  assert(r);
  assert.equal(r.decisions[4].label, "O");
  assert.deepEqual(r.entries[0].lineIndices, [2, 3, 5]);
});
test("unknown margins, section text and content after the legend decline", () => {
  let input = clone();
  input[3].x = 9;
  assert.equal(segment(input), null);
  input = clone();
  input[7].text = "Characteristics of studies";
  assert.equal(segment(input), null);
  input = lines([
    ...spec,
    ["Smith A, White B. Another study. Journal 2020;2:1-3.", 16],
  ]);
  assert.equal(segment(input), null);
});
test("finite coordinates and monotonic adjacent page-column flow are mandatory", () => {
  for (const [key, value] of [
    ["y", NaN],
    ["x", Infinity],
    ["height", 0],
    ["pageNum", 1],
    ["pageNum", 4],
    ["column", 2],
    ["column", -1],
    ["_x", NaN],
  ]) {
    const input = clone();
    input[3][key] = value;
    assert.equal(segment(input), null);
  }
  let input = clone();
  input[3].y = input[2].y;
  assert.equal(segment(input), null);
  input = clone();
  for (let i = 3; i < input.length; i++) {
    input[i].column = 1;
    input[i]._x += 300;
    input[i].y = 750 - (i - 3) * 12;
  }
  assert(segment(input));
  for (let i = 7; i < input.length; i++) {
    input[i].pageNum = 3;
    input[i].column = 0;
    input[i]._x -= 300;
    input[i].y = 750 - (i - 7) * 12;
  }
  assert(segment(input));
});
test("an unresolved publication cannot bridge a large same-column gap", () => {
  const input = clone();
  for (let i = 3; i < input.length; i++) input[i].y -= 400;
  assert.equal(segment(input), null);
});
test("limits decline without partial success or caller mutation", () => {
  assert.equal(segment([]), null);
  assert.equal(segment(Array(20_001).fill(clone()[0])), null);
  let input = clone();
  input[2].text = "A".repeat(32_001);
  assert.equal(segment(input), null);
  input = spec.map((x) => [...x]);
  input.splice(
    3,
    0,
    ...Array.from({ length: 129 }, () => [
      "continuation without a publication tail",
      16,
    ]),
  );
  assert.equal(segment(lines(input)), null);
});
test("adversarial prefix and publication strings finish within an isolated deadline", () => {
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--adversarial-worker"],
    { timeout: 3000, encoding: "utf8", maxBuffer: 32000 },
  );
  assert.equal(worker.error, undefined);
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(JSON.parse(worker.stdout).calls, 7);
});
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`not ok - ${name}`, e);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} grouped study checks passed`,
);
if (failed) process.exitCode = 1;
