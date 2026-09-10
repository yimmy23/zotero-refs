/** End-to-end neutral geometry/ownership/reader tests, independent of legacy output. */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { fileURLToPath, URL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { buildSync } from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = buildSync({
  stdin: {
    contents:
      'export * from "./src/pdf/sequenceCore"; export * from "./src/pdf/sequenceLayout"; export * from "./src/pdf/sequenceRegions"; export * from "./src/pdf/sequenceReader";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const {
  extractSequenceReferences: extract,
  buildSequenceLines: layout,
  sourceFragments,
  selectSequenceRegions: select,
  parseSequencePDFReferences: read,
} = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
globalThis.Zotero = { Promise: { delay: (ms) => setTimeout(ms) } };
globalThis.ztoolkit = {
  log() {},
  getDOMParser() {
    throw Error("No HTML fixture");
  },
};
const item = (str, x = 50, y = 680, width = 200, height = 10) => ({
  str,
  width,
  height,
  transform: [height, 0, 0, height, x, y],
});
const page = (items, n = 0) => ({ page: n, width: 600, height: 800, items });
const cite = (n, author = "Smith") =>
  `[${n}] ${author} AB. Study. Journal 2020;12:34-56.`;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function frozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
const numbers = (r) => r.entries.map((e) => e.printedNumber);
function regions(pages, from) {
  return select(layout(pages).lines, pages, from);
}
function marked({
  reverse = false,
  reset = false,
  duplicate = false,
  chapter = false,
} = {}) {
  const p0 = page(
    [
      item("85", 280, 780, 15),
      item("参考文献", 50, 700, 90),
      item(cite(1), 50, 670),
      item(cite(2), 50, 650),
      item("（下接105页）", 50, 620, 120),
    ],
    reverse ? 2 : 0,
  );
  const p1 = page(
    [
      item("105", 280, 780, 20),
      item("Other article", 50, 720),
      item("References", 50, 700),
      item(cite(1, "Other"), 50, 670),
      item("（上接85页）", 50, 600, 120),
      item(cite(reset ? 1 : 3), 50, 570),
      item(cite(reset ? 2 : 4), 50, 550),
    ],
    reverse ? 0 : 1,
  );
  const pages = [p0, p1].sort((a, b) => a.page - b.page);
  if (duplicate) pages.push(page([item("105", 280, 780, 20)], 2));
  if (chapter)
    pages.push(
      page(
        [
          item("References", 50, 700),
          item(cite(1, "Chapter"), 50, 670),
          item(cite(2, "Chapter"), 50, 650),
        ],
        2,
      ),
    );
  return pages;
}
test("different-baseline columns have column-major reading order", () => {
  const p = page([
    item("L1", 50, 700),
    item("L2", 50, 680),
    item("L3", 50, 660),
    item("R1", 330, 690),
    item("R2", 330, 670),
    item("R3", 330, 650),
  ]);
  assert.deepEqual(
    layout([p]).lines.map((l) => l.text),
    ["L1", "L2", "L3", "R1", "R2", "R3"],
  );
});
test("drawing order and detached numbers do not reorder source identities", () => {
  const p = page([
    item("", 1, 1),
    item("References", 50, 700),
    item("Smith AB. Journal 2020;1:2-3.", 70, 680),
    item("[1]", 50, 680, 15),
    item(cite(2), 50, 660),
  ]);
  const before = JSON.stringify(p);
  const r = extract(frozen([p]));
  assert.deepEqual(numbers(r), [1, 2]);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(sourceFragments([p], r.entries[0].spans), [
    "[1]",
    "Smith AB. Journal 2020;1:2-3.",
  ]);
});
test("fullwidth separator creates local two-column bands", () => {
  const p = page([
    item("Left top", 50, 730),
    item("Right top", 330, 730),
    item("Left mid", 50, 715),
    item("Right mid", 330, 715),
    item("Heading", 50, 700, 500),
    item("Left low", 50, 675),
    item("Right low", 330, 675),
    item("Left end", 50, 660),
    item("Right end", 330, 660),
  ]);
  assert.deepEqual(
    layout([p]).lines.map((l) => l.text),
    [
      "Left top",
      "Left mid",
      "Right top",
      "Right mid",
      "Heading",
      "Left low",
      "Left end",
      "Right low",
      "Right end",
    ],
  );
});
test("ordinary current-page parse cannot consume later pages", () => {
  const pages = [
    page([item("References", 50, 700), item(cite(1), 50, 670)]),
    page([item(cite(2), 50, 700)], 1),
  ];
  const r = extract(pages, { fromPage: 0 });
  assert.deepEqual(numbers(r), [1]);
  assert(r.entries.every((e) => e.anchor.page === 0));
});
test("reciprocal unique folios connect only the target bibliography", () => {
  const r = extract(marked());
  assert.deepEqual(numbers(r), [1, 2, 3, 4]);
  assert(r.entries.every((e) => !e.text.includes("Other")));
  assert(r.selectedRegionIDs[0].endsWith(":continued"));
});
test("manual source page follows a proven forward continuation", () => {
  const r = extract(marked(), { fromPage: 0 });
  assert.deepEqual(numbers(r), [1, 2, 3, 4]);
});
test("manual target page recovers the source segment", () =>
  assert.deepEqual(numbers(extract(marked(), { fromPage: 1 })), [1, 2, 3, 4]));
test("reset target numbers cannot establish continuous ownership", () => {
  const r = regions(marked({ reset: true }));
  assert(r.ambiguous);
  assert(!r.selected.some((s) => s.endsWith(":continued")));
});
test("reversed physical continuation is explicitly unresolved", () => {
  const r = regions(marked({ reverse: true }));
  assert(r.ambiguous);
  assert(!r.selected.some((s) => s.endsWith(":continued")));
});
test("duplicate target folios cannot claim unique ownership", () =>
  assert(regions(marked({ duplicate: true })).ambiguous));
test("current chapter wins over an unrelated earlier continuation", () => {
  const r = extract(marked({ chapter: true }), { fromPage: 2 });
  assert.deepEqual(numbers(r), [1, 2]);
  assert(r.entries.every((e) => e.text.includes("Chapter")));
});
test("separate plain bibliographies remain ambiguous", () => {
  const pages = [
    page([item("References", 50, 700), item(cite(1), 50, 670)]),
    page([item("References", 50, 700), item(cite(1, "Other"), 50, 670)], 1),
  ];
  assert.equal(extract(pages).status, "ambiguous");
  assert.deepEqual(extract(pages).entries, []);
});
test("unnumbered citations never acquire detected numbers", () => {
  const r = extract([
    page([
      item("References", 50, 700),
      item("Smith AB. Study. Journal 2020;12:34-56.", 50, 670),
      item("Jones CD. Review. Journal 2019;13:45-67.", 50, 650),
    ]),
  ]);
  assert.equal(r.entries.length, 2);
  assert(
    r.entries.every(
      (e) => e.printedLabel === undefined && e.printedNumber === undefined,
    ),
  );
});
test("group labels remain separate from multiple publication occurrences", () => {
  const r = extract([
    page([
      item("References to studies included in this review", 50, 740, 440),
      item("Smith 2000 {published data only}", 50, 720),
      item(cite(1), 50, 700),
      item(cite(2), 50, 680),
      item("Jones 2001 {published data only}", 50, 650),
      item(cite(1), 50, 630),
    ]),
  ]);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[0].group, r.entries[1].group);
  assert.notEqual(r.entries[0].group, r.entries[2].group);
});
test("hard tail boundary does not become a final citation", () => {
  const r = extract([
    page([
      item("References", 50, 700),
      item(cite(1), 50, 670),
      item("Acknowledgements", 50, 640),
      item(cite(2), 50, 610),
    ]),
  ]);
  assert.deepEqual(numbers(r), [1]);
});
test("all lines are accounted for and every entry span points to original text", () => {
  const pages = marked();
  const r = extract(pages);
  assert.equal(new Set(r.decisions.map((d) => d.lineID)).size, r.lines.length);
  for (const e of r.entries) {
    assert.equal(e.lineIDs.length, new Set(e.lineIDs).size);
    assert(sourceFragments(pages, e.spans).every((s) => typeof s === "string"));
  }
});
test("unknown, duplicate-page, bad-geometry, empty and budget inputs do not claim success", () => {
  assert.equal(extract(null).status, "unsupported");
  assert.equal(extract([page([], 0), page([], 0)]).status, "unsupported");
  assert.equal(extract([]).status, "unsupported");
  assert.equal(
    extract(Array.from({ length: 501 }, (_, i) => page([], i))).status,
    "limited",
  );
  const bad = extract([page([null, item("broken", NaN, 30)])]);
  assert(bad.diagnostics.some((d) => d.code === "invalid-run-geometry"));
  assert.equal(bad.status, "unsupported");
});
test("source fragment accessor rejects invalid offsets", () =>
  assert.throws(() =>
    sourceFragments(
      [page([item("abc")])],
      [{ page: 0, item: 0, start: 0, end: 4 }],
    ),
  ));
function reader(pages, reads) {
  const app = {
    page: pages.length,
    pdfLoadingTask: { promise: Promise.resolve() },
    pdfViewer: {
      pagesPromise: Promise.resolve(),
      _pages: pages.map((p) => ({
        pdfPage: {
          view: [0, 0, p.width, p.height],
          getTextContent: async () => {
            reads.push(p.page);
            return { items: p.items };
          },
        },
      })),
    },
  };
  return {
    _internalReader: {
      _primaryView: { _iframeWindow: { PDFViewerApplication: app } },
    },
  };
}

test("native-shaped reader reads each original page once and returns raw provenance", async () => {
  const pages = frozen([
    page([
      item("References", 50, 700),
      item(cite(1), 50, 670),
      item(cite(2), 50, 650),
    ]),
  ]);
  const calls = [];
  const r = await read(reader(pages, calls));
  assert.deepEqual(calls, [0]);
  assert.equal(r.refs.length, 2);
  assert.equal(r.extraction.entries.length, 2);
  assert.equal(r.refs[0].page, 0);
  assert.equal(r.refs[0].y, 680);
  assert.equal(r.pages[0].items[1].str, cite(1));
});
test("pre-cancelled reader does not access PDF and does not invoke legacy", async () => {
  const calls = [];
  const r = await read(reader([page([])], calls), { shouldCancel: () => true });
  assert.deepEqual(calls, []);
  assert.deepEqual(r.refs, []);
  assert(r.extraction.diagnostics.some((d) => d.code === "sequence-cancelled"));
});
test("reader failure remains unsupported, not empty successful extraction", async () => {
  const r = await read({});
  assert.equal(r.extraction.status, "unsupported");
  assert(
    r.extraction.diagnostics.some(
      (d) => d.code === "sequence-reader-unavailable",
    ),
  );
});
test("continued page excludes neighbouring upper right column", () => {
  const pages = marked();
  const lines = layout(pages).lines;
  const target = lines.find((l) => l.page === 1 && l.text.includes("上接"));
  const other = {
    ...target,
    id: "upper-right",
    text: cite(2, "Unrelated"),
    x: 330,
    y: 660,
    spans: [],
  };
  const tail = {
    ...target,
    id: "lower-right",
    text: cite(5),
    x: 330,
    y: 540,
    spans: [],
  };
  // A raw column-major stream visits the whole left column before the right.
  lines.push(other, tail);
  const r = select(lines, pages);
  const selected = r.regions.find((x) => r.selected.includes(x.id));
  assert(selected.lines.some((l) => l.id === "lower-right"));
  assert(!selected.lines.some((l) => l.id === "upper-right"));
});
test("orphan back notice is not silently a resolved bibliography", () => {
  const r = extract([marked()[1]]);
  assert.equal(r.status, "ambiguous");
  assert(r.diagnostics.some((d) => d.code === "orphan-back-continuation"));
});
test("heading-free publication sequence remains explicitly unconfirmed", () => {
  const r = extract([
    page([
      item(cite(1), 50, 700),
      item(cite(2), 50, 680),
      item(cite(3), 50, 660),
      item("Unrelated discussion follows.", 50, 640),
    ]),
  ]);
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(numbers(r), [1, 2, 3]);
  assert(r.entries.every((e) => !e.text.includes("Unrelated")));
  assert(
    r.diagnostics.some((d) => d.code === "unheaded-ownership-unconfirmed"),
  );
});
test("numbered body instructions do not become unheaded bibliography", () => {
  const r = extract([
    page([
      item("1. Filter the input genes.", 50, 700),
      item("2. Review the study output.", 50, 680),
      item("3. Save the final results.", 50, 660),
    ]),
  ]);
  assert.deepEqual(r.entries, []);
});
test("gap warning changes extraction status without renumbering", () => {
  const r = extract(
    [
      page([
        item("References", 50, 700),
        item(cite(1), 50, 680),
        item(cite(3), 50, 660),
      ]),
    ],
    { totalPages: 1 },
  );
  assert.deepEqual(numbers(r), [1, 3]);
  assert.equal(r.status, "ambiguous");
});
test("all contiguous supplement sections advance the previous number", () => {
  const r = extract([
    page([
      item("References", 50, 740),
      item(cite(1), 50, 720),
      item("Methods References", 50, 700),
      item(cite(2), 50, 680),
      item("Supplementary References", 50, 660),
      item(cite(3), 50, 640),
    ]),
  ]);
  assert.deepEqual(numbers(r), [1, 2, 3]);
});
test("appendix and manuscript-history tails stop before later body", () => {
  for (const boundary of [
    "A EXPERIMENTS",
    "15. Appendix 1: Schedule",
    "ReceivedJanuary1986;revisedAugust1986.",
    "（收稿日期:2014-12-04）",
    "Characteristics of studies",
  ]) {
    const r = extract([
      page([
        item("References", 50, 700),
        item(cite(1), 50, 680),
        item(boundary, 50, 660),
        item(cite(2), 50, 640),
      ]),
    ]);
    assert.deepEqual(numbers(r), [1], boundary);
  }
});
test("repeated footer copyright is soft noise, not an article boundary", () => {
  const r = extract([
    page([
      item("References", 50, 700),
      item(cite(1), 50, 680),
      item("Copyright © Example", 50, 30),
    ]),
    page([item(cite(2), 50, 700), item("Copyright © Example", 50, 30)], 1),
  ]);
  assert.deepEqual(numbers(r), [1, 2]);
});

test("earlier supplement cannot attach backwards to a later main list", () => {
  const r = extract([
    page([
      item("Supplementary References", 50, 700),
      item(cite(3, "Other"), 50, 680),
      item(cite(4, "Other"), 50, 660),
    ]),
    page(
      [
        item("References", 50, 700),
        item(cite(1), 50, 680),
        item(cite(2), 50, 660),
      ],
      1,
    ),
  ]);
  assert.deepEqual(numbers(r), [1, 2]);
});
test("sequential supplement numbers do not prove shared article ownership", () => {
  const r = extract([
    page([
      item("References", 50, 700),
      item(cite(1), 50, 680),
      item("Acknowledgements", 50, 660),
    ]),
    page(
      [
        item("Different article", 50, 750),
        item("Supplementary References", 50, 700),
        item(cite(2, "Other"), 50, 680),
      ],
      1,
    ),
  ]);
  assert.equal(r.status, "ambiguous");
  assert(
    r.diagnostics.some((d) => d.code === "supplement-ownership-unconfirmed"),
  );
});
test("repeated grouped review headings cannot silently merge owners", () => {
  const heading = "References to studies included in this review";
  const r = extract([
    page([item(heading, 50, 700, 440), item(cite(1), 50, 680)]),
    page([item(heading, 50, 700, 440), item(cite(1, "Other"), 50, 680)], 1),
  ]);
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.entries, []);
  assert(
    r.diagnostics.some((d) => d.code === "repeated-grouped-bibliography-owner"),
  );
});
test("pathological region count stops with an explicit work limit", () => {
  const items = Array.from({ length: 1030 }, (_, i) => [
    item("References", 50, 40000 - i * 30),
    item(cite(1), 50, 39990 - i * 30),
  ]).flat();
  const r = extract([{ ...page(items), height: 42000 }], { totalPages: 1 });
  assert.equal(r.status, "limited");
  assert(r.regions.length <= 1024);
  assert(r.diagnostics.some((d) => d.code === "region-candidate-limit"));
});
test("a skipped over-budget layout page cannot claim complete extraction", () => {
  const r = extract(
    [
      page([item("References", 50, 700), item(cite(1), 50, 680)]),
      page(
        Array.from({ length: 40001 }, () => item("x")),
        1,
      ),
    ],
    { totalPages: 2 },
  );
  assert.equal(r.status, "limited");
  assert(r.coverage.complete);
  assert(r.diagnostics.some((d) => d.code === "layout-page-budget-exceeded"));
});
test("split review section heading cannot leak study tables into the bibliography", () => {
  const p = page([
    item("References", 50, 700),
    item(cite(1), 50, 680),
    item("C H A R A C T E R I S T I C S", 50, 650, 140),
    item("O F S T U D I E S", 220, 650, 100),
    item(
      "Characteristics of included studies [ordered by study ID]",
      50,
      620,
      480,
    ),
    item(cite(2, "Table"), 50, 600),
  ]);
  const r = extract([p]);
  assert.deepEqual(numbers(r), [1]);
  assert(!r.entries[0].text.includes("CHARACTERISTICS"));
});
test("variable page-of-total running header is outside a continued citation", () => {
  const r = extract([
    page([item("References", 50, 700), item(cite(1), 50, 680)]),
    page(
      [
        item("Page 2 of 2", 50, 760),
        item("Appendix", 50, 700),
        item("Study table", 50, 680),
      ],
      1,
    ),
  ]);
  assert.deepEqual(numbers(r), [1]);
  assert(!r.entries[0].text.includes("Page"));
});
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (e) {
    failed++;
    console.error("FAIL " + name, e);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} sequence pipeline regressions passed`,
);
if (failed) process.exitCode = 1;
