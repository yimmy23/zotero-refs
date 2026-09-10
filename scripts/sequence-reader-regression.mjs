/** Reader identity and resource guards; in-memory sources and virtual time only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { fileURLToPath, URL } from "node:url";
import { buildSync, transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const coreBundle = buildSync({
  entryPoints: [root + "src/pdf/sequenceCore.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { extractSequenceReferences } = await import(
  `data:text/javascript;base64,${Buffer.from(coreBundle.outputFiles[0].text).toString("base64")}`
);
const readerCode = transformSync(
  fs.readFileSync(root + "src/pdf/sequenceReader.ts", "utf8"),
  { loader: "ts", format: "cjs", target: "es2022" },
).code;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function clock() {
  let pending = [];
  const requested = [];
  return {
    requested,
    delay(ms) {
      requested.push(ms);
      if (ms === 0) return Promise.resolve();
      const gate = deferred();
      pending.push(gate);
      return gate.promise;
    },
    async tick() {
      const prior = pending;
      pending = [];
      for (const gate of prior) gate.resolve();
      await flush();
    },
  };
}
function loadReader(time, extractionCalls) {
  const module = { exports: {} };
  new Function("module", "exports", "require", "Zotero", readerCode)(
    module,
    module.exports,
    (name) => {
      if (name === "./sequenceCore")
        return {
          extractSequenceReferences: (pages, options) => {
            extractionCalls.push({ pages, options });
            return extractSequenceReferences(pages, options);
          },
        };
      // Field parsing is independently covered elsewhere. This suite observes
      // the adapter's source identity, geometry and extraction call contract.
      if (name === "../core/text")
        return { refTextToInfo: (text) => ({ title: text }) };
      throw new Error(`Unexpected reader dependency: ${name}`);
    },
    { Promise: { delay: time.delay } },
  );
  return module.exports.parseSequencePDFReferences;
}
const run = (str, y, x = 50) => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width: Math.min(450, str.length * 4),
  height: 10,
  fontName: "Neutral",
  dir: "ltr",
});
const bibliography = () => ({
  items: [
    run("References", 710),
    run("[1] Smith AB. A neutral study. Example Journal 2020;12:34-56.", 690),
    run(
      "[2] Brown CD. Another neutral study. Example Journal 2021;13:57-68.",
      670,
    ),
  ],
});
function fixture(count = 2) {
  const time = clock(),
    extractionCalls = [],
    reads = [];
  const pdfPages = Array.from({ length: count }, (_, index) => ({
    view: [0, 0, 612, 792],
    getTextContent: async () => {
      reads.push(index);
      return bibliography();
    },
  }));
  const document = {
    numPages: count,
    getPage: async (number) => pdfPages[number - 1],
  };
  const app = {
    page: count,
    pdfDocument: document,
    pdfLoadingTask: { promise: Promise.resolve(document) },
    pdfViewer: {
      pagesPromise: Promise.resolve(),
      _pages: pdfPages.map((pdfPage) => ({ pdfPage })),
    },
  };
  const view = { _iframeWindow: { PDFViewerApplication: app } };
  const internal = { _primaryView: view };
  const reader = { itemID: 42, _internalReader: internal };
  return {
    time,
    extractionCalls,
    reads,
    pdfPages,
    document,
    app,
    view,
    internal,
    reader,
    parse: loadReader(time, extractionCalls),
  };
}
function errorResult(result, code, status = "error") {
  assert.equal(result.extraction.status, status);
  assert.deepEqual(result.refs, []);
  assert(
    result.extraction.diagnostics.some((item) => item.code === code),
    `Missing diagnostic ${code}`,
  );
  assert.equal(result.extraction.coverage.complete, false);
}

test("all pages are read exactly once and successful coverage is complete", async () => {
  const f = fixture();
  f.pdfPages[0].getTextContent = async () => {
    f.reads.push(0);
    return { items: [run("Neutral article body", 710)] };
  };
  const progress = [];
  const result = await f.parse(f.reader, {
    onProgress: (...args) => progress.push(args),
  });
  assert.deepEqual(f.reads, [0, 1]);
  assert.deepEqual(progress, [
    [1, 2],
    [2, 2],
  ]);
  assert.deepEqual(result.extraction.coverage, {
    providedPages: [0, 1],
    expectedPages: 2,
    complete: true,
  });
  assert(result.refs.length > 0);
  assert(
    f.time.requested
      .filter((value) => value !== 0)
      .every((value) => value === 100),
  );
});

const sourceMutations = [
  [
    "itemID",
    (f) => {
      f.reader.itemID = 43;
    },
  ],
  [
    "internal reader",
    (f) => {
      f.reader._internalReader = { ...f.internal };
    },
  ],
  [
    "active view",
    (f) => {
      f.internal._primaryView = { ...f.view };
    },
  ],
  [
    "application",
    (f) => {
      f.view._iframeWindow.PDFViewerApplication = { ...f.app };
    },
  ],
  [
    "viewer",
    (f) => {
      f.app.pdfViewer = { ...f.app.pdfViewer };
    },
  ],
  [
    "loading task",
    (f) => {
      f.app.pdfLoadingTask = { ...f.app.pdfLoadingTask };
    },
  ],
  [
    "document",
    (f) => {
      f.app.pdfDocument = { ...f.document };
    },
  ],
  [
    "page array",
    (f) => {
      f.app.pdfViewer._pages = [...f.app.pdfViewer._pages];
    },
  ],
];
for (const [name, mutate] of sourceMutations)
  test(`rejects ${name} replacement while text extraction is pending`, async () => {
    const f = fixture(1),
      gate = deferred();
    let called = false;
    f.pdfPages[0].getTextContent = () => {
      called = true;
      return gate.promise;
    };
    const work = f.parse(f.reader);
    await flush();
    assert(called);
    mutate(f);
    gate.resolve(bibliography());
    const result = await work;
    errorResult(result, "sequence-source-changed");
    assert.equal(result.pages.length, 0);
  });

test("initial existing document cannot change while the loading promise waits", async () => {
  const f = fixture(1),
    gate = deferred();
  f.app.pdfLoadingTask.promise = gate.promise;
  const work = f.parse(f.reader);
  await flush();
  f.app.pdfDocument = { ...f.document };
  gate.resolve(f.document);
  errorResult(await work, "sequence-source-changed");
  assert.deepEqual(f.reads, []);
});
test("initial existing page array cannot change while viewer readiness waits", async () => {
  const f = fixture(1),
    gate = deferred();
  f.app.pdfViewer.pagesPromise = gate.promise;
  const work = f.parse(f.reader);
  await flush();
  f.app.pdfViewer._pages = [...f.app.pdfViewer._pages];
  gate.resolve();
  errorResult(await work, "sequence-source-changed");
});
test("an initially unavailable document may resolve once during normal loading", async () => {
  for (const initial of [undefined, null]) {
    const f = fixture(1),
      gate = deferred();
    f.app.pdfDocument = initial;
    f.app.pdfLoadingTask.promise = gate.promise;
    const work = f.parse(f.reader);
    await flush();
    f.app.pdfDocument = f.document;
    gate.resolve(f.document);
    const result = await work;
    assert(result.refs.length > 0);
    assert.equal(result.extraction.coverage.complete, true);
  }
});
test("from-current-page snapshots the initial physical page despite later navigation", async () => {
  const f = fixture(3),
    gate = deferred();
  f.app.page = 2;
  f.pdfPages[0].getTextContent = () => gate.promise;
  const work = f.parse(f.reader, { fromCurrentPage: true });
  await flush();
  f.app.page = 3;
  gate.resolve(bibliography());
  await work;
  assert.equal(f.extractionCalls.at(-1).options.fromPage, 1);
  assert.equal(f.extractionCalls.at(-1).options.totalPages, 3);
});
test("last-view fallback has the same source identity guard", async () => {
  const f = fixture(1),
    gate = deferred();
  delete f.internal._primaryView;
  f.internal._lastView = f.view;
  f.pdfPages[0].getTextContent = () => gate.promise;
  const work = f.parse(f.reader);
  await flush();
  f.internal._lastView = { ...f.view };
  gate.resolve(bibliography());
  errorResult(await work, "sequence-source-changed");
});
test("lazy document getPage is guarded across its await", async () => {
  const f = fixture(1),
    gate = deferred();
  delete f.app.pdfViewer._pages;
  f.document.getPage = () => gate.promise;
  const work = f.parse(f.reader);
  await flush();
  f.reader.itemID++;
  gate.resolve(f.pdfPages[0]);
  errorResult(await work, "sequence-source-changed");
  assert.deepEqual(f.reads, []);
});
test("source changes after progress never return cached partial references", async () => {
  const f = fixture(2);
  const result = await f.parse(f.reader, {
    onProgress: () => {
      f.reader.itemID++;
    },
  });
  errorResult(result, "sequence-source-changed");
  assert.deepEqual(result.extraction.coverage.providedPages, [0]);
});
test("invalid counts fail before any text request", async () => {
  for (const value of [0, -1, 1.5, Number.NaN, "2"]) {
    const f = fixture(1);
    f.document.numPages = value;
    errorResult(await f.parse(f.reader), "sequence-invalid-page-count");
    assert.deepEqual(f.reads, []);
  }
});
test("page budget is explicit and the declared count is retained", async () => {
  const f = fixture(1);
  f.document.numPages = 501;
  const result = await f.parse(f.reader);
  errorResult(result, "sequence-page-budget", "limited");
  assert.equal(result.extraction.coverage.expectedPages, 501);
  assert.deepEqual(f.reads, []);
});
test("500-page boundary remains permitted with one text call per page", async () => {
  const f = fixture(500);
  for (let i = 0; i < 500; i++)
    f.pdfPages[i].getTextContent = async () => {
      f.reads.push(i);
      return { items: [] };
    };
  const result = await f.parse(f.reader);
  assert.equal(f.reads.length, 500);
  assert.equal(new Set(f.reads).size, 500);
  assert.equal(result.extraction.coverage.complete, true);
  assert.notEqual(result.extraction.status, "limited");
});
test("run budget rejects an over-limit page before cloning its runs", async () => {
  const f = fixture(1);
  f.pdfPages[0].getTextContent = async () => ({
    items: new Array(250_001).fill(null),
  });
  const result = await f.parse(f.reader);
  errorResult(result, "sequence-run-budget", "limited");
  assert.equal(result.pages.length, 0);
});
test("character budget rejects an over-limit page before storing its text", async () => {
  const f = fixture(1);
  f.pdfPages[0].getTextContent = async () => ({
    items: [{ str: "x".repeat(8_000_001) }],
  });
  const result = await f.parse(f.reader);
  errorResult(result, "sequence-character-budget", "limited");
  assert.equal(result.pages.length, 0);
});
test("run and character budgets accumulate across pages", async () => {
  for (const [items, code] of [
    [new Array(125_001).fill(run("", 0)), "sequence-run-budget"],
    [[run("x".repeat(4_000_001), 0)], "sequence-character-budget"],
  ]) {
    const f = fixture(2);
    for (const page of f.pdfPages)
      page.getTextContent = async () => ({ items });
    const result = await f.parse(f.reader);
    errorResult(result, code, "limited");
    assert.equal(result.pages.length, 1);
    assert.deepEqual(result.extraction.coverage, {
      providedPages: [0],
      expectedPages: 2,
      complete: false,
    });
  }
});
test("read exceptions retain incomplete coverage without partial refs", async () => {
  const f = fixture(2);
  f.pdfPages[1].getTextContent = async () => {
    throw new Error("neutral-read-failure");
  };
  const result = await f.parse(f.reader);
  errorResult(result, "neutral-read-failure");
  assert.deepEqual(result.extraction.coverage, {
    providedPages: [0],
    expectedPages: 2,
    complete: false,
  });
  assert.equal(result.extraction.metrics.pages, 1);
  assert.equal(result.extraction.metrics.runs, 3);
});
test("early cancellation has unknown coverage and distinct cancelled status", async () => {
  const f = fixture(1);
  const result = await f.parse(f.reader, { shouldCancel: () => true });
  errorResult(result, "sequence-cancelled", "cancelled");
  assert.equal(result.extraction.coverage.expectedPages, undefined);
  assert.deepEqual(f.reads, []);
});
test("cancellation interrupts a never-resolving text request on virtual polling", async () => {
  const f = fixture(1);
  let cancel = false;
  f.pdfPages[0].getTextContent = () => new Promise(() => {});
  const work = f.parse(f.reader, { shouldCancel: () => cancel });
  await flush();
  cancel = true;
  await f.time.tick();
  errorResult(await work, "sequence-cancelled", "cancelled");
});
test("pending reads have a finite 300 by 100ms polling deadline", async () => {
  const f = fixture(1);
  f.pdfPages[0].getTextContent = () => new Promise(() => {});
  const work = f.parse(f.reader);
  await flush();
  for (let i = 0; i < 300; i++) await f.time.tick();
  errorResult(await work, "sequence-read-timeout");
  assert(f.time.requested.every((ms) => ms === 0 || ms === 100));
});
test("nonzero crop origin is preserved with original run transforms", async () => {
  const f = fixture(1),
    content = bibliography();
  f.pdfPages[0].view = [-20, 30, 592, 822];
  f.pdfPages[0].getTextContent = async () => content;
  const result = await f.parse(f.reader);
  assert.deepEqual(result.pages[0].origin, [-20, 30]);
  assert.equal(result.pages[0].width, 612);
  assert.equal(result.pages[0].height, 792);
  assert.deepEqual(
    result.pages[0].items[1].transform,
    content.items[1].transform,
  );
  assert.notEqual(
    result.pages[0].items[1].transform,
    content.items[1].transform,
  );
  assert.equal(result.refs[0].x, 50);
  assert.equal(result.refs[0].y, 700);
  result.pages[0].items[1].transform[4] = 999;
  assert.equal(content.items[1].transform[4], 50);
});
test("invalid crop boxes are source-shape errors", async () => {
  for (const box of [
    [0, 0, Number.NaN, 792],
    [0, 0, 0, 792],
    [0, 0, 612, 0],
  ]) {
    const f = fixture(1);
    f.pdfPages[0].view = box;
    errorResult(await f.parse(f.reader), "sequence-page-shape");
  }
});
test("unavailable reader reports unsupported and unknown coverage", async () => {
  const f = fixture(1);
  const result = await f.parse({});
  errorResult(result, "sequence-reader-unavailable", "unsupported");
  assert.equal(result.extraction.coverage.expectedPages, undefined);
});
test("core distinguishes unknown subset coverage from known incomplete coverage", () => {
  const page = {
    page: 0,
    width: 612,
    height: 792,
    items: bibliography().items,
  };
  const unknown = extractSequenceReferences([page]);
  const incomplete = extractSequenceReferences([page], { totalPages: 2 });
  const complete = extractSequenceReferences([page], { totalPages: 1 });
  assert.equal(unknown.coverage.expectedPages, undefined);
  assert.equal(unknown.coverage.complete, false);
  assert(
    unknown.diagnostics.some((item) => item.code === "input-coverage-unknown"),
  );
  assert.equal(incomplete.coverage.complete, false);
  assert(
    incomplete.diagnostics.some(
      (item) => item.code === "incomplete-page-coverage",
    ),
  );
  assert.equal(complete.coverage.complete, true);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(
  `${tests.length - failures}/${tests.length} sequence reader checks passed`,
);
if (failures) process.exitCode = 1;
