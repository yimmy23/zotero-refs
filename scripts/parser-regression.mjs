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
function compile(relative, imports = {}, extra = "") {
  const source = fs.readFileSync(root + relative, "utf8") + extra;
  const code = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;
  const module = { exports: {} };
  new Function("module", "exports", "require", "ztoolkit", "Zotero", code)(
    module,
    module.exports,
    (name) => {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
    toolkit,
    { Promise: { delay: async () => {} } },
  );
  return module.exports;
}
const text = compile("src/core/text.ts");
const parser = compile(
  "src/pdf/parser.ts",
  {
    "../core/text": text,
    "../utils/prefs": { getPref: () => 4 },
    "../utils/locale": { getString: (key) => key },
  },
  "\nexport { mergeSameLine, mergeSameRef, mergeNumberedRefs, numAtStart, findLineNumbers, restoreNumberedColumnOrder, readPdfPage };\n",
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

console.log(
  `Parser regression: ${passed} checks passed (synthetic text only).`,
);
