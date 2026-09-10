/** Deterministic synthetic PDF text layers; no Zotero profile or PDF corpus. */
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolkit = {
  log() {},
  getDOMParser() {
    throw new Error("No HTML in these fixtures");
  },
};
function compile(relative, imports = {}, extra = "", mapClass = Map) {
  const source = fs.readFileSync(root + relative, "utf8") + extra;
  const code = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;
  const module = { exports: {} };
  new Function(
    "module",
    "exports",
    "require",
    "ztoolkit",
    "Zotero",
    "Map",
    code,
  )(
    module,
    module.exports,
    (name) => {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
    toolkit,
    { Promise: { delay: async () => {} } },
    mapClass,
  );
  return module.exports;
}
const text = compile("src/core/text.ts");
const grouped = compile("src/pdf/groupedReferences.ts");
const groupedStudy = compile("src/pdf/groupedStudyReferences.ts");
const parser = compile(
  "src/pdf/parser.ts",
  {
    "../core/text": text,
    "./groupedReferences": grouped,
    "./groupedStudyReferences": groupedStudy,
    "../utils/prefs": { getPref: () => 4 },
    "../utils/locale": { getString: (key) => key },
  },
  "\nexport { diagnoseNumbering, createIndentMatcher };\n",
);

const item = (str, x, y, height = 10, width = 350) => ({
  str,
  height,
  width,
  transform: [height, 0, 0, height, x, y],
});
const reference = (n) =>
  `${n}. Author${String.fromCharCode(64 + n)} A. Clinical study. Journal. 2020; 1:11–21. doi:10.1000/ref${n}`;
const oneColumn = (count, heading = true) => [
  ...(heading ? [item("References", 100, 670, 10, 100)] : []),
  ...Array.from({ length: count }, (_, i) =>
    item(reference(i + 1), 100, 650 - i * 20),
  ),
];
async function parse(
  pages,
  options = {},
  currentPage = pages.length,
  reads = [],
  annotationReads = [],
) {
  const app = {
    page: currentPage,
    pdfLoadingTask: { promise: Promise.resolve() },
    pdfViewer: {
      pagesPromise: Promise.resolve(),
      _pages: pages.map((items, index) => ({
        pdfPage: {
          _pageInfo: { view: [0, 0, 612, 792] },
          getTextContent: async () => {
            reads.push(index);
            if (items instanceof Error) throw items;
            return { items };
          },
          getAnnotations: async () => {
            annotationReads.push(index);
            return [];
          },
        },
      })),
    },
  };
  return parser.parsePDFReferencesDetailed(
    {
      _internalReader: {
        _primaryView: { _iframeWindow: { PDFViewerApplication: app } },
      },
    },
    options,
  );
}
function linkedBibliography({
  back = 85,
  target = 105,
  forward = true,
  reverse = true,
  duplicateFolio = false,
} = {}) {
  const entry = (n, group = "Target") =>
    `[${n}] Author${String.fromCharCode(64 + n)} A. ${group} bibliography entry. Neutral Journal. ${n % 2 ? "1986" : "2024"}; 12:34–56.`;
  const source = [
    item("Background paragraph from the selected article.", 50, 680, 10, 225),
    item("参考文献", 385, 730, 10, 110),
    ...Array.from({ length: 14 }, (_, i) =>
      item(entry(i + 1), 320, 700 - i * 44, 10, 220),
    ),
    ...(forward ? [item(`(下转第 ${target} 页)`, 450, 90, 10, 85)] : []),
    // Deliberately reverse the stream order of the printed page digits.
    item("5", 548, 770, 10, 5),
    item("8", 543, 770, 10, 5),
  ];
  const tail = [
    item("References", 60, 735, 10, 100),
    ...Array.from({ length: 10 }, (_, i) =>
      item(
        entry(i + 1, "Neighbour"),
        i < 5 ? 50 : 330,
        710 - (i % 5) * 50,
        10,
        225,
      ),
    ),
    ...(reverse ? [item(`(上接第 ${back} 页)`, 50, 405, 10, 110)] : []),
    item(entry(15), 50, 385, 10, 225),
    item(entry(16), 50, 345, 10, 225),
    item(entry(17), 50, 305, 10, 225),
    item(
      "[18] AuthorR A. A neutral title whose citation wraps",
      50,
      265,
      10,
      225,
    ),
    item(
      "across columns and continues with its publication details.",
      62,
      249,
      10,
      213,
    ),
    item("Neutral Journal. 2014; 35(5):681–690.", 330, 405.8, 10, 225),
    item(entry(19), 330, 370, 10, 225),
    item(entry(20), 330, 330, 10, 225),
    item("5", 550, 770, 10, 5),
    item("0", 545, 770, 10, 5),
    item("1", 540, 770, 10, 5),
  ];
  const pages = [
    [item("Opening body paragraph.", 80, 650)],
    [item("More body text.", 80, 650)],
    [item("Another body paragraph.", 80, 650)],
    source,
    tail,
  ];
  if (duplicateFolio)
    pages.push([
      item("Different document page.", 80, 650),
      item("105", 520, 770, 10, 20),
    ]);
  return pages;
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
await check("detailed and legacy routes preserve identical refs", async () => {
  const pages = [oneColumn(6)];
  const detailed = await parse(pages);
  const plain = await parser.parsePDFReferences({
    _internalReader: {
      _primaryView: {
        _iframeWindow: {
          PDFViewerApplication: {
            page: 1,
            pdfLoadingTask: { promise: Promise.resolve() },
            pdfViewer: {
              pagesPromise: Promise.resolve(),
              _pages: [
                {
                  pdfPage: {
                    _pageInfo: { view: [0, 0, 612, 792] },
                    getTextContent: async () => ({ items: pages[0] }),
                    getAnnotations: async () => [],
                  },
                },
              ],
            },
          },
        },
      },
    },
  });
  assert.deepEqual(detailed.refs, plain);
  assert.equal(detailed.diagnostics.status, "extracted");
  assert.equal(detailed.diagnostics.completeness, "not-assessed");
  assert.deepEqual(
    detailed.diagnostics.entries.map((e) => e.printedNumber),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(detailed.diagnostics.numbering.consecutive, true);
  assert.equal(detailed.diagnostics.pageCount, 1);
  assert.equal(detailed.diagnostics.searchEndPage, 0);
});
await check(
  "unnumbered bibliography has no fabricated printed numbers",
  async () => {
    const pages = [
      [
        item("References", 100, 700),
        ...[
          "Smith A. First study. Journal. 2020;1:1-9.",
          "Jones B. Second study. Journal. 2021;2:10-19.",
          "Walker C. Third study. Journal. 2022;3:20-29.",
        ].map((t, i) => item(t, 100, 670 - i * 30)),
      ],
    ];
    const result = await parse(pages);
    assert.equal(result.refs.length, 3);
    assert.deepEqual(
      result.refs.map((r) => r.number),
      [1, 2, 3],
    );
    assert.deepEqual(
      result.diagnostics.entries.map((e) => e.printedNumber),
      [null, null, null],
    );
    assert.equal(result.diagnostics.numbering.kind, "unnumbered");
    assert.equal(result.diagnostics.numbering.consecutive, null);
  },
);
await check("single missing printed label remains a gap", async () => {
  const pages = [oneColumn(6).filter((i) => !i.str.startsWith("3."))];
  const result = await parse(pages);
  assert.deepEqual(
    result.diagnostics.entries.map((e) => e.printedNumber),
    [1, 2, 4, 5, 6],
  );
  assert.deepEqual(result.diagnostics.numbering.missing, [3]);
  assert.ok(result.diagnostics.warnings.includes("printed-number-gap"));
});
await check(
  "empty text is distinct from unavailable reader and parse error",
  async () => {
    assert.equal((await parse([[]])).diagnostics.status, "not-found");
    assert.equal(
      (await parser.parsePDFReferencesDetailed(null)).diagnostics.status,
      "unavailable",
    );
    const failed = await parse([new Error("Synthetic read failure")]);
    assert.equal(failed.diagnostics.status, "error");
    assert.deepEqual(failed.refs, []);
  },
);
await check(
  "full continuation and manual source retain source observations",
  async () => {
    for (const options of [{}, { fromCurrentPage: true }]) {
      const result = await parse(
        linkedBibliography(),
        options,
        options.fromCurrentPage ? 4 : 5,
      );
      assert.equal(result.refs.length, 20);
      assert.equal(result.diagnostics.status, "extracted");
      assert.deepEqual(
        result.diagnostics.entries.map((e) => e.printedNumber),
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      assert.ok(
        result.diagnostics.entries.every(
          (e) => e.sourceStart.page === (e.printedNumber <= 14 ? 3 : 4),
        ),
      );
    }
  },
);
await check(
  "unverified forward target reports partial, preserving known refs",
  async () => {
    const result = await parse(linkedBibliography({ back: 84 }));
    assert.equal(result.refs.length, 14);
    assert.equal(result.diagnostics.status, "partial");
    assert.ok(
      result.diagnostics.warnings.includes("continuation-target-unverified"),
    );
  },
);
await check(
  "ambiguous source is distinct from ordinary empty output",
  async () => {
    const pages = linkedBibliography({ forward: false });
    const result = await parse(pages);
    assert.deepEqual(result.refs, []);
    assert.equal(result.diagnostics.status, "ambiguous");
  },
);
await check("diagnostic invocations never share mutable state", async () => {
  const first = await parse([oneColumn(3)]);
  first.diagnostics.entries[0].printedNumber = 99;
  first.diagnostics.warnings.push("changed");
  const second = await parse([oneColumn(3)]);
  assert.equal(second.diagnostics.entries[0].printedNumber, 1);
  assert.deepEqual(second.diagnostics.warnings, []);
});
await check(
  "duplicate and mixed numbering observations are not renumbered",
  () => {
    const entries = [1, 2, null, 2, 4].map((n, i) => ({
      printedNumber: n,
      ordinal: i + 1,
      displayNumber: i + 1,
      sourceStart: { page: 0, x: 0, y: 0 },
    }));
    const result = parser.diagnoseNumbering(entries);
    assert.equal(result.kind, "mixed");
    assert.deepEqual(result.duplicates, [2]);
    assert.deepEqual(result.missing, [3]);
    assert.equal(result.consecutive, false);
  },
);

await check(
  "indexed indentation preserves the original existence decision",
  () => {
    let seed = 739391;
    const rand = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const xs = [
      0,
      -0,
      1e-300,
      -1e-300,
      NaN,
      Infinity,
      -Infinity,
      1e20,
      -1e20,
      ...Array.from(
        { length: 600 },
        () => Math.round((rand() - 0.5) * 1200 * 10) / 10,
      ),
    ];
    const lines = xs.map((x, i) => ({
      x,
      height: [0, -1, NaN, Infinity, 1e-300, 10, 7.25][i % 7],
    }));
    for (const indent of [
      -20,
      20,
      -7.25,
      7.25,
      -1e-300,
      1e-300,
      0,
      Infinity,
      NaN,
    ]) {
      const indexed = parser.createIndentMatcher(lines, indent);
      for (const line of lines) {
        const old = lines.some(
          (other) =>
            other !== line &&
            (line.x - other.x) * indent > 0 &&
            Math.abs(line.x - other.x) >= Math.abs(indent) &&
            Math.abs(Math.abs(line.x - other.x) - Math.abs(indent)) <
              2 * line.height,
        );
        assert.equal(
          indexed(line),
          old,
          `indent=${indent}, x=${line.x}, height=${line.height}`,
        );
      }
    }
  },
);
await check(
  "grouped sequence attribution maps each selected line exactly once",
  async () => {
    const row = (text, x, y, height = 8) => item(text, x, y, height, 210);
    const group = (name, x, y) => [
      row(`${name} 2020 {published data only}`, x, y),
      row(`${name} A, Writer B. Neutral publication.`, x + 16, y - 12),
      row("Journal 2020;1:11–21.", x + 16, y - 24),
    ];
    const pages = [
      [
        row("References", 50, 720),
        row("References to studies included in this review", 50, 700),
        ...group("Alpha", 50, 680),
        row("Beta B, Writer C. Another publication.", 66, 640),
        row("Journal 2020;2:31–41.", 66, 628),
      ],
      [
        ...group("Bravo", 50, 720),
        ...group("Charlie", 50, 650),
        ...group("Delta", 50, 580),
        row("References to ongoing studies", 50, 510),
        ...group("Echo", 50, 490),
        row("Additional references", 320, 700),
        ...group("Foxtrot", 320, 675),
      ],
      [
        row("CHARACTERISTICS OF STUDIES", 50, 720, 10),
        row(
          "Characteristics of included studies [ordered by study ID]",
          50,
          685,
          10,
        ),
        row("Neutral 2020", 50, 660),
        item("Methods", 50, 630, 8, 60),
        item("Random allocation", 220, 630, 8, 160),
        item("Participants", 50, 610, 8, 60),
        item("Adult participants", 220, 610, 8, 160),
      ],
    ];
    const result = await parse(pages);
    assert.equal(result.refs.length, 7);
    assert.equal(result.diagnostics.segmentation.strategy, "grouped-study");
    assert.equal(result.diagnostics.completeness, "not-assessed");
    assert.equal(result.diagnostics.numbering.kind, "unnumbered");
    const trace = result.diagnostics.segmentation;
    assert.deepEqual(
      trace.decisions.map((d) => d.lineIndex),
      Array.from({ length: trace.sourceLineCount }, (_, i) => i),
    );
    assert.equal(trace.entries.length, 7);
    const owned = trace.entries.flatMap((e) => e.lineIndices);
    const body = trace.decisions
      .filter((d) => d.label === "B" || d.label === "I")
      .map((d) => d.lineIndex);
    assert.deepEqual(owned, body);
    assert.equal(new Set(owned).size, owned.length);
    for (let i = 0; i < result.refs.length; i++) {
      const line = trace.sourceLines[trace.entries[i].lineIndices[0]];
      assert.equal(result.refs[i].x, line.x);
      assert.equal(result.refs[i].page, line.page);
      assert.ok(!result.refs[i].text.includes("{published"));
    }
    assert.deepEqual(
      result.refs.map((r) => r.text.split(" ")[0]),
      ["Alpha", "Beta", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"],
    );
  },
);

console.log(`Passed ${passed} legacy diagnostic/index checks.`);
