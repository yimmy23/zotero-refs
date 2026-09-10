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
  "\nexport { mergeSameLine, mergeSameRef, mergeNumberedRefs, numAtStart, findLineNumbers, restoreNumberedColumnOrder, readPdfPage, restoreGutterNumberItems, hasLineNumbers, updateItemsAnnotions };\n",
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
  return parser.parsePDFReferences(
    {
      _internalReader: {
        _primaryView: { _iframeWindow: { PDFViewerApplication: app } },
      },
    },
    options,
  );
}
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
function expectRefs(refs, count) {
  assert.equal(refs.length, count);
  assert.deepEqual(
    refs.map((ref) => ref.number),
    Array.from({ length: count }, (_, i) => i + 1),
  );
}

await check("standard heading bibliography", async () =>
  expectRefs(await parse([oneColumn(6)]), 6),
);
await check("unbroken no-heading block is committed", async () =>
  expectRefs(await parse([oneColumn(3, false)]), 3),
);
await check("no-heading numbered table still fails year gate", async () => {
  assert.equal(
    (
      await parse([
        [1, 2, 3].map((n) =>
          item(`${n}. Group ${n}: sample size thirty`, 100, 650 - n * 20),
        ),
      ])
    ).length,
    0,
  );
});
await check("dated no-heading tables require citation syntax", async () => {
  const label = (n) =>
    `${n}. Treatment group: enrollment year 2020, sample size thirty.`;
  assert.equal(
    (await parse([[1, 2, 3].map((n) => item(label(n), 100, 650 - n * 20))]))
      .length,
    0,
  );
  const twoColumns = [];
  for (let i = 0; i < 3; i++)
    twoColumns.push(
      item(label(i + 1), 50, 650 - i * 30, 10, 240),
      item(label(i + 4), 330, 650 - i * 30, 10, 240),
    );
  assert.equal((await parse([twoColumns])).length, 0);
});
await check(
  "dated allocation ratios are not citation volume/page evidence",
  async () => {
    const rows = [1, 2, 3].map((n) =>
      item(
        `${n}. Treatment cohort enrolled in 2020; allocation ratio 1:1.`,
        100,
        650 - n * 20,
      ),
    );
    assert.equal((await parse([rows])).length, 0);
    const single = item(
      "7. Treatment cohort in 2020. Allocation ratio 1:1. Age range 18–65.",
      100,
      650,
      14,
    );
    expectRefs(await parse([oneColumn(6), [single]]), 6);
  },
);
for (const title of [
  "Supplementary oxygen for pneumonia.",
  "Funding mechanisms for research.",
  "Correspondence analysis of outcomes.",
  "Abbreviations in medicine.",
]) {
  await check(`wrapped title: ${title}`, async () => {
    const refs = await parse([
      [
        item("References", 100, 670),
        item(reference(1), 100, 650),
        item("2. AuthorB B.", 100, 630),
        item(title, 100, 610),
        item("Journal. 2021; 2:22–32.", 100, 590),
        item(reference(3), 100, 570),
      ],
    ]);
    expectRefs(refs, 3);
    assert.ok(refs[1].text.includes(title));
    assert.ok(refs[1].text.includes("2021"));
  });
}
await check(
  "completed entry still excludes acknowledgements and copyright",
  async () => {
    const refs = await parse([
      [
        ...oneColumn(3),
        item("Acknowledgements", 100, 590),
        item("We thank the investigators.", 100, 570),
        item("© 2020 The authors", 100, 550),
      ],
    ]);
    expectRefs(refs, 3);
    assert.ok(
      refs.every((ref) => !/Acknowledg|investigators|©/.test(ref.text)),
    );
  },
);
await check(
  "year-ending book citation does not swallow acknowledgements",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 670),
        item(reference(1), 100, 650),
        item(reference(2), 100, 630),
        item(
          "3. World Health Organization. Clinical research methods. Geneva: WHO; 2020.",
          100,
          610,
        ),
        item("Acknowledgements", 100, 590),
        item("We thank the investigators.", 100, 570),
      ],
    ]);
    expectRefs(refs, 3);
    assert.ok(refs[2].text.endsWith("2020."));
    assert.ok(!refs[2].text.includes("Acknowledgements"));
  },
);
for (const rowMajor of [true, false]) {
  for (const multiline of [true, false]) {
    await check(
      `${rowMajor ? "row" : "column"}-major two columns${multiline ? " with wraps" : ""}`,
      async () => {
        const entries = (n, x, y) =>
          multiline
            ? [
                item(
                  `${n}. Author${String.fromCharCode(64 + n)} A. Clinical study.`,
                  x,
                  y,
                  10,
                  240,
                ),
                item(
                  `Journal. 2020; 1:11–21. doi:10.1000/ref${n}`,
                  x,
                  y - 12,
                  10,
                  240,
                ),
              ]
            : [item(reference(n), x, y, 10, 240)];
        let items = [item("References", 50, 675, 10, 100)];
        if (rowMajor) {
          for (let i = 0; i < 3; i++) {
            const left = entries(i + 1, 50, 650 - i * 40),
              right = entries(i + 4, 330, 650 - i * 40);
            for (let j = 0; j < left.length; j++) items.push(left[j], right[j]);
          }
        } else {
          for (const col of [0, 1])
            for (let i = 0; i < 3; i++)
              items.push(
                ...entries(i + 1 + col * 3, col ? 330 : 50, 650 - i * 40),
              );
        }
        const refs = await parse([items]);
        expectRefs(refs, 6);
        for (let i = 0; i < refs.length; i++) {
          assert.equal(refs[i].identifiers.DOI, `10.1000/ref${i + 1}`);
          assert.equal(
            (refs[i].text.match(/10\.1000\//g) || []).length,
            1,
            "No cross-column DOI joins",
          );
        }
      },
    );
  }
}
await check("widely separated unnumbered columns never join", () => {
  assert.equal(
    parser.mergeSameLine([
      item("Left column", 50, 650, 10, 240),
      item("Right column", 330, 650, 10, 240),
    ]).length,
    2,
  );
});
await check("superscripts retain same-line merge", () => {
  assert.equal(
    parser.mergeSameLine([
      item("Author", 50, 650, 10, 50),
      item("2", 100, 656, 6, 4),
      item("Study", 105, 650, 10, 80),
    ]).length,
    1,
  );
});
await check(
  "close leading does not merge two adjacent full-height lines",
  () => {
    const lines = parser.mergeSameLine([
      item("Synthetic wrapped citation ends here.", 74, 154.9, 10, 220),
      item("Beta B. (1981). Separate synthetic book.", 56, 145.2, 10, 350),
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].text, "Synthetic wrapped citation ends here.");
    assert.match(lines[1].text, /^Beta B/);
  },
);
await check(
  "unnumbered hanging references preserve book and article boundaries",
  async () => {
    const items = [
      item("References", 220, 180, 10, 90),
      item(
        "Alpha, A. (1984). Synthetic methods with matched",
        56,
        165.1,
        10,
        392,
      ),
      item("controls. Synthetic Journal 40, 1005-1015.", 74, 154.9, 10, 220),
      item(
        "Beta, B. (1981). Synthetic statistical handbook. New York: Example Press.",
        56,
        145.2,
        10,
        395,
      ),
      item(
        "Gamma, C. (1968). Synthetic designs. Synthetic Journal",
        56,
        135.1,
        10,
        393,
      ),
      item("24, 339-352.", 74, 125.1, 10, 70),
      item(
        "Delta, D. (1980). Synthetic second handbook. City:",
        56,
        115.1,
        10,
        390,
      ),
      item("Example University Press.", 74, 105.1, 10, 130),
      item("Received January 1986; revised August 1986.", 163, 80.4, 10, 179),
    ];
    const refs = await parse([
      items,
      [
        item("Synthetic running head", 175, 710, 10, 160),
        item("APPENDIX", 220, 685, 8, 50),
        item("Consider synthetic conditional probabilities.", 56, 660, 10, 395),
        item(
          "Then let the synthetic function be defined as follows.",
          56,
          645,
          10,
          395,
        ),
        item("Covariance = alpha + beta.", 56, 630, 10, 220),
      ],
    ]);
    expectRefs(refs, 4);
    assert.match(refs[0].text, /matched controls\./);
    assert.match(refs[0].text, /1005-1015\.$/);
    assert.match(refs[1].text, /^Beta, B\./);
    assert.match(refs[1].text, /Example Press\.$/);
    assert.match(refs[2].text, /339-352\.$/);
    assert.match(refs[3].text, /Example University Press\.$/);
    assert.ok(refs.every((ref) => ref.page === 0));
    assert.ok(
      refs.every(
        (ref) => !/Received|APPENDIX|Covariance|conditional/i.test(ref.text),
      ),
    );
  },
);
await check(
  "unnumbered merge stops at an appendix even without publication history",
  () => {
    const lines = [
      ...["Alpha", "Beta", "Gamma"].map((name, i) => ({
        text: `${name}, A. (1980). Synthetic title. Journal 1, 10-20.`,
        x: 0,
        y: 650 - 15 * i,
        height: 10,
        width: 350,
        _height: [10],
        pageNum: 0,
      })),
      {
        text: "APPENDIX",
        x: 160,
        y: 710,
        height: 10,
        width: 60,
        _height: [10],
        pageNum: 1,
      },
      {
        text: "Consider a synthetic equation.",
        x: 0,
        y: 690,
        height: 10,
        width: 350,
        _height: [10],
        pageNum: 1,
      },
    ];
    const refs = parser.mergeSameRef(lines);
    assert.equal(refs.length, 3);
    assert.ok(refs.every((ref) => !/APPENDIX|equation/.test(ref.text)));
  },
);
await check(
  "unnumbered dated references still continue onto another page",
  async () => {
    const entries = (offset) =>
      ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]
        .slice(offset, offset + 3)
        .map((name, i) =>
          item(
            `${name}${offset}, A. (1980). Synthetic title ${i + offset}. Journal 1, 10-20.`,
            100,
            650 - i * 20,
            10,
            350,
          ),
        );
    const refs = await parse([
      [item("References", 100, 680, 10, 80), ...entries(0)],
      entries(3),
    ]);
    expectRefs(refs, 6);
    assert.match(refs[3].text, /^Delta3/);
    assert.match(refs[5].text, /^Zeta3/);
  },
);
await check(
  "spaceless publication-history dates cannot attach to an unnumbered book",
  () => {
    const lines = [
      ...["Alpha", "Beta", "Gamma"].map((name, i) => ({
        text: `${name}, A. (1980). Synthetic handbook. Example Press.`,
        x: 0,
        y: 650 - 15 * i,
        height: 10,
        width: 350,
        _height: [10],
        pageNum: 0,
      })),
      {
        text: "ReceivedJanuary 1986;revisedAugust 1986.",
        x: 100,
        y: 590,
        height: 10,
        width: 180,
        _height: [10],
        pageNum: 0,
      },
      {
        text: "Synthetic next-page header",
        x: 0,
        y: 710,
        height: 10,
        width: 250,
        _height: [10],
        pageNum: 1,
      },
    ];
    const refs = parser.mergeSameRef(lines);
    assert.equal(refs.length, 3);
    assert.match(refs[2].text, /Example Press\.$/);
    assert.ok(refs.every((ref) => !/Received|header/.test(ref.text)));
  },
);
await check(
  "citation-type brackets retain the final entry's publication metadata",
  async () => {
    for (const marker of ["[J]", "[M]", "[C]", "[EB/OL]"]) {
      const refs = await parse([
        [
          item("References", 100, 690, 10, 80),
          item(reference(1), 100, 670),
          item(reference(2), 100, 650),
          item(`3. Gamma A. Synthetic title${marker}.`, 100, 630),
          item(
            "J Synthetic Methods, 2020, 11(9):1433‐1446. DOI: 10.1000/",
            115,
            615,
          ),
          item("synthetic.2020.028.", 115, 600),
        ],
      ]);
      expectRefs(refs, 3);
      assert.match(refs[2].text, /J Synthetic Methods/);
      assert.equal(refs[2].identifiers.DOI, "10.1000/synthetic.2020.028");
    }
  },
);
await check(
  "completed last numbered entry excludes a numeric next-page running head",
  () => {
    const lines = [
      ...[1, 2, 3].map((n) => ({
        text: reference(n),
        x: 0,
        y: 150 - 15 * n,
        height: 10,
        width: 350,
        _height: [10],
        pageNum: 0,
      })),
      {
        text: "622 SYNTHETIC STUDY GROUP",
        x: 0,
        y: 760,
        height: 10,
        width: 220,
        _height: [10],
        pageNum: 1,
      },
      {
        text: "A RUNNING TITLE",
        x: 20,
        y: 746,
        height: 10,
        width: 220,
        _height: [10],
        pageNum: 1,
      },
    ];
    const refs = parser.mergeNumberedRefs(lines);
    assert.equal(refs.length, 3);
    assert.equal(refs[2].text, reference(3));
  },
);
await check(
  "explicit DOI addenda and incomplete final citations can cross a page",
  () => {
    const prefix = [1, 2].map((n) => ({
      text: reference(n),
      x: 0,
      y: 180 - 15 * n,
      height: 10,
      width: 350,
      _height: [10],
      pageNum: 0,
    }));
    for (const complete of [true, false]) {
      const last = complete
        ? "3. Gamma A. Synthetic title. Journal. 2020; 1:10-20."
        : "3. Gamma A. Synthetic title. Journal.";
      const tail = complete ? "doi:10.1000/final" : "2020; 1:10-20.";
      const refs = parser.mergeNumberedRefs([
        ...prefix,
        {
          text: last,
          x: 0,
          y: 130,
          height: 10,
          width: 350,
          _height: [10],
          pageNum: 0,
        },
        {
          text: tail,
          x: 0,
          y: 650,
          height: 10,
          width: 250,
          _height: [10],
          pageNum: 1,
        },
      ]);
      assert.equal(refs.length, 3);
      assert.equal(refs[2].text, `${last} ${tail}`);
    }
  },
);
await check("separate margin reference numbers remain attached", async () => {
  const items = [item("References", 50, 675, 10, 100)];
  for (let i = 0; i < 3; i++)
    items.push(
      item(String(i + 1), 50, 651 - i * 30, 8, 5),
      item(reference(i + 1).replace(/^\d+\. /, ""), 65, 650 - i * 30, 10, 300),
    );
  expectRefs(await parse([items]), 3);
});
for (const wrapped of [true, false]) {
  await check(
    `single final continuation ${wrapped ? "wrapped" : "one line"}`,
    async () => {
      const last = wrapped
        ? [
            item("7. AuthorG A. Final study.", 100, 650, 14),
            item("Journal of Medicine.", 100, 630, 14),
            item("2020; 14:10–20.", 100, 610, 14),
          ]
        : [item(reference(7), 100, 650, 14)];
      expectRefs(await parse([oneColumn(6), last]), 7);
    },
  );
}
await check("single continuation requires year and next number", async () => {
  for (const str of [
    "7. An unrelated numbered statement. 1:11–21.",
    "7. Treatment cohort in 2020. Age range 18–65.",
    reference(8),
  ]) {
    expectRefs(await parse([oneColumn(6), [item(str, 100, 650, 14)]]), 6);
  }
});
await check("ambiguous column sequences retain stream order", () => {
  for (const sequence of [
    [1, 4, 2, 1],
    [1, 5, 2, 6],
  ]) {
    const lines = sequence.map((n, i) => ({
      text: reference(n),
      x: i % 2 ? 330 : 50,
      y: 650 - Math.floor(i / 2) * 20,
      width: 240,
      height: 10,
      _height: [10],
    }));
    assert.equal(parser.restoreNumberedColumnOrder(lines), lines);
  }
});
await check("number classifier rejects years, DOI and table fragments", () => {
  for (const str of [
    "2020 Study",
    "10.1000/ref1",
    "41 , 1103",
    "25 (12%)",
    "1 7 insight.jci.org",
  ])
    assert.equal(parser.numAtStart(str), 0, str);
  for (const str of [
    "12. Author",
    "12) Author",
    "[12] Author",
    "(12) Author",
    "12 Author",
    "1 2 . Author",
  ])
    assert.equal(parser.numAtStart(str), 12, str);
});
await check(
  "manuscript margin numbers distinguished from sparse entry numbers",
  () => {
    const body = [];
    for (let i = 0; i < 10; i++)
      body.push(
        item(String(101 + i), 20, 700 - i * 15, 10, 15),
        item("A line of manuscript body text", 60, 700 - i * 15, 10, 400),
      );
    assert.equal(parser.findLineNumbers(body).size, 10);
    assert.equal(
      parser.findLineNumbers(
        body.filter((it) => it.width !== 15 || Number(it.str) % 3 === 0),
      ).size,
      0,
    );
  },
);

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

for (const [name, options, page] of [
  ["automatic", {}, 5],
  ["manual source", { fromCurrentPage: true }, 4],
  ["manual continuation", { fromCurrentPage: true }, 5],
])
  await check(`verified cross-article continuation ${name}`, async () => {
    const refs = await parse(linkedBibliography(), options, page);
    expectRefs(refs, 20);
    assert.ok(refs.every((ref) => !ref.text.includes("Neighbour")));
    assert.deepEqual(
      refs.map((ref) => ref.page),
      [...Array(14).fill(3), ...Array(6).fill(4)],
    );
    assert.equal(refs[17].x, 50);
    assert.equal(refs[17].y, 275);
    assert.ok(refs[17].text.includes("continues with its publication details"));
    assert.ok(refs[17].text.includes("35(5):681–690"));
  });

for (const [name, fixture] of [
  ["missing back marker", { reverse: false }],
  ["conflicting back folio", { back: 86 }],
  ["missing target folio", { target: 106 }],
  ["duplicate target folio", { duplicateFolio: true }],
])
  await check(
    `uncorroborated continuation retains only known source: ${name}`,
    async () => {
      const refs = await parse(linkedBibliography(fixture));
      expectRefs(refs, 14);
      assert.ok(
        refs.every((ref) => ref.page === 3 && !ref.text.includes("Neighbour")),
      );
    },
  );

await check(
  "back marker without a confirmable source never selects neighbour references",
  async () => {
    assert.equal(
      (await parse(linkedBibliography({ forward: false }))).length,
      0,
    );
  },
);

await check(
  "a cyclic or multiply marked target does not expand the verified source",
  async () => {
    const pages = linkedBibliography();
    pages[4].push(item("(下转第85页)", 450, 280, 10, 85));
    expectRefs(await parse(pages), 14);
    const duplicateBack = linkedBibliography();
    duplicateBack[4].push(item("(上接第85页)", 50, 425, 10, 110));
    expectRefs(await parse(duplicateBack), 14);
  },
);

await check(
  "a second article below the marker cannot pass by sharing a next reference number",
  async () => {
    const pages = linkedBibliography();
    pages[4].push(
      item(
        "[1] Other B. Independent article. Journal. 2020; 3:10–20.",
        330,
        280,
        10,
        225,
      ),
    );
    expectRefs(await parse(pages), 14);
  },
);

await check(
  "ordinary manual chapter boundaries do not append later bibliographies",
  async () => {
    const pages = [
      [item("Earlier chapter body.", 70, 650)],
      oneColumn(8),
      oneColumn(10),
    ];
    expectRefs(await parse(pages, { fromCurrentPage: true }, 2), 8);
  },
);

await check(
  "margin folios restore digit geometry without changing reference text",
  async () => {
    const items = [
      item("5", 548, 770, 10, 5),
      item("8", 543, 770, 10, 5),
      item("1", 120, 600, 10, 5),
      item("2", 125, 600, 10, 5),
    ];
    const lines = await parser.readPdfPage({
      _pageInfo: { view: [0, 0, 612, 792] },
      getTextContent: async () => ({ items }),
      getAnnotations: async () => [],
    });
    assert.equal(lines[0].text, "5 8");
    assert.equal(lines[0]._folio, 85);
    assert.equal(lines[1].text, "1 2");
    assert.equal(lines[1]._folio, undefined);
  },
);

await check(
  "continuation lookup has a finite shared page-read budget",
  async () => {
    const pages = linkedBibliography();
    for (let i = 0; i < 100; i++)
      pages.push([item(`Body content ${i}.`, 70, 600)]);
    const reads = [];
    const annotations = [];
    const refs = await parse(
      pages,
      { fromCurrentPage: true },
      4,
      reads,
      annotations,
    );
    expectRefs(refs, 14);
    assert.ok(
      new Set(reads).size <= 4 + 64 + 5,
      "64 extra pages plus existing line-number probes/preload",
    );
    assert.equal(annotations.length, 68);
    assert.equal(new Set(annotations).size, annotations.length);
    assert.ok(refs.every((ref) => !ref.text.includes("Neighbour")));
  },
);

await check(
  "marked full-width spaced numbering preserves citation typography",
  async () => {
    const pages = linkedBibliography();
    for (const page of pages)
      for (const line of page)
        line.str = line.str
          .replace(/^\[(\d+)\]/, "［ $1 ］")
          .replace("; 12:34–56.", "， 44 ( 2 ) : 122- 126．");
    const refs = await parse(pages);
    expectRefs(refs, 20);
    assert.ok(refs[0].text.includes("44 ( 2 ) : 122- 126．"));
    assert.ok(refs[17].text.includes("35(5):681–690"));
  },
);

await check(
  "ordinary body continuation notices do not replace or scan a bibliography",
  async () => {
    const pages = [
      [
        item("1. Step one: prepare the document.", 80, 200),
        item("2. Step two: check the page settings.", 80, 170),
        item("(下转第105页)", 80, 130, 10, 100),
      ],
      [item("Body text.", 80, 650)],
      oneColumn(6),
      [item("Future body text.", 80, 640)],
    ];
    const plain = pages.map((page) =>
      page.filter((line) => !line.str.includes("下转")),
    );
    for (const options of [{}, { fromCurrentPage: true }]) {
      const reads = [],
        plainReads = [],
        annotations = [],
        plainAnnotations = [];
      const refs = await parse(pages, options, 3, reads, annotations);
      expectRefs(refs, 6);
      const expected = await parse(
        plain,
        options,
        3,
        plainReads,
        plainAnnotations,
      );
      assert.deepEqual(refs, expected);
      assert.deepEqual(reads, plainReads);
      assert.deepEqual(annotations, plainAnnotations);
    }
  },
);

await check(
  "a body notice in the other column cannot truncate a bibliography",
  async () => {
    const bibliography = [
      item("References", 50, 670, 10, 100),
      ...Array.from({ length: 6 }, (_, i) =>
        item(reference(i + 1), 50, 650 - i * 20, 10, 225),
      ),
      item("(下转第105页)", 400, 590, 10, 100),
    ];
    const pages = [
      [item("Earlier body.", 60, 650)],
      [item("Continued body.", 60, 650)],
      bibliography,
    ];
    for (const options of [{}, { fromCurrentPage: true }]) {
      const refs = await parse(pages, options);
      expectRefs(refs, 6);
      assert.ok(refs.every((ref) => !ref.text.includes("下转")));
    }
  },
);

await check(
  "a later independent manual chapter takes precedence over cached old markers",
  async () => {
    const pages = linkedBibliography();
    pages.push(oneColumn(6));
    const refs = await parse(pages, { fromCurrentPage: true }, 6);
    expectRefs(refs, 6);
    assert.ok(refs.every((ref) => ref.page === 5));
  },
);

await check(
  "an unreadable extra page cannot discard the known local source",
  async () => {
    const pages = linkedBibliography();
    pages.push(new Error("Synthetic unreadable extra page"));
    const refs = await parse(pages, { fromCurrentPage: true }, 4);
    expectRefs(refs, 14);
    assert.ok(refs.every((ref) => ref.page === 3));
  },
);

await check(
  "conflicting folios on the target page do not prove a continuation",
  async () => {
    const pages = linkedBibliography();
    pages[4].push(item("110", 80, 40, 10, 20));
    expectRefs(await parse(pages, { fromCurrentPage: true }, 4), 14);
  },
);

const numberedPrefixVariants = [
  ["dot", (n) => `${n}.`],
  ["ASCII square", (n) => `[${n}]`],
  ["ASCII round", (n) => `(${n})`],
  ["spaced square", (n) => `[ ${n} ]`],
  ["full-width square", (n) => `［ ${n} ］`],
  ["full-width round", (n) => `（ ${n} ）`],
  [
    "full-width digits",
    (n) =>
      `［ ${String(n).replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)))} ］`,
  ],
  ["separate digit glyphs", (n) => `[ ${String(n).split("").join(" ")} ]`],
];

for (const [name, prefix] of numberedPrefixVariants) {
  await check(
    `repeated continuation heading retains the earlier page: ${name}`,
    async () => {
      const pages = [0, 1].map((page) => [
        item("References", 100, page ? 720 : 670, 10, 100),
        ...Array.from({ length: 6 }, (_, i) => {
          const n = page * 6 + i + 1;
          return item(
            reference(n).replace(/^\d+\./, prefix(n)),
            100,
            (page ? 700 : 650) - i * 24,
            page ? 12 : 10,
          );
        }),
      ]);
      const refs = await parse(pages);
      expectRefs(refs, 12);
      assert.deepEqual(
        refs.map((ref) => ref.page),
        [...Array(6).fill(0), ...Array(6).fill(1)],
      );
      expectRefs(await parse(pages, { fromCurrentPage: true }, 1), 6);
    },
  );
  await check(
    `row-major columns share number semantics without changing typography: ${name}`,
    async () => {
      const entries = [item("References", 50, 700, 10, 100)];
      for (let row = 0; row < 3; row++) {
        for (const column of [0, 1]) {
          const n = row + 1 + column * 3;
          entries.push(
            item(
              `${prefix(n)} Author${n} A. Study ［Ａ］ and （ 2 ）. Journal. 2020; 1:11–21.`,
              column ? 330 : 50,
              670 - row * 30,
              10,
              225,
            ),
          );
        }
      }
      const refs = await parse([entries]);
      expectRefs(refs, 6);
      assert.ok(
        refs.every((ref) => ref.text.includes("Study ［Ａ］ and （ 2 ）.")),
      );
      assert.deepEqual(
        refs.map((ref) => ref.x),
        [50, 50, 50, 330, 330, 330],
      );
    },
  );
}

await check(
  "prefix normalization does not promote labels, mismatched brackets, tables or footers",
  () => {
    for (const value of [
      "[A1] Author",
      "［A1］ Author",
      "[2020] Author",
      "［２０２０］ Author",
      "［12） Author",
      "（12］ Author",
      "1 7 insight.jci.org",
      "41 , 1103",
      "25 (12%)",
      "10.1000/ref1",
      "１２．１０００/ref1",
    ])
      assert.equal(parser.numAtStart(value), 0, value);
    for (const value of [
      "［ 1 2 ］ Author",
      "（ 1 2 ） Author",
      "１２．Author",
      "１２） Author",
      "[ １ ２ ] Author",
    ])
      assert.equal(parser.numAtStart(value), 12, value);
    for (const sequence of [
      [1, 4, 2, 1],
      [1, 5, 2, 6],
    ]) {
      const lines = sequence.map((n, i) => ({
        text: `［ ${n} ］ Author A. Journal. 2020; 1:11–21.`,
        x: i % 2 ? 330 : 50,
        y: 650 - Math.floor(i / 2) * 20,
        width: 225,
        height: 10,
        _height: [10],
      }));
      assert.equal(parser.restoreNumberedColumnOrder(lines), lines);
    }
  },
);

for (const [label, authors] of [
  [
    "apostrophe and lowercase surnames",
    ["O'Neill A.", "de Vries A.", "van Dijk A."],
  ],
  ["accented surnames", ["Évrard A.", "Östberg B.", "Łukasz C."]],
  ["Chinese authors", ["张某，", "李某，", "王某，"]],
  [
    "institutional authors",
    [
      "World Research Group.",
      "National Study Group.",
      "University Methods Group.",
    ],
  ],
]) {
  await check(`unknown types use hanging indentation: ${label}`, async () => {
    const entries = [
      item("References", 100, 730, 10, 100),
      ...authors.flatMap((author, i) => [
        item(author, 100, 700 - i * 75),
        item("a neutral title continued on another line.", 116, 684 - i * 75),
        item("Neutral Journal. 2020; 1:11–21.", 116, 668 - i * 75),
      ]),
    ];
    const refs = await parse([entries]);
    assert.equal(refs.length, 3);
    refs.forEach((ref, i) => {
      assert.ok(ref.text.startsWith(authors[i]));
      assert.ok(ref.text.endsWith("2020; 1:11–21."));
      assert.equal(ref.x, 100);
    });
  });
}

await check(
  "unknown unnumbered body paragraphs remain outside the no-heading fallback",
  async () => {
    const entries = ["O'Neill A.", "de Vries A.", "van Dijk A."].flatMap(
      (author, i) => [
        item(author, 100, 700 - i * 75),
        item(
          "a neutral instruction continued on another line.",
          116,
          684 - i * 75,
        ),
        item(
          "another body paragraph without publication metadata.",
          116,
          668 - i * 75,
        ),
      ],
    );
    assert.equal((await parse([entries])).length, 0);
  },
);

await check(
  "year-first unnumbered entries retain years and mixed author types",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 670, 12, 110),
        item("2021. Neutral software. https://example.org/software.", 100, 650),
        item("Émile Example and another author. A neutral study", 100, 630),
        item("Journal. 2020; 1:11–21.", 112, 616),
        item("de Example A. Another neutral study", 100, 595),
        item("Journal. 2019; 2:22–30.", 112, 581),
      ],
    ]);
    assert.equal(refs.length, 3);
    assert.ok(refs[0].text.startsWith("2021. Neutral software."));
    assert.ok(refs[1].text.startsWith("Émile Example"));
    assert.ok(refs[2].text.startsWith("de Example"));
  },
);

await check(
  "reference table cells cannot replace an earlier true bibliography",
  async () => {
    const table = [
      item("Treatment", 60, 650, 10, 80),
      item("1 [Reference]", 400, 650, 10, 80),
      item("Another group", 60, 630, 10, 90),
      item("1.56 (0.62-4.02)", 400, 630, 10, 90),
      item("Unknown", 60, 610, 10, 90),
      item("1.22 (0.60-2.38)", 400, 610, 10, 90),
      item("Bold indicates statistical significance.", 60, 590),
    ];
    const refs = await parse([oneColumn(6), table]);
    assert.equal(refs.length, 6);
    assert.ok(refs.every((ref) => ref.page === 0));
  },
);

await check(
  "an unnumbered bibliography continues past a smaller numbered footnote",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 670, 12, 110),
        item("2021. Neutral software. https://example.org/software.", 100, 650),
        item("Émile Example. A neutral study", 100, 630),
        item("Journal. 2020; 1:11–21.", 112, 616),
        item("de Example A. Another study", 100, 595),
        item("Journal. 2019; 2:22–30.", 112, 581),
        item("4 https://example.org/footnote", 100, 552, 7, 120),
      ],
      [
        item("Chen A. A further study", 100, 650),
        item("Journal. 2018; 3:30–40.", 112, 636),
        item("Research Collective. A final study", 100, 615),
        item("Journal. 2017; 4:40–50.", 112, 601),
      ],
    ]);
    assert.equal(refs.length, 5);
    assert.equal(refs[4].page, 1);
    assert.ok(!refs.some((ref) => /footnote/.test(ref.text)));
  },
);

for (const shiftedEntries of [false, true]) {
  await check(
    `a normalized tail-only column preserves author continuation (new hanging column=${shiftedEntries})`,
    () => {
      const line = (text, pageNum, column, offset, x, y) => ({
        text,
        pageNum,
        column,
        _offset: offset,
        _x: offset + x,
        x,
        y,
        height: 10,
        width: 225,
        _height: [10],
      });
      const lines = [
        line(
          "2021. Neutral software. https://example.org/tool.",
          0,
          0,
          100,
          0,
          650,
        ),
        line("Author A. A study", 0, 0, 100, 0, 620),
        line("Journal. 2020; 1:11–21.", 0, 0, 100, 12, 606),
        line("Author B. Another study", 0, 1, 330, 0, 650),
        line("Journal. 2020; 1:11–21.", 0, 1, 330, 12, 636),
        line("Author C, Author D, and", 1, 0, 100, 0, 650),
        line("Author E, Author F, and more authors,", 1, 0, 100, 12, 636),
        line(
          shiftedEntries
            ? "Author G. A new study"
            : "Author G and Author H. A study",
          1,
          1,
          342,
          0,
          650,
        ),
        line(
          "Journal. 2020; 1:11–21.",
          1,
          1,
          342,
          shiftedEntries ? 12 : 0,
          636,
        ),
        line(
          "https://doi.org/10.1000/tail",
          1,
          1,
          342,
          shiftedEntries ? 12 : 0,
          622,
        ),
      ];
      const refs = parser.mergeSameRef(lines);
      assert.equal(refs.length, shiftedEntries ? 5 : 4);
      const last = refs.at(-1);
      assert.ok(last.text.includes("Author G"));
      assert.ok(last.text.endsWith("https://doi.org/10.1000/tail"));
      assert.equal(last._x, shiftedEntries ? 342 : 100);
    },
  );
}

const referenceLinksPage = [
  item("REFERENCES", 80, 390, 7, 60),
  item("https://example.org/article/2017/11/01#BIBL", 190, 370, 8, 200),
  item(
    "This article cites 61 articles, some available online.",
    190,
    380,
    8,
    250,
  ),
  item("PERMISSIONS", 80, 345, 7, 80),
];
await check(
  "reference-links metadata cannot replace an earlier References & Notes list",
  async () => {
    const page = oneColumn(6);
    page[0] = item("References & Notes", 100, 670, 12, 150);
    const refs = await parse([page, referenceLinksPage]);
    assert.equal(refs.length, 6);
    assert.ok(refs.every((ref) => ref.page === 0));
  },
);
await check(
  "reference-links metadata alone cannot invent a bibliography",
  async () => {
    assert.deepEqual(await parse([referenceLinksPage]), []);
  },
);

await check(
  "Sources and Credits starts at the numbered citations after its preface",
  async () => {
    const body = [
      item("This paragraph discusses when to include citation", 100, 670),
      item("references.", 112, 650, 10, 70),
      item("Some ordinary writing guidance continues here.", 100, 630),
      item("A second paragraph explains its organization.", 100, 610),
      item("No bibliography begins on this page.", 100, 590),
    ];
    const credit = [
      item("Sources and Credits", 160, 700, 20, 180),
      item("These examples illustrate the writing advice.", 100, 650),
      item("Their titles are standardized for clarity.", 100, 630),
      item("The following sources provide the examples.", 100, 610),
      ...Array.from({ length: 8 }, (_, i) =>
        item(reference(i + 1), 100, 575 - i * 25),
      ),
    ];
    const refs = await parse([body, credit]);
    assert.equal(refs.length, 8);
    assert.deepEqual(
      refs.map((ref) => ref.number),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.ok(
      refs.every(
        (ref) => ref.page === 1 && !/standardized|advice/.test(ref.text),
      ),
    );
  },
);

await check(
  "explicit numbered DOI references need not have publication years",
  async () => {
    const refs = await parse([
      [
        item("4. References:", 100, 670, 12, 110),
        ...Array.from({ length: 6 }, (_, i) =>
          item(
            `${i + 1}. Neutral reference. doi:10.1000/resource${i + 1}`,
            100,
            650 - i * 20,
          ),
        ),
      ],
    ]);
    assert.equal(refs.length, 6);
  },
);

await check(
  "a page footer cannot use the skipped-number allowance before the real next entry",
  async () => {
    const first = [
      item("References and Notes", 390, 120, 10, 140),
      ...Array.from({ length: 3 }, (_, i) =>
        item(reference(i + 1), 390, 100 - i * 20, 8, 160),
      ),
      item("5 of 6", 535, 17, 7, 22),
    ];
    const next = Array.from({ length: 3 }, (_, i) =>
      item(reference(i + 4), 40, 650 - i * 20, 8, 160),
    );
    const refs = await parse([first, next]);
    assert.deepEqual(
      refs.map((ref) => ref.number),
      [1, 2, 3, 4, 5, 6],
    );
    assert.ok(!refs.some((ref) => /5 of 6/.test(ref.text)));
  },
);

await check(
  "paired bibliography numbers may carry a following period",
  async () => {
    for (const prefix of ["[1].", "［ １ ］．", "(1).", "（ １ ）．"])
      assert.equal(parser.numAtStart(`${prefix} Writer A.`), 1);
    for (const text of [
      "[1].23",
      "[1]. 23",
      "[1].． Writer A.",
      "10.1016/example",
      "2020. Software",
    ])
      assert.equal(parser.numAtStart(text), 0, text);
    const refs = await parse([
      [
        item("References", 100, 700, 12, 100),
        ...Array.from({ length: 6 }, (_, i) =>
          item(
            reference(i + 1).replace(/^\d+\./, `[${i + 1}].`),
            100,
            670 - i * 20,
          ),
        ),
      ],
    ]);
    expectRefs(refs, 6);
    assert.ok(refs.every((ref) => ref.text.startsWith("Author")));
  },
);

for (const date of ["n.d.", "1720"]) {
  await check(
    `an explicitly headed bibliography accepts linked ${date} books`,
    async () => {
      const refs = await parse([
        [
          item("References", 100, 730, 12, 100),
          ...["Smith", "Brown", "White"].flatMap((name, i) => [
            item(`${name} A. A neutral book (${date}).`, 100, 700 - i * 40),
            item(
              `Example Press. https://example.org/catalog/${name}`,
              112,
              684 - i * 40,
            ),
          ]),
        ],
      ]);
      assert.equal(refs.length, 3);
      assert.ok(refs.every((ref) => ref.text.includes(date)));
    },
  );
}
for (const heading of ["A. References", "[References]"]) {
  await check(`whole bibliography heading supports ${heading}`, async () => {
    const refs = await parse([
      [
        item(heading, 100, 730, 12, 100),
        ...["Smith", "Brown", "White"].flatMap((name, i) => [
          item(`${name} A. (2020). A neutral book.`, 100, 700 - i * 40),
          item("Example Press.", 112, 684 - i * 40),
        ]),
      ],
    ]);
    assert.equal(refs.length, 3);
  });
}
await check(
  "a smaller numeric date within an unnumbered citation is retained",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 730, 12, 100),
        item("Smith A. A neutral report released on", 100, 700),
        item("12 April 2020. Example Press.", 112, 685, 8),
        item("https://example.org/report", 112, 670),
        item("Brown A. A neutral study.", 100, 640),
        item("Journal. 2020; 1:11-21.", 112, 625),
        item("White A. Another neutral study.", 100, 595),
        item("Journal. 2020; 2:21-31.", 112, 580),
      ],
    ]);
    assert.equal(refs.length, 3);
    assert.ok(refs[0].text.includes("12 April 2020. Example Press."));
  },
);
await check(
  "a shifted single-line column with complete citations starts fresh entries",
  () => {
    const line = (text, pageNum, column, offset, x, y) => ({
      text,
      pageNum,
      column,
      _offset: offset,
      _x: offset + x,
      x,
      y,
      height: 10,
      width: 225,
      _height: [10],
    });
    const refs = parser.mergeSameRef([
      line("Smith A. A neutral study", 0, 0, 100, 0, 650),
      line("Journal. 2020; 1:11-21.", 0, 0, 100, 12, 636),
      line("Brown A. A second study", 0, 1, 330, 0, 650),
      line("Journal. 2020; 2:21-31.", 0, 1, 330, 12, 636),
      line(
        "White A. A neutral monograph. Example Press (2020).",
        1,
        0,
        100,
        0,
        650,
      ),
      line(
        "Davis A. A fourth study. Journal. 2020; 3:31-41.",
        1,
        1,
        342,
        0,
        650,
      ),
      line(
        "Green A. A fifth study. Journal. 2020; 4:41-51.",
        1,
        1,
        342,
        0,
        630,
      ),
    ]);
    assert.equal(refs.length, 5);
    assert.equal(refs[3]._x, 342);
    assert.ok(refs[3].text.startsWith("Davis"));
  },
);
for (const columns of [false, true]) {
  await check(
    `a numeric date cannot reorder unnumbered continuation pages (${columns ? 2 : 1} columns)`,
    async () => {
      const x = columns ? 50 : 100,
        w = columns ? 225 : 350;
      const cite = (name) =>
        `${name} A. A neutral study. Journal. 2020; 1:11-21.`;
      const page = (names, heading = false) => [
        ...(heading ? [item("References", x, 680, 12, 100)] : []),
        ...names.map((name, i) => item(cite(name), x, 650 - i * 20, 10, w)),
      ];
      const pages = [
        page(["Alpha", "Bravo", "Charlie"], true),
        [
          item("Delta A. A neutral report released on", x, 650, 10, w),
          item("12 April 2020. Example Press.", x + 12, 636, 10, w - 12),
          item(cite("Echo"), x, 616, 10, w),
          item(cite("Foxtrot"), x, 596, 10, w),
        ],
        page(["Golf", "Hotel", "India"]),
      ];
      if (columns)
        for (const [p, pg] of pages.entries())
          pg.push(
            ...["Juliet", "Kilo", "Lima"].map((name, i) =>
              item(
                cite(`${name}${String.fromCharCode(65 + p)}`),
                330,
                650 - i * 20,
                10,
                225,
              ),
            ),
          );
      const refs = await parse(pages);
      assert.equal(refs.length, columns ? 18 : 9);
      assert.deepEqual(
        refs.map((ref) => ref.page),
        [...refs.map((ref) => ref.page)].sort((a, b) => a - b),
      );
      assert.ok(
        refs
          .find((ref) => ref.text.startsWith("Delta"))
          .text.includes("12 April 2020. Example Press."),
      );
    },
  );
}

for (const heading of ["B.2.6 – References", "4.2. References"])
  await check(
    `bibliography headings accept a hierarchical section number (${heading})`,
    async () => {
      const refs = await parse([
        [item(heading, 100, 700, 12, 150), ...oneColumn(6, false)],
      ]);
      expectRefs(refs, 6);
    },
  );
await check(
  "late drawn reference numbers return to their matching text band",
  async () => {
    const rows = [item("References", 70, 730, 12, 100)];
    for (let n = 1; n <= 6; n++)
      rows.push(
        item(
          `Author${String.fromCharCode(64 + n)} A. A neutral study.`,
          94,
          710 - n * 45,
          8,
          225,
        ),
        item(`Journal. 2020; ${n}:11-21. DOI PubMed`, 94, 699 - n * 45, 8, 225),
        item(`${n}.`, 70, 710 - n * 45, 8, 10),
      );
    const refs = await parse([rows]);
    expectRefs(refs, 6);
    assert.ok(
      refs.every((ref) => ref.text.startsWith("Author") && ref.x === 70),
    );
    assert.ok(refs.every((ref) => /DOI PubMed$/.test(ref.text)));
  },
);
await check(
  "gutter reordering requires bibliography evidence and a coherent numbering sequence",
  () => {
    const data = (numbers, publication = true, bare = false) =>
      numbers.flatMap((n, i) => [
        item(
          `Category${String.fromCharCode(65 + i)} description`,
          94,
          700 - i * 40,
          8,
          225,
        ),
        item(
          publication
            ? `Journal. 2020; ${i + 1}:11-21.`
            : "Participants in 2020 with allocation ratio 1:1.",
          94,
          686 - i * 40,
          8,
          225,
        ),
        item(bare ? `${n}` : `${n}.`, 70, 700 - i * 40, 8, 10),
      ]);
    for (const rows of [
      data([1, 2, 3], false),
      data([1, 1, 1]),
      data([1, 2, 99]),
      data([1, 2, 3], true, true),
    ])
      assert.deepEqual(parser.restoreGutterNumberItems(rows), rows);
  },
);

await check(
  "a proven numbered list strips a number before a year-first citation",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 700, 12, 100),
        item(
          "1. 2018. Neutral software. https://example.org/software",
          100,
          670,
        ),
        item(reference(2), 100, 640),
        item(reference(3), 100, 610),
      ],
    ]);
    expectRefs(refs, 3);
    assert.ok(refs[0].text.startsWith("2018. Neutral software."));
    assert.equal(parser.numAtStart("1. 2018. Neutral software."), 0);
  },
);
await check(
  "a large diagonal watermark cannot replace the short tail on the next page",
  async () => {
    const watermark = item("ACCEP TED", 260, 380, 40, 210);
    watermark.transform = [30, 30, -30, 30, 260, 380];
    const refs = await parse([
      [
        item("References", 100, 200, 12, 100),
        item(reference(1), 100, 170),
        item(reference(2), 100, 140),
        item("3. Writer C. A cross-page study. Journal", 100, 110),
      ],
      [
        watermark,
        item("2020; 3:31-41.", 100, 710),
        ...Array.from({ length: 7 }, (_, i) =>
          item(reference(i + 4), 100, 670 - i * 35),
        ),
        item("Page 2", 500, 20, 8, 35),
      ],
    ]);
    expectRefs(refs, 10);
    assert.ok(refs[2].text.includes("2020; 3:31-41."));
    assert.ok(refs.every((ref) => !ref.text.includes("ACCEP")));
  },
);
await check(
  "diagonal filtering preserves normal large headings and fully rotated documents",
  async () => {
    const read = (items) =>
      parser.readPdfPage({
        getTextContent: async () => ({ items }),
        getAnnotations: async () => [],
        _pageInfo: { view: [0, 0, 612, 792] },
      });
    const headings = await read([
      item("Large heading", 80, 750, 40, 400),
      ...oneColumn(8, false),
    ]);
    assert.ok(headings.some((line) => line.text.includes("Large heading")));
    const rotated = Array.from({ length: 9 }, (_, i) => ({
      ...item(`Vertical content ${i}`, 100, 700 - i * 25, 40, 200),
      transform: [0, 40, -40, 0, 100, 700 - i * 25],
    }));
    const lines = await read(rotated);
    assert.ok(lines.some((line) => line.text.includes("Vertical content 0")));
    assert.ok(lines.some((line) => line.text.includes("Vertical content 8")));
  },
);
await check(
  "a larger lettered section followed by its subsection is outside the bibliography",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 700, 12, 100),
        ...["Smith", "Brown", "White"].flatMap((name, i) => [
          item(`${name} A. A neutral study.`, 100, 670 - i * 40),
          item("Journal. 2020; 1:11-21.", 112, 654 - i * 40),
        ]),
      ],
      [
        item("A E VALUATION", 100, 700, 12, 120),
        item("A.1 A LL R ESULTS", 100, 677, 10, 140),
        ...Array.from({ length: 6 }, (_, i) =>
          item(`Group ${i + 1} performance 2020`, 100, 650 - i * 20, 10, 225),
        ),
      ],
    ]);
    assert.equal(refs.length, 3);
    assert.ok(refs.every((ref) => ref.page === 0));
  },
);
await check(
  "author profile prose does not become references and a Dr title remains intact",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 730, 12, 100),
        item("Smith A. A neutral study.", 100, 700),
        item("Journal. 2020; 1:11-21.", 112, 684),
        item(
          "Dr. White A. His research interests as a neutral article title.",
          100,
          660,
        ),
        item("Journal. 2020; 2:22-30.", 112, 644),
        item("Brown A., 2020. The final neutral study.", 100, 620),
        item("Journal. 3 (2), 31 – 41.", 112, 604),
        item("Dr. Example Author is a faculty member.", 100, 575),
        item("His research focuses on neutral examples.", 100, 561),
        item("He completed his studies at an example institution.", 100, 547),
        item("Additional professional profile information follows.", 100, 533),
      ],
    ]);
    assert.equal(refs.length, 3);
    assert.ok(refs[1].text.startsWith("Dr. White"));
    assert.ok(refs[2].text.includes("31 – 41."));
    assert.ok(refs.every((ref) => !ref.text.includes("faculty member")));
  },
);
await check(
  "a publisher notice in the next column is not another reference",
  async () => {
    const refs = await parse([
      [
        item("References", 50, 700, 12, 100),
        ...["Smith", "Brown", "White"].flatMap((name, i) => [
          item(`${name} A. A neutral study.`, 50, 670 - i * 40, 10, 225),
          item("Journal. 2020; 1:11-21.", 62, 654 - i * 40, 10, 210),
        ]),
        item(
          "Publisher’s Note Example Press remains neutral.",
          330,
          670,
          10,
          225,
        ),
        item("Further publisher notice details follow.", 330, 655, 10, 225),
      ],
    ]);
    assert.equal(refs.length, 3);
    assert.ok(refs.every((ref) => !ref.text.includes("Publisher")));
  },
);

for (const title of [
  "Correspondence and historical letters.",
  "Funding methods across institutions.",
])
  await check(
    `a wrapped book title keeps place/publisher/year metadata (${title})`,
    async () => {
      const refs = await parse([
        [
          item("References", 100, 700, 12, 100),
          item(reference(1), 100, 680),
          item(reference(2), 100, 650),
          item("3. Writer C.", 100, 620),
          item(title, 100, 604),
          item("London: Example Press; 1986.", 100, 588),
        ],
      ]);
      expectRefs(refs, 3);
      assert.equal(
        refs[2].text,
        `Writer C. ${title} London: Example Press; 1986.`,
      );
    },
  );
await check(
  "book-title lookahead does not rescue standalone headings or year-only prose",
  async () => {
    for (const [title, following] of [
      ["Correspondence", "London: Example Press; 1986."],
      [
        "Funding information for this work",
        "The project was supported in 2020.",
      ],
    ]) {
      const refs = await parse([
        [
          item("References", 100, 700, 12, 100),
          item(reference(1), 100, 680),
          item(reference(2), 100, 650),
          item("3. Writer C.", 100, 620),
          item(title, 100, 604),
          item(following, 100, 588),
        ],
      ]);
      expectRefs(refs, 3);
      assert.equal(refs[2].text, "Writer C.");
    }
  },
);
await check(
  "annual citations at identical body coordinates remain distinct",
  async () => {
    const pages = [
      oneColumn(6),
      Array.from({ length: 6 }, (_, i) =>
        item(reference(i + 7), 100, 650 - i * 20),
      ),
    ];
    pages[0][3] = item(
      "3. Agency A. Annual report 2019. Journal. 2019; 1:11-21.",
      100,
      610,
    );
    pages[1][2] = item(
      "9. Agency A. Annual report 2020. Journal. 2020; 2:22-32.",
      100,
      610,
    );
    const refs = await parse(pages);
    expectRefs(refs, 12);
    assert.ok(refs[2].text.includes("Annual report 2019"));
    assert.ok(refs[8].text.includes("Annual report 2020"));
  },
);
await check(
  "folio-aligned running heads are removed while nearby references remain",
  async () => {
    const pages = Array.from({ length: 2 }, (_, page) => [
      item(String(525 + page), 50, 730, 10, 20),
      item(
        page ? "OTHER AUTHORS IN THE RUNNING HEAD" : "FIRST RUNNING TITLE",
        150,
        730,
        10,
        310,
      ),
      ...(page ? [] : [item("References", 50, 700, 12, 100)]),
      ...Array.from({ length: 3 }, (_, i) =>
        item(reference(page * 3 + i + 1), 50, 675 - i * 25, 10, 470),
      ),
      item(`Downloaded at example ${2020 + page}`, 550, 360, 8, 35),
    ]);
    const refs = await parse(pages);
    expectRefs(refs, 6);
    assert.ok(
      refs.every((ref) => !/RUNNING|Downloaded|525|526/.test(ref.text)),
    );
  },
);
await check(
  "page-bottom numeric ranges retain their different values across pages",
  async () => {
    const pages = Array.from({ length: 2 }, (_, pg) => [
      ...(pg ? [] : [item("References", 100, 170, 12, 100)]),
      item(reference(pg * 3 + 1), 100, 145),
      item(reference(pg * 3 + 2), 100, 120),
      item(
        `${pg * 3 + 3}. Writer ${pg ? "F" : "C"}. A neutral study. Journal. 2020; 3(2),`,
        100,
        94,
      ),
      item(pg ? "6513–6525." : "9762–9770.", 100, 80, 10, 100),
    ]);
    const refs = await parse(pages);
    expectRefs(refs, 6);
    assert.ok(refs[2].text.endsWith("9762–9770."));
    assert.ok(refs[5].text.endsWith("6513–6525."));
  },
);
const continuationLine = (text, y, x = 100, pageNum = 0, width = 350) => ({
  text,
  x,
  y,
  pageNum,
  width,
  height: 10,
  _height: [10],
});
await check(
  "numbered and hanging citations preserve numeric ranges and source-confirmed DOI hyphens",
  () => {
    for (const numbered of [true, false])
      for (const [before, after, joined] of [
        ["Journal. 2020;35:1-", "39,1977.", "35:1-39,1977."],
        ["Journal. 2020;12:1976-", "86.", "12:1976-86."],
        ["Journal. 2016;32(5-", "6):314-6.", "32(5-6):314-6."],
        ["doi:10.1000/neutral-", "title", "10.1000/neutral-title"],
        [
          "https://example.org/neutral-",
          "resource",
          "https://example.org/neutral-resource",
        ],
        ["A Poly-", "gon study. Journal. 2020;1:11-21.", "A Polygon study."],
      ]) {
        const lines = [
          continuationLine(`${numbered ? "1. " : ""}Smith A. ${before}`, 670),
          continuationLine(after, 655, numbered ? 100 : 112),
          continuationLine(
            numbered
              ? reference(2)
              : "Brown A. Another study. Journal. 2020;2:22-30.",
            620,
          ),
          continuationLine(
            numbered
              ? reference(3)
              : "White A. Final study. Journal. 2020;3:31-41.",
            590,
          ),
        ];
        if (before === "doi:10.1000/neutral-") {
          lines[0].url = "https://doi.org/10.1000/neutral-title";
          lines[1].url = lines[0].url;
        }
        const refs = parser.mergeSameRef(lines);
        assert.equal(refs.length, 3);
        assert.ok(refs[0].text.includes(joined), refs[0].text);
      }
  },
);
await check(
  "a short numeric range tail can continue at the top of the next column",
  () => {
    for (const final of [false, true]) {
      const lines = [
        continuationLine(reference(1), 670, 50, 0, 225),
        continuationLine(reference(2), 630, 50, 0, 225),
        continuationLine(
          "3. Writer C. Study. Journal. 2020;12:1976-",
          80,
          50,
          0,
          225,
        ),
        continuationLine("86.", 710, 330, 0, 20),
        ...(final ? [] : [continuationLine(reference(4), 680, 330, 0, 225)]),
      ];
      const refs = parser.mergeNumberedRefs(lines);
      assert.equal(refs.length, final ? 3 : 4);
      assert.ok(refs[2].text.endsWith("1976-86."));
    }
  },
);
await check(
  "an upward appendix label inside the same column cannot extend a citation",
  () => {
    const lines = [
      continuationLine(reference(1), 670, 300, 0, 235),
      continuationLine("2. Writer B. An unfinished title", 80, 300, 0, 235),
      continuationLine(
        "continued in the current right column",
        64,
        315,
        0,
        100,
      ),
      continuationLine("Table label", 705, 430, 0, 30),
      continuationLine("Journal. 2020;2:22-30.", 710, 50, 1, 225),
      continuationLine(reference(3), 680, 50, 1, 225),
    ];
    const refs = parser.mergeNumberedRefs(lines);
    assert.equal(refs.length, 3);
    assert.ok(!refs[1].text.includes("Table label"));
    assert.ok(refs[1].text.endsWith("Journal. 2020;2:22-30."));
  },
);
await check(
  "a tiny header row is insufficient evidence to remove slanted bibliography text",
  async () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        item(`Header${i}`, 30 + i * 55, 760, 6, 40),
      ),
      ...Array.from({ length: 3 }, (_, i) => ({
        ...item(reference(i + 1), 100, 650 - i * 40, 16, 350),
        transform: [13.856, 8, -8, 13.856, 100, 650 - i * 40],
      })),
    ];
    const lines = await parser.readPdfPage({
      getTextContent: async () => ({ items }),
      getAnnotations: async () => [],
      _pageInfo: { view: [0, 0, 612, 792] },
    });
    for (let n = 1; n <= 3; n++)
      assert.ok(lines.some((line) => line.text.includes(`10.1000/ref${n}`)));
  },
);
await check(
  "a later reference-labelled table with an isolated one cannot replace the bibliography",
  async () => {
    const refs = await parse([
      oneColumn(6),
      [
        item("Reference", 100, 700, 12, 100),
        item("1 Reference group", 100, 680, 10, 180),
        item("Participants", 100, 660),
        item("Mean age", 100, 640),
        item("Control allocation", 100, 620),
        item("Category label", 100, 600),
        item("Treatment group", 100, 580),
      ],
    ]);
    expectRefs(refs, 6);
    assert.ok(refs.every((ref) => ref.page === 0));
  },
);
await check(
  "a final pair of late-drawn bracketed numbers restores its two citations",
  async () => {
    const refs = await parse([
      oneColumn(3),
      [
        item("Writer D. A neutral publication.", 94, 700, 8, 225),
        item("Journal. 2020;4:41-51.", 94, 687, 8, 225),
        item("[4]", 70, 700, 8, 14),
        item("Writer E. The final publication.", 94, 660, 8, 225),
        item("[5]", 70, 660, 8, 14),
        item("Journal. 2020;5:52-61.", 340, 710, 8, 225),
        item("Author contributions", 340, 680, 10, 150),
        item("The authors contributed equally.", 340, 663, 10, 225),
      ],
    ]);
    expectRefs(refs, 5);
    assert.ok(refs[3].text.startsWith("Writer D."));
    assert.ok(refs[4].text.endsWith("Journal. 2020;5:52-61."));
    assert.ok(refs.every((ref) => !ref.text.includes("contributed")));
  },
);
await check(
  "two gutter numbers alone do not turn a table into bibliography lines",
  () => {
    for (const numbers of [
      ["[4]", "[5]"],
      ["4.", "5."],
      ["[4]", "[9]"],
    ]) {
      const rows = [
        item("First category description", 94, 700, 8, 225),
        item("Allocation ratio 1:1 in 2020.", 94, 687, 8, 225),
        item(numbers[0], 70, 700, 8, 14),
        item("Second category description", 94, 660, 8, 225),
        item(numbers[1], 70, 660, 8, 14),
      ];
      assert.deepEqual(parser.restoreGutterNumberItems(rows), rows);
    }
  },
);
await check(
  "complete spaced or electronic page ranges stop later table blocks",
  () => {
    for (const ending of [
      "Journal. 2020;12:192 - 201.",
      "Journal. 2020;12:870-3.e5.",
      "doi:10.1000/final",
    ])
      for (const pageNum of [0, 1]) {
        const refs = parser.mergeNumberedRefs([
          continuationLine(reference(1), 670),
          continuationLine(reference(2), 640),
          continuationLine(`3. Writer C. Study. ${ending}`, 610),
          continuationLine(
            "Characteristics",
            pageNum ? 710 : 585,
            100,
            pageNum,
          ),
          continuationLine(
            "Participants with group measurements",
            pageNum ? 695 : 570,
            100,
            pageNum,
          ),
        ]);
        assert.equal(refs.length, 3);
        assert.equal(refs[2].text, `3. Writer C. Study. ${ending}`);
      }
  },
);

function readFixture(templates, options = {}) {
  const reads = [],
    annotations = [],
    counts = new Map();
  const app = {
    page: options.page ?? templates.length,
    pdfLoadingTask: { promise: Promise.resolve() },
    pdfViewer: {
      pagesPromise: Promise.resolve(),
      _pages: templates.map((items, index) => ({
        pdfPage: {
          _pageInfo: { view: [0, 0, 612, 792] },
          async getTextContent() {
            reads.push(index);
            const count = (counts.get(index) || 0) + 1;
            counts.set(index, count);
            return options.text
              ? options.text(index, count, items)
              : { items: globalThis.structuredClone(items) };
          },
          async getAnnotations() {
            annotations.push(index);
            return options.annotations ? options.annotations(index) : [];
          },
        },
      })),
    },
  };
  return {
    reads,
    annotations,
    reader: {
      _internalReader: {
        _primaryView: { _iframeWindow: { PDFViewerApplication: app } },
      },
    },
  };
}
await check(
  "successful body probes and empty preloads are read once per parse",
  async () => {
    for (const empty of [false, true]) {
      const pages = Array.from({ length: 32 }, () => []);
      if (!empty) pages[28] = oneColumn(6);
      const fixture = readFixture(pages);
      const progress = [];
      const refs = await parser.parsePDFReferences(fixture.reader, {
        onProgress: (...args) => progress.push(args),
      });
      if (empty)
        assert.deepEqual(progress, [
          ["parser-read-text 0/4", 1],
          ...Array.from({ length: 32 }, (_, i) => [
            `parser-read-text ${i + 1}/${i + 1}`,
            90,
          ]),
          ["parser-analyze", 95],
        ]);
      else
        for (let i = 1; i <= 3; i++)
          assert.ok(
            progress.some(
              ([message, percent]) =>
                message === `parser-read-text ${i}/${i}` && percent === 90,
            ),
          );
      assert.equal(refs.length, empty ? 0 : 6);
      assert.equal(fixture.reads.length, new Set(fixture.reads).size);
      for (const page of [29, 30, 31])
        assert.equal(fixture.reads.filter((p) => p === page).length, 1);
      assert.deepEqual(fixture.annotations, empty ? [] : [28]);
    }
  },
);
await check(
  "failed or malformed probe responses are retried rather than cached",
  async () => {
    for (const malformed of [false, true]) {
      const fixture = readFixture([[item("Body", 100, 650)], oneColumn(6)], {
        text(index, count, items) {
          if (index === 1 && count === 1) {
            if (malformed) return { items: [{ str: null }] };
            throw Error("Transient probe request failure");
          }
          return { items: globalThis.structuredClone(items) };
        },
      });
      const refs = await parser.parsePDFReferences(fixture.reader);
      expectRefs(refs, 6);
      assert.equal(fixture.reads.filter((page) => page === 1).length, 2);
      assert.equal(fixture.annotations.filter((page) => page === 1).length, 1);
    }
  },
);
await check(
  "raw probes are consumed before annotation processing can fail",
  async () => {
    const pdfPage = {
      _pageInfo: { view: [0, 0, 612, 792] },
      getTextContent: async () => {
        throw Error("Should consume the successful probe");
      },
      getAnnotations: async () => {
        throw Error("Annotation failure");
      },
    };
    const cache = new Map([[pdfPage, { items: oneColumn(6) }]]);
    await assert.rejects(
      parser.readPdfPage(pdfPage, false, cache),
      /Annotation failure/,
    );
    assert.equal(cache.size, 0);
  },
);
await check(
  "per-parse probe caches are bounded and released on success, failure and concurrent calls",
  async () => {
    const tracked = [];
    class ProbeMap extends Map {
      constructor(...args) {
        super(...args);
        this.highWater = 0;
        this.clears = 0;
        tracked.push(this);
      }
      set(key, value) {
        super.set(key, value);
        this.highWater = Math.max(this.highWater, this.size);
        return this;
      }
      clear() {
        this.clears++;
        super.clear();
      }
    }
    const instrumented = compile(
      "src/pdf/parser.ts",
      {
        "../core/text": text,
        "./groupedReferences": grouped,
        "./groupedStudyReferences": groupedStudy,
        "../utils/prefs": { getPref: () => 4 },
        "../utils/locale": { getString: (key) => key },
      },
      "",
      ProbeMap,
    );
    const assertReleased = (cache) => {
      assert.ok(cache.highWater <= 5);
      assert.equal(cache.size, 0);
      assert.equal(cache.clears, 1);
    };
    let index = tracked.length;
    assert.deepEqual(await instrumented.parsePDFReferences(null), []);
    assertReleased(tracked[index]);
    const pages = Array.from({ length: 32 }, () => [
      item("Neutral body text", 100, 650),
    ]);
    pages[3] = oneColumn(6);
    index = tracked.length;
    const failed = await instrumented.parsePDFReferences(
      readFixture(pages).reader,
      {
        onProgress() {
          throw Error("Progress interrupted");
        },
      },
    );
    assert.deepEqual(failed, []);
    assert.equal(tracked[index].highWater, 5);
    assertReleased(tracked[index]);
    index = tracked.length;
    const manual = await instrumented.parsePDFReferences(
      readFixture(pages, { page: 4 }).reader,
      { fromCurrentPage: true },
    );
    expectRefs(manual, 6);
    assertReleased(tracked[index]);
    let failing = true;
    const fixture = readFixture([[item("Body", 100, 650)], oneColumn(6)], {
      annotations() {
        if (failing) throw Error("Annotation failure");
        return [];
      },
    });
    index = tracked.length;
    assert.deepEqual(await instrumented.parsePDFReferences(fixture.reader), []);
    assertReleased(tracked[index]);
    failing = false;
    index = tracked.length;
    expectRefs(await instrumented.parsePDFReferences(fixture.reader), 6);
    assertReleased(tracked[index]);
    index = tracked.length;
    const concurrent = [
      instrumented.parsePDFReferences(fixture.reader, {
        onProgress() {
          throw Error("Only this invocation");
        },
      }),
      instrumented.parsePDFReferences(fixture.reader),
    ];
    const caches = tracked.slice(index, index + 2);
    const [bad, good] = await Promise.all(concurrent);
    assert.deepEqual(bad, []);
    expectRefs(good, 6);
    assert.notEqual(caches[0], caches[1]);
    caches.forEach(assertReleased);
  },
);
await check(
  "cached empty preloads preserve the original continuation lookup boundary",
  async () => {
    const linked = linkedBibliography();
    for (const count of [65, 66, 68]) {
      const pages = [
        [],
        [],
        [],
        linked[3],
        ...Array.from({ length: count - 5 }, () => [
          item("Neutral intervening page", 100, 650),
        ]),
        linked[4],
      ];
      const fixture = readFixture(pages, { page: 4 });
      const refs = await parser.parsePDFReferences(fixture.reader, {
        fromCurrentPage: true,
      });
      expectRefs(refs, count === 65 ? 20 : 14);
      assert.equal(fixture.reads.length, 65);
      assert.equal(new Set(fixture.reads).size, 65);
      assert.equal(fixture.annotations.length, 62);
      assert.equal(new Set(fixture.annotations).size, 62);
      assert.ok(refs.every((ref) => !ref.text.includes("Neighbour")));
    }
  },
);

for (const [name, word, rect, expected] of [
  [
    "previous-row sliver",
    item("Next author", 306.1417, 562.8463, 8.5, 238.1326),
    [321.142, 570.937, 369.541, 580.423],
    false,
  ],
  [
    "actual DOI tail",
    item("doi suffix", 321.1442, 572.8423, 8.5, 48.399),
    [321.142, 570.937, 369.541, 580.423],
    true,
  ],
  [
    "edge-only contact",
    item("New row", 100, 500, 8.5, 50),
    [100, 508.5, 150, 518.5],
    false,
  ],
  [
    "adjacent-word sliver",
    item("New word", 100, 500, 8.5, 50),
    [149.8, 500, 180, 509],
    false,
  ],
  [
    "link inside a longer text run",
    item("A whole line ending in a DOI", 100, 500, 8.5, 300),
    [350, 499, 400, 508],
    true,
  ],
  [
    "short annotation rectangle",
    item("Small annotation", 100, 500, 8.5, 50),
    [120, 502, 130, 504],
    true,
  ],
  [
    "whole glyph box",
    item("Whole link", 100, 500, 8.5, 50),
    [99, 499, 151, 510],
    true,
  ],
  [
    "disjoint box",
    item("No link", 100, 500, 8.5, 50),
    [300, 499, 350, 510],
    false,
  ],
  [
    "zero-height annotation",
    item("No link", 100, 500, 8.5, 50),
    [100, 505, 150, 505],
    false,
  ],
])
  await check(
    `annotation attachment requires substantial glyph coverage: ${name}`,
    () => {
      const url = "https://doi.org/10.1000/correct";
      const original = globalThis.structuredClone(word);
      parser.updateItemsAnnotions([word], [{ rect, url }]);
      assert.equal(word.url, expected ? url : undefined);
      const { url: attachedURL, ...rest } = word;
      assert.equal(Boolean(attachedURL), expected);
      assert.deepEqual(rest, original);
    },
  );
await check("an overlapping unsafe annotation URL remains rejected", () => {
  const word = item("Unsafe", 100, 500, 8.5, 50);
  parser.updateItemsAnnotions(
    [word],
    [{ rect: [100, 500, 150, 509], unsafeUrl: "file:///private" }],
  );
  assert.equal(word.url, undefined);
});
await check("a known DOI replaces only a malformed DOI resolver URL", () => {
  const doi = "10.2214/AJR.180.4.1800955";
  const raw = `Writer A. A neutral study. Journal. 2020;1:11-21. http://dx.doi.org/102214/ ajr.180.4.1800955. DOI: ${doi}`;
  const ref = text.refTextToInfo(raw);
  assert.equal(ref.text, raw);
  assert.equal(ref.identifiers.DOI, doi);
  assert.equal(ref.url, text.identifiersToURL({ DOI: doi }));
  for (const malformed of [
    "https://doi.org/",
    "https://doi.org/10.2214",
    "https://doi.org/10.2214/",
  ]) {
    const result = text.refTextToInfo(
      `Writer A. Study. DOI: ${doi}. ${malformed}`,
    );
    assert.equal(result.url, text.identifiersToURL({ DOI: doi }));
  }
});
await check(
  "valid resolver, publisher, PDF and website URLs keep their existing precedence",
  () => {
    for (const url of [
      "https://doi.org/10.1000/correct",
      "http://dx.doi.org/10.1000/correct",
      "https://doi.org/10.1000%2Fcorrect",
      "https://doi.org/10.1000/correct?source=reader#section",
      "https://publisher.example/article/123",
      "https://example.org/report.pdf",
      "https://doi.org.example/article",
    ]) {
      const raw = `Writer A. A neutral study. Journal. 2020;1:11-21. ${url} DOI: 10.9999/secondary`;
      assert.equal(text.refTextToInfo(raw).url, text.extractURL(raw));
    }
    const raw = "Writer A. Study. http://dx.doi.org/102214/ unresolved";
    assert.equal(text.refTextToInfo(raw).url, text.extractURL(raw));
    assert.equal(
      text.refTextToInfo("Writer A. Study. DOI:10.1000/only").url,
      text.identifiersToURL({ DOI: "10.1000/only" }),
    );
  },
);

await check(
  "a nearby larger side folio does not erase a single-line book",
  async () => {
    const refs = await parse([
      [
        item("References", 85.2, 135, 10, 100),
        item(reference(1), 85.2, 114, 8.5, 314.4),
        item(reference(2), 85.2, 94, 8.5, 314.4),
        item(
          "3. Writer C. Design of observational studies. Example Press: New York, NY, 2010.",
          85.2,
          74.2,
          8.5,
          314.4,
        ),
        item("101", 573, 68.9, 13.9, 24),
      ],
      [
        ...[4, 5, 6].map((n, i) =>
          item(reference(n), 85.2, 700 - i * 25, 8.5, 430),
        ),
        item("102", 573, 68.9, 13.9, 24),
      ],
    ]);
    expectRefs(refs, 6);
    assert.ok(refs[2].text.endsWith("Example Press: New York, NY, 2010."));
    assert.equal(refs[2].page, 0);
  },
);

for (const bodyNumber of [139, 760]) {
  await check(
    `a wrapped title number ${bodyNumber} does not change the continuation cursor`,
    async () => {
      const refs = await parse([
        [
          item("References", 100, 700, 12, 100),
          item(reference(1), 100, 670),
          item(reference(2), 100, 640),
          item("3. Writer C. A study of", 100, 610),
          item(`${bodyNumber} participants. Journal. 2020;3:31-41.`, 112, 594),
          item(reference(4), 100, 560),
          item(reference(5), 100, 530),
          item("6. Writer F. A wrapped publication. Journal.", 100, 500),
        ],
        [
          item("2020;6:61-71.", 112, 710, 10, 100),
          item(reference(7), 100, 675),
          item(reference(8), 100, 640),
        ],
      ]);
      expectRefs(refs, 8);
      assert.ok(refs[2].text.includes(`${bodyNumber} participants.`));
      assert.ok(refs[5].text.endsWith("2020;6:61-71."));
    },
  );
}

for (const present of [
  [1, 2, 4, 5, 6],
  [1, 2, 5, 6],
]) {
  await check(
    `number gaps ${present.join(",")} do not hide the following page`,
    async () => {
      const refs = await parse([
        [
          item("References", 100, 700, 12, 100),
          ...present.map((n, i) => item(reference(n), 100, 670 - i * 30)),
        ],
        [item(reference(7), 100, 700), item(reference(8), 100, 670)],
      ]);
      assert.deepEqual(
        refs.map((ref) => ref.number),
        [...present, 7, 8],
      );
      assert.ok(refs.at(-1).text.includes("10.1000/ref8"));
    },
  );
}

for (const [label, value] of [
  ["Accessed", "September 30, 2019."],
  ["doi:", "10.1000/complete-label."],
]) {
  await check(
    `a separately drawn ${label} keeps the following wrapped value`,
    () => {
      const refs = parser.mergeNumberedRefs([
        continuationLine(reference(1), 670, 100, 0, 440),
        continuationLine(reference(2), 650, 100, 0, 440),
        continuationLine(
          "3. Writer C. A neutral publication.",
          630,
          100,
          0,
          440,
        ),
        continuationLine("Journal. 2020;3:31-41.", 610, 112, 0, 320),
        continuationLine(label, 610, 505, 0, 35),
        continuationLine(value, 594, 112, 0, 180),
        continuationLine(reference(4), 565, 100, 0, 440),
      ]);
      assert.equal(refs.length, 4);
      assert.ok(refs[2].text.endsWith(`${label} ${value}`));
    },
  );
}

await check(
  "a sparse final page still separates large diagonal watermarks from body text",
  async () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        item(`Publication line ${i}.`, 100, 770 - i * 14, 12, 350),
      ),
      {
        ...item("LARGE DIAGONAL OVERLAY", 200, 350, 40, 250),
        transform: [30, 30, -30, 30, 200, 350],
      },
    ];
    const lines = await parser.readPdfPage({
      getTextContent: async () => ({ items }),
      getAnnotations: async () => [],
      _pageInfo: { view: [0, 0, 612, 792] },
    });
    for (let i = 0; i < 8; i++)
      assert.ok(
        lines.some((line) => line.text.includes(`Publication line ${i}.`)),
      );
    assert.ok(!lines.some((line) => line.text.includes("DIAGONAL")));
  },
);

await check(
  "scattered short horizontal labels cannot invalidate real slanted references",
  async () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        item(
          `Label${i}`,
          30 + (i % 2) * 55,
          760 - Math.floor(i / 2) * 80,
          6,
          40,
        ),
      ),
      ...Array.from({ length: 3 }, (_, i) => ({
        ...item(reference(i + 1), 100, 650 - i * 40, 16, 350),
        transform: [13.856, 8, -8, 13.856, 100, 650 - i * 40],
      })),
    ];
    const lines = await parser.readPdfPage({
      getTextContent: async () => ({ items }),
      getAnnotations: async () => [],
      _pageInfo: { view: [0, 0, 612, 792] },
    });
    for (let n = 1; n <= 3; n++)
      assert.ok(lines.some((line) => line.text.includes(`10.1000/ref${n}`)));
  },
);

for (const qualified of [false, true]) {
  await check(
    `a final singleton before ${qualified ? "supplementary" : "ordinary"} captions retains its complete publication`,
    async () => {
      const refs = await parse([
        oneColumn(6),
        [
          item("This article is protected by copyright.", 100, 50, 10, 300),
          item(
            "7. Writer G. The final neutral publication.",
            100,
            710,
            10,
            430,
          ),
          item("A wrapped title and publication details.", 112, 690, 10, 410),
          item("Journal. 2020;7:71-81.", 112, 670, 10, 180),
          item("Attached Files:", 100, 550, 10, 90),
          item("Figure legends:", 100, 500, 10, 100),
          item(
            `${qualified ? "Supplementary " : ""}Figure 1: Illustration of the study flow.`,
            100,
            260,
            10,
            440,
          ),
          item("Description of the displayed groups.", 100, 240, 10, 180),
        ],
        [
          item("Table 1: Group outcomes", 100, 700, 10, 300),
          item("Mean duration", 100, 675, 10, 120),
          item("30 days", 230, 675, 10, 60),
        ],
      ]);
      expectRefs(refs, 7);
      assert.ok(refs[6].text.endsWith("Journal. 2020;7:71-81."));
      assert.ok(
        refs.every(
          (ref) => !/Attached|Description|Mean duration|30 days/.test(ref.text),
        ),
      );
    },
  );
}

await check(
  "a genuine number gap with wrapped publication evidence retains later pages",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 730, 12, 100),
        ...[1, 2, 5, 6].flatMap((n, i) => [
          item(`${n}. Writer${n} A. A neutral document.`, 100, 700 - i * 55),
          item(
            `Journal. 2020;${n}:11-21. doi:10.1000/ref${n}`,
            112,
            682 - i * 55,
          ),
        ]),
      ],
      [7, 8, 9].map((n, i) => item(reference(n), 100, 710 - i * 30)),
    ]);
    assert.deepEqual(
      refs.map((ref) => ref.number),
      [1, 2, 5, 6, 7, 8, 9],
    );
    assert.ok(refs.at(-1).text.includes("10.1000/ref9"));
  },
);

await check(
  "a same-row table label cannot attach to an intermediate reference",
  () => {
    const refs = parser.mergeNumberedRefs([
      continuationLine(reference(1), 700, 100, 0, 440),
      continuationLine(reference(2), 670, 100, 0, 440),
      continuationLine("3. Writer C. A neutral document.", 640, 100, 0, 440),
      continuationLine("Journal. 2020;3:11-21.", 620, 112, 0, 320),
      continuationLine("Answer", 620, 505, 0, 35),
      continuationLine(reference(4), 580, 100, 0, 440),
    ]);
    assert.equal(refs.length, 4);
    assert.ok(!refs.some((ref) => ref.text.includes("Answer")));
  },
);

for (const [previous, tail] of [
  ["3. Writer C. A neutral document examining", "immunohistochemical"],
  ["3. Writer C. A neutral study with", "randomised,"],
  ["3. Writer C. A study of mediators", "and cytokines."],
  ["3. Writer C. A resource [cited", "2023"],
  ["Journal. 2020;3:11-21.", "https://example.org/resource/"],
  ["Journal. 2020;3:11-21.", "10.1000/neutral"],
]) {
  await check(
    `a separately drawn same-row reference fragment retains ${tail}`,
    () => {
      const refs = parser.mergeNumberedRefs([
        continuationLine(reference(1), 700, 100, 0, 440),
        continuationLine(reference(2), 670, 100, 0, 440),
        continuationLine("3. Writer C. A neutral document.", 660, 100, 0, 440),
        continuationLine(previous.replace(/^3\. /, ""), 640, 112, 0, 300),
        continuationLine(tail, 640, 457, 0, 80),
        continuationLine("Journal. 2021;4:31-41.", 620, 112, 0, 320),
        continuationLine(reference(4), 580, 100, 0, 440),
      ]);
      assert.ok(refs.some((ref) => ref.text.includes(tail)));
      assert.ok(
        refs.some((ref) => ref.text.includes("Journal. 2021;4:31-41.")),
      );
    },
  );
}

await check(
  "an ambiguous justified word after an unfinished title remains source text",
  () => {
    const refs = parser.mergeNumberedRefs([
      continuationLine(reference(1), 700, 100, 0, 440),
      continuationLine(reference(2), 670, 100, 0, 440),
      continuationLine("3. Writer C. A neutral document.", 660, 100, 0, 440),
      continuationLine("An investigation of the", 640, 112, 0, 320),
      continuationLine("Answer", 640, 505, 0, 35),
      continuationLine("Journal. 2021;4:31-41.", 620, 112, 0, 320),
      continuationLine(reference(4), 580, 100, 0, 440),
    ]);
    assert.equal(refs.length, 4);
    assert.ok(refs[2].text.includes("the Answer Journal."));
  },
);

await check(
  "horizontal word runs still prove body text beneath a large diagonal layer",
  async () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => [
        item("Publication", 100, 740 - i * 25, 10, 58),
        item("text", 162, 740 - i * 25, 10, 25),
        item(`segment${i}`, 191, 740 - i * 25, 10, 56),
        item("continues.", 251, 740 - i * 25, 10, 58),
      ]).flat(),
      {
        ...item("LARGE DIAGONAL OVERLAY", 200, 400, 40, 250),
        transform: [30, 30, -30, 30, 200, 400],
      },
    ];
    const lines = await parser.readPdfPage({
      _pageInfo: { view: [0, 0, 612, 792] },
      getTextContent: async () => ({ items }),
      getAnnotations: async () => [],
    });
    assert.ok(lines.some((line) => line.text.includes("segment7")));
    assert.ok(!lines.some((line) => line.text.includes("DIAGONAL")));
  },
);

await check(
  "a few long header fragments do not invalidate real slanted main text",
  async () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) =>
        item(`Title segment ${i}`, 100, 770 - i * 12, 6, i < 2 ? 130 : 65),
      ),
      ...Array.from({ length: 3 }, (_, i) => ({
        ...item(reference(i + 1), 100, 540 - i * 40, 16, 350),
        transform: [13.856, 8, -8, 13.856, 100, 540 - i * 40],
      })),
    ];
    const lines = await parser.readPdfPage({
      _pageInfo: { view: [0, 0, 612, 792] },
      getTextContent: async () => ({ items }),
      getAnnotations: async () => [],
    });
    for (let n = 1; n <= 3; n++)
      assert.ok(lines.some((line) => line.text.includes(`10.1000/ref${n}`)));
  },
);

await check(
  "a wrapped reference title about supplementary tables is not a numbered caption",
  async () => {
    const refs = await parse([
      [
        item("References", 100, 730, 12, 100),
        item(reference(1), 100, 700),
        item(reference(2), 100, 670),
        item("3. Writer C. An open data resource:", 100, 640),
        item("Supplementary tables for the 2021 survey.", 112, 622),
        item("Journal. 2022;3:11-21. doi:10.1000/title", 112, 604),
        item(reference(4), 100, 570),
      ],
    ]);
    expectRefs(refs, 4);
    assert.ok(
      refs[2].text.includes("Supplementary tables for the 2021 survey."),
    );
    assert.ok(refs[2].text.endsWith("doi:10.1000/title"));
  },
);

const groupedStudyPages = (sectionHeight = 10) => {
  const row = (text, x, y, height = 8, width = 190) =>
    item(text, x, y, height, width);
  const group = (name, x, y) => [
    row(`${name} 2020 {published data only}`, x, y),
    row(
      `${name} A, Writer B. Neutral ${name.toLowerCase()} document.`,
      x + 16,
      y - 12,
    ),
    row("Journal 2020;1:11–21.", x + 16, y - 24),
  ];
  return [
    [
      row("References", 50, 720),
      row("References to studies included in this review", 50, 700),
      ...group("Alpha", 50, 680),
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
      row("CHARACTERISTICS OF STUDIES", 50, 720, sectionHeight),
      ...(sectionHeight >= 10
        ? [
            row(
              "Characteristics of included studies [ordered by study ID]",
              50,
              685,
              10,
            ),
            row("Neutral 2020", 50, 660),
            row("Methods", 50, 630, 8, 60),
            row("Random allocation", 220, 630, 8, 160),
            row("Participants", 50, 610, 8, 60),
            row("Adult participants", 220, 610, 8, 160),
          ]
        : []),
      row("Neutral methods record 2024 and participant table.", 50, 590),
      row("Review body and outcomes are not publications.", 50, 578),
    ],
  ];
};
const groupedPublicationCoverage = (refs) =>
  ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].filter((name) =>
    refs.some((ref) => ref.text.includes(`${name} A, Writer B.`)),
  );

await check(
  "a grouped study bibliography retains the region before its Additional child category",
  async () => {
    const refs = await parse(groupedStudyPages());
    assert.deepEqual(groupedPublicationCoverage(refs), [
      "Alpha",
      "Bravo",
      "Charlie",
      "Delta",
      "Echo",
      "Foxtrot",
    ]);
    assert.ok(
      refs.every(
        (ref) =>
          ref.page < 2 &&
          !/Neutral methods record|CHARACTERISTICS/.test(ref.text),
      ),
    );
  },
);

for (const labels of [false, true]) {
  await check(
    `${labels ? "status labels alone" : "ordinary Additional references"} do not activate grouped-region recovery`,
    async () => {
      const pages = groupedStudyPages(8).map((page) =>
        page.filter(
          (row) =>
            !row.str.startsWith("References to studies") &&
            !row.str.startsWith("References to ongoing") &&
            (labels || !row.str.includes("{published")),
        ),
      );
      const refs = await parse(pages);
      assert.deepEqual(
        groupedPublicationCoverage(refs),
        labels ? ["Alpha", "Foxtrot"] : ["Foxtrot"],
      );
      assert.equal(refs.length, labels ? 2 : 3);
    },
  );
}

for (const titleHeight of [8, 10]) {
  await check(
    `a ${titleHeight}-point citation title named Characteristics of studies is retained`,
    async () => {
      const pages = groupedStudyPages();
      const first = pages[1].findIndex((row) =>
        row.str.startsWith("Delta 2020"),
      );
      pages[1].splice(
        first,
        3,
        item("Delta 2021 {published data only}", 50, 580, 8, 190),
        item("Delta A, Writer B.", 66, 568, 8, 190),
        item("Characteristics of studies", 66, 556, titleHeight, 190),
        item("Journal 2021;3:201–209.", 66, 544, 8, 190),
      );
      const refs = await parse(pages);
      assert.ok(
        refs.some(
          (ref) =>
            ref.text.includes("Characteristics of studies") &&
            ref.text.includes("Journal 2021;3:201–209."),
        ),
      );
      assert.ok(refs.some((ref) => ref.text.includes("Echo A, Writer B.")));
      assert.ok(
        !refs.some((ref) => ref.text.includes("Neutral methods record")),
      );
    },
  );
}

await check(
  "a larger title on the next page cannot truncate an open grouped citation",
  async () => {
    const pages = groupedStudyPages();
    pages[1].push(
      item("Omega 2021 {published data only}", 320, 580, 8, 190),
      item("Omega A, Writer B.", 336, 568, 8, 190),
    );
    pages.splice(2, 0, [
      item("Characteristics of studies", 50, 720, 10, 190),
      item("Journal 2021;3:201–209.", 50, 706, 8, 190),
      item("Zulu 2020 {published data only}", 50, 650, 8, 190),
      item("Zulu A, Writer B. Neutral document.", 66, 638, 8, 190),
      item("Journal 2020;1:11–21.", 66, 626, 8, 190),
    ]);
    const refs = await parse(pages);
    // Coverage only: the legacy font-based splitter may still split these runs.
    assert.ok(
      refs.some((ref) => ref.text.includes("Characteristics of studies")),
    );
    assert.ok(refs.some((ref) => ref.text.includes("201–209.")));
    assert.ok(refs.some((ref) => ref.text.includes("Zulu A, Writer B.")));
    assert.ok(!refs.some((ref) => ref.text.includes("Neutral methods record")));
  },
);

for (const ordinaryWords of [false, true]) {
  await check(
    `an authorless Characteristics title${ordinaryWords ? " mentioning study fields" : ""} is not a study table`,
    async () => {
      const pages = groupedStudyPages();
      pages.splice(2, 0, [
        item("Characteristics of studies", 50, 720, 10, 190),
        ...(ordinaryWords
          ? [
              item(
                "Methods and Participants in a neutral survey.",
                66,
                708,
                8,
                190,
              ),
            ]
          : []),
        item("Journal 2022;5:301-309.", 66, ordinaryWords ? 696 : 706, 8, 190),
        item("Grove 2021 {published data only}", 50, 650, 8, 190),
        item("Grove A, Writer B. Neutral document.", 66, 638, 8, 190),
        item("Journal 2021;4:201-209.", 66, 626, 8, 190),
        item("Holly 2021 {published data only}", 50, 580, 8, 190),
        item("Holly A, Writer B. Neutral document.", 66, 568, 8, 190),
        item("Journal 2021;4:211-219.", 66, 556, 8, 190),
      ]);
      const refs = await parse(pages);
      assert.ok(
        refs.some((ref) => ref.text.includes("Characteristics of studies")),
      );
      assert.ok(
        refs.some((ref) => ref.text.includes("Journal 2022;5:301-309.")),
      );
      assert.ok(refs.some((ref) => ref.text.includes("Grove A, Writer B.")));
      assert.ok(refs.some((ref) => ref.text.includes("Holly A, Writer B.")));
      assert.ok(
        !refs.some((ref) => ref.text.includes("Neutral methods record")),
      );
    },
  );
}

await check(
  "DOI resolver normalization uses an exact origin and preserves encoded DOI punctuation",
  () => {
    const doi =
      "10.1002/(SICI)1097-0258(19960229)15:4<361::AID-SIM168>3.0.CO;2-4";
    assert.equal(
      text.doiResolverTarget(
        `https://dx.doi.org/${encodeURIComponent(doi)}?download=1`,
      ),
      doi.toLowerCase(),
    );
    assert.equal(
      text.doiResolverTarget("HTTPS://DOI.ORG/10.1000%2FALPHA-BETA"),
      "10.1000/alpha-beta",
    );
    for (const url of [
      "https://doi.org.evil/10.1000/alpha-beta",
      "https://example.org/path/10.1000/alpha-beta",
      "https://doi.org@evil/10.1000/alpha-beta",
      "javascript:https://doi.org/10.1000/alpha-beta",
    ])
      assert.equal(text.doiResolverTarget(url), undefined);
    for (const url of [
      "https://doi.org/10.1000%2Fbad%ZZ",
      "https://doi.org/10.1000%2Fbad%20path",
      "https://doi.org/incorrect",
    ])
      assert.equal(text.doiResolverTarget(url), null);
  },
);

for (const [name, left, right, expected, leftURL, rightURL] of [
  [
    "plain DOI lowercase word",
    "doi:10.1000/bio-",
    "informatics",
    "doi:10.1000/bioinformatics",
  ],
  [
    "resolver DOI lowercase word",
    "https://doi.org/10.1000/im-",
    "muni.2020",
    "https://doi.org/10.1000/immuni.2020",
  ],
  [
    "unrelated resolver is not evidence",
    "doi:10.1000/alpha-",
    "beta",
    "doi:10.1000/alphabeta",
    "https://doi.org/10.1000/unrelated",
  ],
  [
    "lookalike resolver is not evidence",
    "doi:10.1000/alpha-",
    "beta",
    "doi:10.1000/alphabeta",
    "https://doi.org.evil/10.1000/alpha-beta",
  ],
  [
    "exact source confirms a literal lowercase hyphen",
    "doi:10.1000/alpha-",
    "beta",
    "doi:10.1000/alpha-beta",
    "https://doi.org/10.1000%2FALPHA-BETA",
  ],
  [
    "two incompatible candidate links remain ambiguous",
    "doi:10.1000/alpha-",
    "beta",
    "doi:10.1000/alphabeta",
    "https://doi.org/10.1000/alpha-beta",
    "https://doi.org/10.1000/alphabeta",
  ],
  [
    "SICI uppercase separator",
    "doi:10.1002/(SICI)1097-0258(19960229)15:4<361::AID-",
    "SIM168>3.0.CO;2-4",
    "AID-SIM168>3.0.CO;2-4",
  ],
  ["numeric DOI suffix", "doi:10.1000/123-", "456", "doi:10.1000/123-456"],
  [
    "ordinary URL path",
    "https://example.org/treatment-",
    "switching",
    "https://example.org/treatment-switching",
  ],
  [
    "resolver query outside DOI identity",
    "https://doi.org/10.1000/known?label=alpha-",
    "beta",
    "https://doi.org/10.1000/known?label=alpha-beta",
  ],
  [
    "resolver fragment outside DOI identity",
    "https://doi.org/10.1000/known#section-alpha-",
    "beta",
    "https://doi.org/10.1000/known#section-alpha-beta",
  ],
  [
    "publisher URL containing a DOI-like path",
    "https://example.org/10.1000/alpha-",
    "beta",
    "https://example.org/10.1000/alpha-beta",
  ],
]) {
  await check(`DOI line-boundary handling: ${name}`, () => {
    for (const numbered of [true, false]) {
      const lines = [
        {
          ...continuationLine(`${numbered ? "1. " : ""}Smith A. ${left}`, 670),
          url: leftURL,
        },
        {
          ...continuationLine(right, 655, numbered ? 100 : 112),
          url: rightURL,
        },
        continuationLine(
          numbered ? reference(2) : "Brown A. Study. Journal. 2020;2:22-30.",
          620,
        ),
        continuationLine(
          numbered ? reference(3) : "White A. Study. Journal. 2020;3:31-40.",
          590,
        ),
      ];
      const refs = parser.mergeSameRef(lines);
      assert.equal(refs.length, 3);
      assert.ok(refs[0].text.includes(expected), refs[0].text);
    }
  });
}

for (const [name, printedDOI, annotation, expectedURL] of [
  [
    "source annotation retains precedence over an uncertain merged DOI",
    "10.1000/alpha-beta",
    "https://doi.org/10.1000/unrelated",
    "https://doi.org/10.1000/unrelated",
  ],
  [
    "encoded matching DOI remains usable",
    "10.1000/alpha-beta",
    "https://dx.doi.org/10.1000%2FALPHA-BETA?view=full",
    "https://dx.doi.org/10.1000%2FALPHA-BETA?view=full",
  ],
  [
    "source annotation retains legacy precedence even when its resolver is malformed",
    "10.1000/alpha-beta",
    "https://doi.org/incorrect",
    "https://doi.org/incorrect",
  ],
  [
    "publisher URL remains usable",
    "10.1000/alpha-beta",
    "https://publisher.example/article/42",
    "https://publisher.example/article/42",
  ],
  [
    "PDF URL remains usable",
    "10.1000/alpha-beta",
    "https://publisher.example/paper.pdf",
    "https://publisher.example/paper.pdf",
  ],
  [
    "ordinary path containing DOI remains usable",
    "10.1000/alpha-beta",
    "https://publisher.example/10.1000/other",
    "https://publisher.example/10.1000/other",
  ],
  [
    "annotation usable when print has no DOI",
    undefined,
    "https://doi.org/10.1000/source",
    "https://doi.org/10.1000/source",
  ],
  [
    "unsafe scheme stays rejected",
    "10.1000/alpha-beta",
    "file:///tmp/paper",
    "https://doi.org/10.1000%2Falpha-beta",
  ],
]) {
  await check(`PDF annotation identity: ${name}`, async () => {
    const pages = [oneColumn(6)];
    const citation = `3. Writer C. A neutral study. Journal. 2020;3:31-41.${printedDOI ? ` doi:${printedDOI}` : ""}`;
    pages[0][3] = item(citation, 100, 610);
    const fixture = readFixture(pages, {
      annotations: () => [{ rect: [100, 610, 450, 620], url: annotation }],
    });
    const refs = await parser.parsePDFReferences(fixture.reader);
    expectRefs(refs, 6);
    assert.equal(refs[2].text, citation.replace(/^3\. /, ""));
    assert.equal(refs[2].identifiers.DOI, printedDOI);
    assert.equal(refs[2].url, expectedURL);
    assert.deepEqual(fixture.annotations, [0]);
  });
}

for (const [name, citation, url] of [
  [
    "unicode DOI hyphens",
    "Journal. 2021;16:425-434. doi:10.1007/s11523 ‐ 021 ‐ 00818 ‐ 1",
    "https://doi.org/10.1007/s11523-021-00818-1",
  ],
  [
    "partial date-like DOI suffix",
    "Journal. 2024;1:11-21. doi:10.1016/j.neutral.2024.09.014",
    "https://doi.org/10.1016/j.neutral.2024.09.014",
  ],
  [
    "mixed-case DOI suffix",
    "Journal. 2020;1:11-21. doi:10.7554/eLife.26476",
    "https://doi.org/10.7554/eLife.26476",
  ],
  [
    "year attached after DOI",
    "Journal. 2020;1:11-21. doi:10.1000/neutral; 2026",
    "https://doi.org/10.1000/neutral",
  ],
  [
    "two citations already merged",
    "Journal. 2020;1:11-21. doi:10.1000/first. Writer D. Second document. Journal. 2021;2:31-41. doi:10.1000/second",
    "https://doi.org/10.1000/second",
  ],
  [
    "a stray footer supplies the only parsed DOI",
    "Journal. 2017;111:176-181. Footer A. Host Journal. 2023;11:e007023. doi:10.1000/host-2023-007023",
    "https://doi.org/10.1000/reference-2017-024",
  ],
]) {
  await check(`source DOI link compatibility: ${name}`, async () => {
    const pages = [oneColumn(6)];
    const raw = `3. Writer C. Neutral document. ${citation}`;
    pages[0][3] = item(raw, 100, 610);
    const fixture = readFixture(pages, {
      annotations: () => [{ rect: [100, 610, 450, 620], url }],
    });
    const refs = await parser.parsePDFReferences(fixture.reader);
    expectRefs(refs, 6);
    assert.equal(refs[2].url, url);
    assert.equal(refs[2].text, raw.replace(/^3\. /, ""));
    assert.deepEqual(
      refs[2].identifiers,
      text.extractIdentifiers(refs[2].text),
    );
    assert.deepEqual(fixture.annotations, [0]);
  });
}

const justifiedCitation = () => [
  continuationLine(reference(1), 700, 100, 0, 440),
  continuationLine(reference(2), 670, 100, 0, 440),
  continuationLine("3. Writer C. A neutral document.", 640, 100, 0, 440),
  continuationLine("prognosis.", 620, 112, 0, 35),
  continuationLine("Neutral", 620, 188, 0, 20),
  continuationLine("Journal", 620, 249, 0, 32),
  continuationLine("2020;3:", 620, 322, 0, 32),
  continuationLine("31-41.", 620, 395, 0, 145),
  continuationLine("doi:10.1000/neutral", 600, 112, 0, 300),
];
for (const final of [false, true]) {
  await check(
    `a ${final ? "final" : "non-final"} justified row keeps all fragments and its wrapped DOI`,
    () => {
      const lines = justifiedCitation();
      if (!final) lines.push(continuationLine(reference(4), 570, 100, 0, 440));
      const refs = parser.mergeNumberedRefs(lines);
      assert.equal(refs.length, final ? 3 : 4);
      assert.ok(
        refs[2].text.endsWith(
          "prognosis. Neutral Journal 2020;3: 31-41. doi:10.1000/neutral",
        ),
      );
      assert.equal(refs[2].x, 100);
      assert.equal(refs[2].y, 640);
    },
  );
}
await check(
  "a missing intermediate row fragment cannot bridge the existing maximum gap",
  () => {
    const lines = justifiedCitation().filter((line) => line.text !== "Journal");
    const refs = parser.mergeNumberedRefs(lines);
    assert.equal(refs.length, 3);
    assert.ok(refs[2].text.includes("prognosis. Neutral"));
    assert.ok(!refs[2].text.includes("2020;3:"));
    assert.ok(!refs[2].text.includes("31-41."));
    assert.ok(refs[2].text.endsWith("doi:10.1000/neutral"));
  },
);
for (const final of [false, true]) {
  await check(
    `a completed composite row rejects later unrelated text (${final ? "final" : "non-final"})`,
    () => {
      const lines = justifiedCitation().slice(0, 5);
      lines.push(
        continuationLine("Journal. 2020;3:31-41.", 620, 249, 0, 130),
        continuationLine("Unrelated caption", 620, 420, 0, 120),
        continuationLine("another fragment", 620, 541, 0, 100),
        continuationLine("doi:10.1000/neutral", 600, 112, 0, 300),
      );
      if (!final) lines.push(continuationLine(reference(4), 570, 100, 0, 440));
      const refs = parser.mergeNumberedRefs(lines);
      assert.equal(refs.length, final ? 3 : 4);
      assert.ok(!refs[2].text.includes("caption"));
      assert.ok(!refs[2].text.includes("another fragment"));
      assert.ok(refs[2].text.endsWith("doi:10.1000/neutral"));
    },
  );
}
for (const [name, bad] of [
  ["leftward overlap", continuationLine("Side label", 620, 120, 0, 40)],
  ["another column", continuationLine("Other column", 620, 600, 0, 250)],
  [
    "row boundary cannot expand repeatedly",
    continuationLine("Outside label", 620, 541, 0, 80),
  ],
  [
    "earlier physical page",
    continuationLine("Old page label", 620, 249, -1, 80),
  ],
]) {
  await check(
    `a composite row rejects ${name} without losing its next wrapped line`,
    () => {
      const lines = justifiedCitation().slice(0, 5);
      lines.push(
        bad,
        continuationLine("doi:10.1000/neutral", 600, 112, 0, 300),
        continuationLine(reference(4), 570, 100, 0, 440),
      );
      const refs = parser.mergeNumberedRefs(lines);
      assert.equal(refs.length, 4);
      assert.ok(!refs[2].text.includes(bad.text));
      assert.ok(refs[2].text.endsWith("doi:10.1000/neutral"));
    },
  );
}
await check(
  "a completed composite row rejects body text on another page",
  () => {
    const lines = justifiedCitation().slice(0, 8);
    lines.push(continuationLine("Unrelated next-page body", 700, 112, 1, 350));
    const refs = parser.mergeNumberedRefs(lines);
    assert.equal(refs.length, 3);
    assert.ok(!refs[2].text.includes("next-page"));
    assert.ok(refs[2].text.endsWith("31-41."));
  },
);
await check(
  "a composite publication tail retains a same-row DOI label and wrapped value",
  () => {
    const lines = justifiedCitation().slice(0, 5);
    lines.push(
      continuationLine("Journal. 2020;3:31-41.", 620, 249, 0, 130),
      continuationLine("doi:", 620, 420, 0, 35),
      continuationLine("Unrelated", 620, 490, 0, 45),
      continuationLine("10.1000/neutral", 600, 112, 0, 300),
    );
    const refs = parser.mergeNumberedRefs(lines);
    assert.equal(refs.length, 3);
    assert.ok(refs[2].text.endsWith("31-41. doi: 10.1000/neutral"));
    assert.ok(!refs[2].text.includes("Unrelated"));
  },
);
await check(
  "a composite publication tail retains Accessed and a later same-row date",
  () => {
    const lines = justifiedCitation().slice(0, 5);
    lines.push(
      continuationLine("Journal. 2020;3:31-41.", 620, 249, 0, 100),
      continuationLine("Accessed", 620, 395, 0, 45),
      continuationLine("2023", 620, 485, 0, 45),
      continuationLine("doi:10.1000/neutral", 600, 112, 0, 300),
    );
    const refs = parser.mergeNumberedRefs(lines);
    assert.equal(refs.length, 3);
    assert.ok(
      refs[2].text.endsWith("31-41. Accessed 2023 doi:10.1000/neutral"),
    );
  },
);

console.log(
  `Parser regression: ${passed} checks passed (synthetic text only).`,
);
