/** Neutral flush-left bibliography fixtures; no Zotero profile, PDF or network. */
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
function compile(relative, imports = {}, extra = "") {
  const module = { exports: {} };
  const code = transformSync(fs.readFileSync(root + relative, "utf8") + extra, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;
  new Function("module", "exports", "require", "ztoolkit", code)(
    module,
    module.exports,
    (name) => {
      assert(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
    { log() {} },
  );
  return module.exports;
}
const grouped = compile("src/pdf/groupedReferences.ts");
if (process.argv.includes("--adversarial-worker")) {
  const started = performance.now();
  const payloads = [
    "A-".repeat(160) + "A",
    "A-".repeat(8_000) + "A",
    "A-".repeat(120) + "A, A.",
    "1".repeat(16_000),
    "1 ".repeat(8_000),
    " ".repeat(16_000),
    "(" + " ".repeat(16_000),
    "Adams, A. " + "-".repeat(16_000),
    "Methods." + " ".repeat(8_000) + "A" + " ".repeat(7_900),
  ];
  const text = [
    "Adams, A. (2019). Example study.",
    "Journal of Examples 11, 24-35.",
    "Baker, B. (2020). Second example study.",
    "Journal of Examples 12, 44-55.",
    "Carter, C. (2021). Third example study.",
    "Journal of Examples 13, 64-75.",
  ];
  let calls = 0;
  for (const payload of payloads) {
    for (const position of [0, 1, 4]) {
      const input = [...text];
      input.splice(position, 0, payload);
      grouped.mergeFlatAuthorYearReferences(
        input.map((value, index) => ({
          text: value,
          x: 0,
          y: 700 - index * 14,
          height: 12,
          pageNum: 0,
          column: 0,
        })),
        (a, b) => `${a} ${b}`,
      );
      calls++;
    }
  }
  console.log(
    JSON.stringify({ calls, elapsedMs: performance.now() - started }),
  );
  process.exit(0);
}
const parser = compile(
  "src/pdf/parser.ts",
  {
    "../core/text": compile("src/core/text.ts"),
    "./groupedReferences": grouped,
    "./groupedStudyReferences": compile("src/pdf/groupedStudyReferences.ts"),
    "../utils/prefs": { getPref: () => 4 },
    "../utils/locale": { getString: (key) => key },
  },
  "\nexport {mergeSameRef};",
);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const lines = (texts) =>
  texts.map((text, index) => ({
    text,
    x: 0,
    _x: 72,
    _offset: 72,
    y: 700 - index * 14,
    height: 12,
    width: 400,
    _height: [12],
    pageNum: 2,
    column: 0,
  }));
const basic = [
  "Adams, A. (2019). A study of example methods.",
  "Journal of Examples 11, 24-35.",
  "Baker, B., Jones, C., Smith, D., and",
  "Cooper, E. (2020). Another study of examples.",
  "Example Science 12, 44-55.",
  "Carter, C. (2021). A third source.",
  "Example Reviews 13, 60-70.",
];
const join = (a, b) => `${a} ${b}`;
const run = (text = basic) => parser.mergeSameRef(lines(text));
const helper = (input = lines(basic)) =>
  grouped.mergeFlatAuthorYearReferences(input, join);

test("flush-left title and continuation author lines stay in three complete entries", () => {
  const result = run();
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((x) => x.text),
    [
      basic.slice(0, 2).join(" "),
      basic.slice(2, 5).join(" "),
      basic.slice(5).join(" "),
    ],
  );
});
test("single-initial comma and wrapped surname cannot split an unfinished author list", () => {
  const input = [...basic];
  input[2] = "Baker, B., Jones, C., and North-";
  input[3] = "West, D. (2020). Another study of examples.";
  const result = run(input);
  assert.equal(result.length, 3);
  assert.match(result[1].text, /North-West, D/);
});
test("full-name first authors and lowercase surname particles are accepted", () => {
  const input = [...basic];
  input[2] = "Barbara Anne Baker, B. C., Charles Green, Donald";
  input[3] = "Edwards, C. D. (2020). Another study of examples.";
  input[5] = "van der Carter, C. (2021). A third source.";
  assert.deepEqual(
    run(input).map((x) => x.y),
    [700, 672, 630],
  );
});
test("OCR spaces in names, years and page digits affect features only", () => {
  const input = [...basic];
  input[2] = "Baker , B., Jones, C., Smith, D., and";
  input[3] = "Cooper, E. (20 20). Another study of examples.";
  input[4] = "Example Science 12, 44 - 5 5.";
  const result = run(input);
  assert.equal(result.length, 3);
  assert.equal(result[1].text, input.slice(2, 5).join(" "));
});
test("spaced page ranges wrapping onto a numeric-only line retain the hyphen", () => {
  const input = [...basic];
  input.splice(1, 1, "Journal of Examples 11, 24 -", "35.");
  const result = run(input);
  assert.equal(result.length, 3);
  assert.match(result[0].text, /24 - 35\.$/);
});
test("visible surname and compound hyphens survive source line wrapping", () => {
  const input = [...basic];
  input[2] = "Baker, B., Jones, C., and North-";
  input[3] = "West, D. (2020). Antigen-";
  input.splice(4, 0, "specific activity of T-", "lymphocyte responses.");
  const result = run(input);
  assert.equal(result.length, 3);
  assert.match(
    result[1].text,
    /North-West, D\. \(2020\)\. Antigen-specific activity of T-lymphocyte/,
  );
});
test("a literal DOI hyphen joins without identifier-breaking whitespace", () => {
  const input = [...basic];
  input[1] = "Journal of Examples 11, 24-35. doi:10.5555/source-";
  input.splice(2, 0, "identifier.");
  const result = run(input);
  assert.equal(result.length, 3);
  assert.match(result[0].text, /doi:10\.5555\/source-identifier\.$/);
  assert(!result[0].text.includes("source- identifier"));
  input[1] = "Journal of Examples 11, 24-35. https://doi.org/10.5555/source-";
  assert.match(
    run(input)[0].text,
    /https:\/\/doi\.org\/10\.5555\/source-identifier\.$/,
  );
});
test("roman page prefixes, conference abstract endings and volume-only sources terminate", () => {
  const input = [...basic];
  input[1] = "Journal of Examples 11, iv24-iv35.";
  input[4] =
    "Paper presented at: Annual Meeting (Journal of Examples 12 (suppl; abstr 45)).";
  input[6] = "Example Reviews 13.";
  assert.equal(run(input).length, 3);
});
test("coordinates, first source metadata, link and caller objects are retained", () => {
  const input = lines(basic);
  input[3].url = "https://example.org/article";
  const before = JSON.stringify(input);
  const result = parser.mergeSameRef(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result[1], input[2]);
  assert.equal(result[1]._x, 72);
  assert.equal(result[1].y, input[2].y);
  assert.equal(result[1].pageNum, 2);
  assert.equal(result[1].url, input[3].url);
});
test("adjacent page author wrapping remains one entry", () => {
  const input = lines(basic);
  for (let i = 3; i < input.length; i++) {
    input[i].pageNum = 3;
    input[i].y = 740 - (i - 3) * 14;
  }
  assert.equal(helper(input).length, 3);
});
test("hanging indentation and grouped study labels keep the legacy fallback", () => {
  const input = lines(basic);
  input[1].x = 15;
  assert.equal(helper(input), null);
  assert.equal(
    helper(lines(["References to studies included in this review", ...basic])),
    null,
  );
});
test("numbered, title-only and insufficient-evidence inputs never enter this branch", () => {
  assert.equal(helper(lines(basic.map((x, i) => `[${i + 1}] ${x}`))), null);
  assert.equal(
    helper(lines(basic.map((x) => x.replace(/\(\d{4}\)/g, "")))),
    null,
  );
  assert.equal(helper(lines(basic.slice(0, 5))), null);
  assert.equal(
    helper(lines(["Results of an experiment", ...basic.slice(1)])),
    null,
  );
});
test("ambiguous trailing text and large gaps retain the existing fallback", () => {
  assert.equal(helper(lines([...basic, "Acknowledgments"])), null);
  const input = lines(basic);
  input[3].y -= 80;
  input[3].text = "Cooper, E. (2020). Another study of examples.";
  // The wrapped second author cannot look across an unrelated block boundary.
  assert.equal(helper(input), null);
});
test("bibliography years mentioned in titles do not split the current entry", () => {
  const input = [...basic];
  input.splice(1, 0, "Recent Trends (2010) and Earlier Studies (2009).");
  const result = run(input);
  assert.equal(result.length, 3);
  assert.match(result[0].text, /Recent Trends/);
});
test("bounds and invalid geometry decline safely without modifying input", () => {
  assert.equal(helper([]), null);
  assert.equal(
    helper(Array.from({ length: 20_001 }, () => lines(basic)[0])),
    null,
  );
  const input = lines(basic);
  input[1].x = Number.NaN;
  assert.equal(helper(input), null);
  input[1].x = 0;
  input[1].height = 0;
  assert.equal(helper(input), null);
});
test("overlong unresolved entries fall back within line and character bounds", () => {
  assert.equal(
    helper(
      lines([
        basic[0],
        ...Array(129).fill("continued text"),
        ...basic.slice(1),
      ]),
    ),
    null,
  );
  assert.equal(
    helper(lines([basic[0], "x".repeat(32_001), ...basic.slice(1)])),
    null,
  );
  assert.equal(
    helper(
      lines([basic[0], ...Array(8).fill("x".repeat(5_000)), ...basic.slice(1)]),
    ),
    null,
  );
});
test("mixed books retain the baseline boundaries instead of merging a later paper", () => {
  const input = [
    "Adams, A. (2019). First journal study. Journal of Examples 11,",
    "24-35.",
    "Baker, B. (2020). A practical textbook. Oxford: Example Press, 2020.",
    "Carter, C. (2021). Third journal study. Example Reviews 13,",
    "60-70.",
    "Davis, D. (2022). Fourth journal study. Example Reviews 14,",
    "80-90.",
  ];
  assert.equal(helper(lines(input)), null);
  const result = run(input);
  assert.equal(result.length, 4);
  assert.equal(result[1].text, input[2]);
  assert.equal(result[2].text, input.slice(3, 5).join(" "));
});
test("unknown report endings and wrapped next-author years are ambiguous", () => {
  for (const end of [
    "Oxford: Example Press, 2020.",
    "Research methods report. Geneva: Example Unit, 2020.",
    "Unpublished report available from the authors.",
  ]) {
    const input = [
      ...basic.slice(0, 2),
      `Baker, B. (2020). A methods report. ${end}`,
      "Carter, C. (20",
      "21). A third source. Example Reviews 13, 60-70.",
      "Davis, D. (2022). A fourth source.",
      "Example Reviews 14, 80-90.",
    ];
    assert.equal(helper(lines(input)), null);
  }
});
test("long or undated new author prefixes cannot borrow a later record's ending", () => {
  const input = [
    ...basic.slice(0, 2),
    "Baker, B., Smith, C., and other authors",
    ...Array(13).fill("additional author details"),
    "(2020). Example title. Journal 12, 40-50.",
    ...basic.slice(5),
    "Davis, D. (2022). A fourth source.",
    "Example Reviews 14, 80-90.",
  ];
  assert.equal(helper(lines(input)), null);
});
test("split parenthesized years are supported without merging author identities", () => {
  const input = [...basic];
  input.splice(0, 1, "Adams, A. (20", "19). A study of example methods.");
  const result = helper(lines(input));
  assert.equal(result.length, 3);
  assert.match(result[0].text, /\(20 19\)/);
  assert.equal(result[1].text, basic.slice(2, 5).join(" "));
});
test("every y coordinate and page-column index must be finite and well formed", () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    for (const index of [0, 3, 6]) {
      const input = lines(basic);
      input[index].y = value;
      assert.equal(helper(input), null);
    }
  }
  for (const key of ["pageNum", "column"]) {
    for (const value of [Number.NaN, -1, 0.5, undefined]) {
      const input = lines(basic);
      input[3][key] = value;
      assert.equal(helper(input), null);
    }
  }
});
test("reversed, skipped or mixed reading-order transitions decline the entire block", () => {
  const cases = [
    { pageNum: 1 },
    { pageNum: 4 },
    { column: 2 },
    { pageNum: 3, column: 1 },
    { y: 800 },
    { y: 672 },
  ];
  for (const change of cases) {
    const input = lines(basic);
    Object.assign(input[3], change);
    assert.equal(helper(input), null);
  }
  const reversedColumns = lines(basic).map((line) => ({ ...line, column: 1 }));
  reversedColumns[3].column = 0;
  assert.equal(helper(reversedColumns), null);
});
test("an adjacent column and next-page column reset are valid source order", () => {
  const input = lines(basic);
  for (let i = 3; i < input.length; i++) {
    input[i].column = 1;
    input[i].y = 740 - (i - 3) * 14;
  }
  assert.equal(helper(input).length, 3);
  for (let i = 5; i < input.length; i++) {
    input[i].pageNum = 3;
    input[i].column = 0;
    input[i].y = 740 - (i - 5) * 14;
  }
  assert.equal(helper(input).length, 3);
});
test("adversarial author and publication features finish in an isolated time bound", () => {
  const worker = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--adversarial-worker"],
    { encoding: "utf8", timeout: 3_000, maxBuffer: 32_000 },
  );
  assert.equal(worker.error, undefined, worker.error?.message);
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(JSON.parse(worker.stdout.trim()).calls, 27);
});
test("numbered integration retains printed sequence and original anchors", () => {
  const input = lines([
    "[1] Adams AB. Study. Journal. 2020;1:2-3.",
    "[3] Baker CD. Study. Journal. 2020;1:4-5.",
    "[4] Carter EF. Study. Journal. 2020;1:6-7.",
  ]);
  assert.deepEqual(
    parser.mergeSameRef(input).map((x) => x.text),
    input.map((x) => x.text),
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`, error);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} legacy grouped checks passed`,
);
if (failed) process.exitCode = 1;
