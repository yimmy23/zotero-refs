/** Source-level, synthetic sequence tests. No Zotero, network, or library data. */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { fileURLToPath, URL } from "node:url";
import { buildSync } from "esbuild";

const source = fileURLToPath(
  new URL("../src/pdf/sequenceDecoder.ts", import.meta.url),
);
const { outputFiles } = buildSync({
  entryPoints: [source],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { decodeRegion, sequenceLineFeatures } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function lines(values) {
  return values.map((value, index) => {
    const supplied = typeof value === "string" ? { text: value } : value;
    return {
      id: `l${index}`,
      page: 0,
      order: index,
      column: 0,
      x: 50,
      y: 750 - 14 * index,
      height: 10,
      width: 250,
      spans: [
        {
          page: supplied.page ?? 0,
          item: index,
          start: 0,
          end: supplied.text.length,
        },
      ],
      ...supplied,
    };
  });
}
function decode(values, extra = {}) {
  return decodeRegion({
    id: "r1",
    kind: "main",
    evidence: ["heading"],
    lines: lines(values),
    ...extra,
  });
}
const citation = (number, name = "Smith") =>
  `[${number}] ${name} AB. A source study. Journal 2020;12:34-56.`;
const numbers = (result) => result.entries.map((entry) => entry.printedNumber);
const code = (result, name) =>
  result.diagnostics.some((entry) => entry.code === name);

test("numbered lines retain actual printed identities, boundaries and order", () => {
  const result = decode([citation(1), citation(2), citation(3)]);
  assert.deepEqual(numbers(result), [1, 2, 3]);
  assert.deepEqual(
    result.decisions.map((item) => item.label),
    ["B", "B", "B"],
  );
  assert.equal(result.entries[0].printedLabel, "[1]");
  assert.equal(result.entries[0].text, citation(1).slice(4));
});
test("missing numbers are diagnosed without invented publications", () => {
  const result = decode([citation(1), citation(3), citation(4)]);
  assert.deepEqual(numbers(result), [1, 3, 4]);
  assert(code(result, "printed-number-gap"));
});
test("number reset is retained as source evidence and warned", () => {
  const result = decode([citation(3), citation(1), citation(2)]);
  assert.deepEqual(numbers(result), [3, 1, 2]);
  assert(code(result, "printed-number-reset"));
});
test("standalone bracket marker can use its next author and publication line", () => {
  const result = decode([
    "[1]",
    "Smith AB. A study.",
    "Journal 2020;12:34-56.",
  ]);
  assert.equal(result.entries.length, 1);
  assert.equal(
    result.entries[0].rawText,
    "[1]\nSmith AB. A study.\nJournal 2020;12:34-56.",
  );
});
test("margin-style bare labels need letter evidence and preserve source form", () => {
  const result = decode([
    "1 Smith AB. Example. Journal 2020;12:34-56.",
    "2 Brown CD. Example. Journal 2021;13:57-60.",
  ]);
  assert.deepEqual(numbers(result), [1, 2]);
  assert.equal(result.entries[0].printedLabel, "1");
});
test("wrapped volume, issue and page ranges never become numbered starts", () => {
  const result = decode([
    "[1] Smith AB. Example. Journal 2020;",
    "41, 1103-1109.",
    "12 (3):34-56.",
    "13. 2019;44:99-100.",
  ]);
  assert.deepEqual(numbers(result), [1]);
  assert.equal(result.entries[0].lineIDs.length, 4);
  for (const text of [
    "41, 1103-1109.",
    "12 (3):34-56.",
    "13. 2019;44:99-100.",
    "2019 Journal report.",
  ])
    assert.equal(sequenceLineFeatures(text).marker, undefined);
});
test("labels alone do not turn a numbered outline into a bibliography", () => {
  const result = decode([
    "[1] Introduction",
    "[2] Study design",
    "[3] Discussion",
  ]);
  assert.equal(result.entries.length, 0);
});
test("unnumbered author-year entries do not get fabricated printed numbers", () => {
  const result = decode([
    "Smith AB. A study. Journal 2020;12:34-56.",
    "Brown CD. Another study. Journal 2021;14:57-90.",
  ]);
  assert.equal(result.entries.length, 2);
  for (const entry of result.entries) {
    assert(!Object.hasOwn(entry, "printedNumber"));
    assert(!Object.hasOwn(entry, "printedLabel"));
  }
});
test("initial capitals in a wrapped title do not trigger a new publication", () => {
  const result = decode([
    "Smith AB. A long study of",
    { text: "Novel Findings in Healthy Adults in 2020.", x: 62 },
    { text: "Journal 2021;14:57-90.", x: 62 },
    "Brown CD. Next study. Journal 2022;15:91-95.",
  ]);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0].lineIDs, ["l0", "l1", "l2"]);
});
test("hanging author-list continuation stays inside an unfinished entry", () => {
  const result = decode([
    "[1] Smith AB, Wilson CD,",
    { text: "Brown EF, Taylor GH. A study. Journal 2020;12:34-56.", x: 62 },
  ]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].lineIDs.length, 2);
});
test("full given names and accented names retain the first author line", () => {
  const result = decode([
    "Émile Smith, Jane Brown, Alice White, and André Green. A neutral study.",
    { text: "Example Journal 2020;12:34-56.", x: 62 },
    "Noam Example. A different neutral study, 2021.",
  ]);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].lineIDs[0], "l0");
  assert(result.entries.every((entry) => entry.printedNumber === undefined));
});
test("repeated hanging margins support long author lists and corporate entries", () => {
  const values = [];
  let y = 750;
  const add = (text, x = 50) => {
    values.push({ text, x, y });
    y -= 14;
  };
  add("Jane Smith, Émile Brown, Alice Green,");
  for (let i = 0; i < 12; i++)
    add("Andrew Jones, David Black, Carol White,", 62);
  add("and Fiona Gray. A neutral study. Example Journal 2020;12:34-56.", 62);
  y -= 12;
  add("Ravi Jones, Mary Green, and Jane White. Another study.");
  add("Example Journal 2021;13:57-68.", 62);
  y -= 12;
  add("ResearchNet. A neutral technical report, 2022.");
  const result = decode(values);
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].lineIDs.length, 14);
  assert.equal(result.entries[1].lineIDs.length, 2);
  assert.equal(result.entries[2].lineIDs.length, 1);
  assert(result.entries.every((entry) => entry.printedNumber === undefined));
  assert(code(result, "layout-only-entry-start"));
  assert(!code(result, "entry-without-publication-evidence"));
});
test("year-leading DOI tails never become fictitious four-digit labels", () => {
  const result = decode([
    "Jane Smith, Émile Brown, and Alice Green. A neutral study.",
    { text: "Example Journal,", x: 62 },
    { text: "2023. doi: 10.1000/example", x: 62 },
  ]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].printedNumber, undefined);
  assert.equal(result.entries[0].lineIDs.length, 3);
  assert.equal(
    sequenceLineFeatures("2023. doi: 10.1000/example").marker,
    undefined,
  );
  assert.equal(sequenceLineFeatures("2019) as optimizer").marker, undefined);
});
test("surname followed by one punctuated initial starts a publication", () => {
  const result = decode([
    "Alpha, A., Beta, B., and Gamma, C. (2020). A neutral study.",
    "Example Journal 12, 34-56.",
  ]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].lineIDs[0], "l0");
});
test("same-indent author continuation does not create a second publication", () => {
  const result = decode([
    "Brown, C. E., Smith, J., White, D.,",
    "Blanchard, M. S., Green, J., et al. (2020). A neutral title.",
    "Example Journal 12, 34-56.",
    "Jones, A., Black, B. (2021). Another source.",
    "Example Journal 13, 57-68.",
  ]);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0].lineIDs, ["l0", "l1", "l2"]);
  assert.equal(result.entries[1].lineIDs[0], "l3");
});
test("a surname split with a hyphen keeps the preceding author-list start", () => {
  const result = decode([
    "Brant, D. J., Smith, K., Little-",
    "Masters, B. K., Jones, G., et al. (2020). A neutral title.",
    "Example Journal 12, 34-56.",
  ]);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].lineIDs, ["l0", "l1", "l2"]);
  assert(result.entries[0].rawText.includes("Little-\nMasters"));
});
test("primary-publication asterisks remain in the source text", () => {
  for (const mark of ["*", "∗"]) {
    const text = `${mark} Alpha AB, Smith CD. A neutral source. Journal 2020;12:34-56.`;
    const result = decode([text]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].rawText, text);
    assert.equal(result.entries[0].text, text);
  }
});
test("OCR zero inside an initial shape is recognized without correcting the source", () => {
  const text = "Example,0. S. (1968). A neutral title. Journal";
  const result = decode([text, { text: "24, 339-352.", x: 62 }]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].lineIDs[0], "l0");
  assert(result.entries[0].rawText.startsWith("Example,0. S."));
  assert.equal(
    sequenceLineFeatures("Example,0.25 increases in 1968").authorStart,
    false,
  );
});
test("title hyphens after a publication year do not protect a new author start", () => {
  const result = decode([
    "Brant, D. J. (2020). A title mentioning Little-",
    "Masters, B. K. (2021). A different source. Journal 13, 57-68.",
  ]);
  assert.equal(result.entries.length, 2);
});
test("an author-list terminal and connects its next author line", () => {
  const result = decode([
    "Smith, A., Jones, B., Green, C., and",
    "White, D. (2020). A neutral title. Example Journal 12, 34-56.",
  ]);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].lineIDs, ["l0", "l1"]);
});
test("lowercase family-name particles are retained and recognized", () => {
  const text =
    "van der Example, S. J., Smith, A. (2020). A neutral title. Journal 12, 34-56.";
  const result = decode([text]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].rawText, text);
  assert(result.entries[0].text.startsWith("van der Example"));
});
test("Chinese authors, fullwidth labels and raw spaces are preserved", () => {
  const source =
    "［１４］ 童奇， 李建勋．机载使用方 法［ J ］．期刊，2015，44(2):419-427．";
  const result = decode([source]);
  assert.deepEqual(numbers(result), [14]);
  assert.equal(result.entries[0].printedLabel, "［１４］");
  assert.equal(result.entries[0].rawText, source);
  assert(result.entries[0].text.includes("使用方 法［ J ］"));
});
test("group labels are not publications and each group keeps multiple occurrences", () => {
  const result = decode(
    [
      { text: "Study alpha", role: "group", group: "alpha" },
      citation(1),
      citation(2),
      { text: "Study beta", role: "group", group: "beta" },
      citation(1),
      citation(2),
    ],
    { kind: "grouped" },
  );
  assert.deepEqual(numbers(result), [1, 2, 1, 2]);
  assert.deepEqual(
    result.entries.map((entry) => entry.group),
    ["alpha", "alpha", "beta", "beta"],
  );
  assert.equal(
    result.decisions.filter((entry) => entry.label === "G").length,
    2,
  );
  assert(!code(result, "printed-number-reset"));
});
test("soft noise keeps both halves and excludes only its own source span", () => {
  const result = decode([
    "[1] Smith AB. An unfinished title",
    { text: "Accepted Article", role: "soft-noise", x: 0, y: 0 },
    "continued. Journal 2020;12:34-56.",
    citation(2),
  ]);
  assert.deepEqual(numbers(result), [1, 2]);
  assert.deepEqual(result.entries[0].lineIDs, ["l0", "l2"]);
  assert.deepEqual(
    result.entries[0].spans.map((span) => span.item),
    [0, 2],
  );
  assert.equal(result.decisions[1].reasons[0], "soft-noise");
});
test("hard boundary ends the region and cannot restart on another article", () => {
  const result = decode([
    citation(1),
    { text: "Other article", role: "hard-boundary" },
    citation(1, "Jones"),
    citation(2, "Jones"),
  ]);
  assert.deepEqual(numbers(result), [1]);
  assert.deepEqual(
    result.decisions.map((entry) => entry.label),
    ["B", "O", "O", "O"],
  );
});
test("look-ahead does not borrow publication evidence across a hard boundary", () => {
  const result = decode([
    "[1] Introduction",
    { text: "Other article", role: "hard-boundary" },
    citation(1),
  ]);
  assert.equal(result.entries.length, 0);
});
test("unrelated disconnected geometry is not joined into the current entry", () => {
  const result = decode([
    citation(1),
    { text: "Axis label 2021", x: 650, y: 100 },
  ]);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].lineIDs, ["l0"]);
  assert(code(result, "unassigned-publication-line"));
});
test("an explicitly owned nonadjacent page can continue an entry", () => {
  const result = decode([
    "[14] Smith AB. An unfinished title",
    { text: "continued. Journal 2020;12:34-56.", page: 20, y: 700 },
    { text: citation(15), page: 20, y: 686 },
  ]);
  assert.deepEqual(numbers(result), [14, 15]);
  assert.deepEqual(
    result.entries[0].spans.map((span) => span.page),
    [0, 20],
  );
});
test("page and column transitions preserve the first-source navigation anchor", () => {
  const result = decode([
    { text: "[1] Smith AB. A title", x: 72, y: 81, height: 12 },
    { text: "continued. Journal 2020;12:34-56.", column: 1, x: 310, y: 700 },
  ]);
  assert.deepEqual(result.entries[0].anchor, { page: 0, x: 72, y: 93 });
  assert.deepEqual(result.entries[0].lineIDs, ["l0", "l1"]);
});
test("empty regions and ordinary prose produce no invented entries", () => {
  assert.equal(decode([]).entries.length, 0);
  assert.equal(
    decode(["References", "There are no bibliography entries here."]).entries
      .length,
    0,
  );
});
test("input is immutable and output spans do not alias the source", () => {
  const region = {
    id: "r1",
    kind: "main",
    evidence: [],
    lines: lines([citation(1), citation(2)]),
  };
  const original = JSON.parse(JSON.stringify(region));
  const freeze = (value) => {
    Object.freeze(value);
    for (const child of Object.values(value))
      if (child && typeof child === "object") freeze(child);
  };
  freeze(region);
  const result = decodeRegion(region);
  assert.deepEqual(region, original);
  result.entries[0].spans[0].start = 10;
  assert.equal(region.lines[0].spans[0].start, 0);
});
test("malformed geometry, duplicate IDs and oversized strings stop safely", () => {
  for (const bad of [
    { text: citation(2), y: Number.NaN },
    { text: citation(2), id: "l0" },
    { text: "x".repeat(20_001) },
    { text: citation(2), spans: [{ page: 0, item: -1, start: 0, end: 1 }] },
  ]) {
    const result = decode([citation(1), bad, citation(3)]);
    assert.deepEqual(numbers(result), [1]);
    assert(code(result, "invalid-source-line"));
  }
  assert(code(decodeRegion(null), "invalid-region"));
  const sparse = new Array(3);
  const invalid = decodeRegion({
    id: "r",
    kind: "main",
    lines: sparse,
    evidence: [],
  });
  assert.equal(invalid.entries.length, 0);
  assert.equal(invalid.decisions.length, 3);
  assert(code(invalid, "invalid-source-line"));
});
test("hostile-looking text is preserved as data without executing it", () => {
  const source =
    "[1] Smith AB. <script>globalThis.pwned=true</script>. Journal 2020;12:34-56.";
  assert.equal(decode([source]).entries[0].rawText, source);
  assert.equal(globalThis.pwned, undefined);
});
test("entry size limits are explicit and never synthesize missing entries", () => {
  const result = decode([
    citation(1),
    ...Array.from({ length: 70 }, () => "wrapped continuation"),
  ]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].lineIDs.length, 64);
  assert(result.limited);
  assert(code(result, "entry-line-limit"));
});
test("region size and transition counts have finite, reported bounds", () => {
  const values = Array.from({ length: 20_001 }, (_, index) => ({
    text: "watermark",
    role: "soft-noise",
    y: 700 - (index % 100),
  }));
  const result = decode(values);
  assert.equal(result.decisions.length, 20_000);
  assert.equal(result.entries.length, 0);
  assert(result.limited);
  assert(code(result, "region-line-limit"));
  assert(result.transitions <= 20_000 * 8 * 3);
});
test("beam scores and tie resolution are deterministic", () => {
  const source = [
    citation(1),
    "wrapped continuation",
    citation(3),
    { text: "watermark", role: "soft-noise" },
    citation(4),
  ];
  assert.deepEqual(decode(source), decode(source));
  assert(Number.isFinite(decode(source).score));
  assert(decode(source).transitions <= source.length * 8 * 3);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(
  `${tests.length - failures}/${tests.length} sequence decoder checks passed`,
);
if (failures) process.exitCode = 1;
