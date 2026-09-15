/** Production parser/session tests against reader-owned in-memory doubles only. */
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { transformSync } from "esbuild";

const { AbortController } = globalThis;
const root = fileURLToPath(new URL("../", import.meta.url));
function compile(file, imports = {}, globals = {}) {
  const code = transformSync(fs.readFileSync(root + file, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;
  const module = { exports: {} };
  const values = {
    ztoolkit: {
      log() {},
      getDOMParser() {
        throw Error("No HTML");
      },
    },
    Zotero: { Promise: { delay: async () => {} } },
    ...globals,
  };
  new Function("module", "exports", "require", ...Object.keys(values), code)(
    module,
    module.exports,
    (name) => {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
    ...Object.values(values),
  );
  return module.exports;
}
const text = compile("src/core/text.ts");
const grouped = compile("src/pdf/groupedReferences.ts");
const groupedStudy = compile("src/pdf/groupedStudyReferences.ts");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function environment() {
  let now = 0,
    id = 0;
  const timers = new Map();
  const caches = [];
  class ObservedMap extends Map {
    constructor(...args) {
      super(...args);
      caches.push(this);
    }
  }
  const timerAPI = {
    setTimeout(fn, ms) {
      const handle = id++;
      timers.set(handle, { fn, at: now + ms });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  };
  const session = compile(
    "src/pdf/parserSession.ts",
    { "../utils/window": timerAPI },
    { Date: { now: () => now } },
  );
  const parser = compile(
    "src/pdf/parser.ts",
    {
      "../core/text": text,
      "./groupedReferences": grouped,
      "./groupedStudyReferences": groupedStudy,
      "./parserSession": session,
      "../utils/prefs": { getPref: () => 4 },
      "../utils/locale": { getString: (key) => key },
    },
    { Map: ObservedMap },
  );
  return {
    parser,
    timers,
    assertReleased(pages) {
      assert.equal(
        timers.size,
        0,
        "all session poll timers released, including handle 0",
      );
      for (const map of caches)
        for (const page of pages)
          assert.equal(map.has(page), false, "probe cache released");
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
const item = (str, y = 650, x = 100, width = 350) => ({
  str,
  height: 10,
  width,
  transform: [10, 0, 0, 10, x, y],
});
const reference = (n) =>
  `${n}. Writer A. Clinical study. Journal. 2020;1:11-21. doi:10.1000/ref${n}`;
const normal = () => [
  item("References", 730),
  ...Array.from({ length: 6 }, (_, i) => item(reference(i + 1), 700 - i * 20)),
];
function fixture(items = normal(), count = 1) {
  const calls = { text: 0, annotations: 0, progress: 0, destroyed: 0 };
  const pages = Array.from({ length: count }, () => ({
    _pageInfo: { view: [0, 0, 612, 2000] },
    getTextContent: async () => {
      calls.text++;
      return { items };
    },
    getAnnotations: async () => {
      calls.annotations++;
      return [];
    },
    cleanup() {
      calls.destroyed++;
    },
  }));
  const app = {
    page: count,
    pdfDocument: {},
    pdfLoadingTask: {
      promise: Promise.resolve(),
      destroy() {
        calls.destroyed++;
      },
    },
    pdfViewer: {
      pagesPromise: Promise.resolve(),
      _pages: pages.map((pdfPage) => ({ pdfPage })),
    },
  };
  const win = { PDFViewerApplication: app };
  const view = { _iframeWindow: win };
  const reader = { itemID: 1, _internalReader: { _primaryView: view } };
  return { items, pages, app, win, view, reader, calls };
}
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

for (const phase of [
  "loading",
  "pages",
  "probe-text",
  "page-text",
  "page-annotations",
]) {
  await check(
    `deadline releases ${phase} and ignores late resolution`,
    async () => {
      const env = environment(),
        f = fixture(normal(), phase === "probe-text" ? 3 : 1),
        gate = deferred();
      if (phase === "loading") f.app.pdfLoadingTask.promise = gate.promise;
      if (phase === "pages") f.app.pdfViewer.pagesPromise = gate.promise;
      if (phase.includes("text"))
        for (const page of f.pages)
          page.getTextContent = () => {
            f.calls.text++;
            return gate.promise;
          };
      if (phase === "page-annotations")
        f.pages[0].getAnnotations = () => {
          f.calls.annotations++;
          return gate.promise;
        };
      const pending = env.parser.parsePDFReferencesDetailed(f.reader, {
        deadline: 40,
        onProgress: () => f.calls.progress++,
      });
      await settle();
      await env.advance(40);
      const result = await pending;
      assert.deepEqual(result.refs, []);
      assert.equal(result.diagnostics.status, "limited");
      assert.deepEqual(result.diagnostics.interruption, {
        reason: "deadline",
        phase,
      });
      assert.ok(result.diagnostics.warnings.includes("pdf-deadline-exceeded"));
      env.assertReleased(f.pages);
      const before = JSON.stringify({
        calls: f.calls,
        diagnostics: result.diagnostics,
      });
      gate.resolve(phase.includes("text") ? { items: f.items } : []);
      await settle();
      assert.equal(
        JSON.stringify({ calls: f.calls, diagnostics: result.diagnostics }),
        before,
      );
      env.assertReleased(f.pages);
      assert.equal(
        f.calls.destroyed,
        0,
        "reader-owned tasks/pages must remain usable by Zotero",
      );
    },
  );
}
await check(
  "deadline is shared across waits and array API reports diagnostics once",
  async () => {
    const env = environment(),
      f = fixture(),
      load = deferred(),
      pages = deferred();
    f.app.pdfLoadingTask.promise = load.promise;
    f.app.pdfViewer.pagesPromise = pages.promise;
    const diagnostics = [];
    const pending = env.parser.parsePDFReferences(f.reader, {
      deadline: 40,
      onDiagnostics: (d) => diagnostics.push(d),
    });
    await settle();
    await env.advance(25);
    load.resolve();
    await settle();
    await env.advance(15);
    assert.deepEqual(await pending, []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].interruption.phase, "pages");
    env.assertReleased(f.pages);
  },
);
await check(
  "default 30 second deadline also bounds the production array route",
  async () => {
    const env = environment(),
      f = fixture();
    f.app.pdfLoadingTask.promise = new Promise(() => {});
    const pending = env.parser.parsePDFReferences(f.reader);
    await settle();
    await env.advance(29_999);
    assert.equal(env.timers.size, 1);
    await env.advance(1);
    assert.deepEqual(await pending, []);
    env.assertReleased(f.pages);
  },
);
for (const kind of ["callback", "signal", "pre-aborted", "progress"]) {
  await check(
    `cancellation via ${kind} exits without stale processing`,
    async () => {
      const env = environment(),
        f = fixture(),
        gate = deferred();
      let cancelled = false,
        listeners = 0;
      const controller = new AbortController();
      const add = controller.signal.addEventListener.bind(controller.signal),
        remove = controller.signal.removeEventListener.bind(controller.signal);
      controller.signal.addEventListener = (...args) => {
        listeners++;
        return add(...args);
      };
      controller.signal.removeEventListener = (...args) => {
        listeners--;
        return remove(...args);
      };
      if (kind === "pre-aborted") controller.abort();
      else if (kind !== "progress")
        f.pages[0].getTextContent = () => gate.promise;
      const pending = env.parser.parsePDFReferencesDetailed(f.reader, {
        deadline: 1000,
        shouldCancel: () => cancelled,
        signal: controller.signal,
        onProgress: () => {
          if (kind === "progress") cancelled = true;
        },
      });
      await settle();
      if (kind === "callback") {
        cancelled = true;
        await env.advance(50);
      }
      if (kind === "signal") controller.abort();
      const result = await pending;
      assert.equal(result.diagnostics.status, "cancelled");
      assert.deepEqual(result.refs, []);
      assert.equal(result.diagnostics.interruption.reason, "cancelled");
      assert.equal(listeners, 0);
      env.assertReleased(f.pages);
      gate.resolve({ items: f.items });
      await settle();
      assert.equal(f.calls.annotations, 0);
    },
  );
}
const replacements = {
  item: (f) => f.reader.itemID++,
  internal: (f) => {
    f.reader._internalReader = { _primaryView: f.view };
  },
  view: (f) => {
    f.reader._internalReader._primaryView = { _iframeWindow: f.win };
  },
  window: (f) => {
    f.view._iframeWindow = { PDFViewerApplication: f.app };
  },
  app: (f) => {
    f.win.PDFViewerApplication = { ...f.app };
  },
  loading: (f) => {
    f.app.pdfLoadingTask = { ...f.app.pdfLoadingTask };
  },
  viewer: (f) => {
    f.app.pdfViewer = { ...f.app.pdfViewer };
  },
  document: (f) => {
    f.app.pdfDocument = {};
  },
  pages: (f) => {
    f.app.pdfViewer._pages = [...f.app.pdfViewer._pages];
  },
  proxy: (f) => {
    f.app.pdfViewer._pages[0].pdfPage = { ...f.pages[0] };
  },
  closed: (f) => {
    f.win.closed = true;
  },
};
for (const [name, replace] of Object.entries(replacements)) {
  await check(`source ${name} replacement cancels a hung wait`, async () => {
    const env = environment(),
      f = fixture(),
      gate = deferred();
    f.app.pdfViewer.pagesPromise = gate.promise;
    const pending = env.parser.parsePDFReferencesDetailed(f.reader);
    await settle();
    replace(f);
    await env.advance(50);
    const result = await pending;
    assert.equal(result.diagnostics.status, "cancelled");
    assert.equal(result.diagnostics.interruption.reason, "source-changed");
    assert.deepEqual(result.refs, []);
    env.assertReleased(f.pages);
    gate.resolve();
    await settle();
    assert.equal(f.calls.text, 0);
  });
}
await check("dead reader getters resolve with source diagnostics", async () => {
  const env = environment();
  const reader = {
    get itemID() {
      throw new Error("dead wrapper");
    },
  };
  const result = await env.parser.parsePDFReferencesDetailed(reader);
  assert.deepEqual(result.refs, []);
  assert.equal(result.diagnostics.interruption.reason, "source-changed");
  env.assertReleased([]);
});
await check(
  "normal extraction does not mutate reader-owned text and frees every timer",
  async () => {
    const env = environment(),
      f = fixture();
    f.pages[0].getAnnotations = async () => [
      { rect: [100, 700, 450, 710], url: "https://example.org/citation" },
    ];
    const source = JSON.stringify(f.items);
    const result = await env.parser.parsePDFReferencesDetailed(f.reader);
    assert.equal(result.refs.length, 6);
    assert.equal(result.diagnostics.status, "extracted");
    assert.equal(JSON.stringify(f.items), source);
    env.assertReleased(f.pages);
  },
);
await check(
  "a narrow-column consortium author list retains all 14 wraps, DOI and source anchor",
  async () => {
    const env = environment();
    // Real published author list/title/DOI; wrapping and coordinates are synthetic.
    // Source: https://pubmed.ncbi.nlm.nih.gov/37272513/ (accessed 2026-09-15).
    const names = [
      "Moishe Liberman, Terufumi Kato,",
      "Masahiro Tsuboi, Se-Hoon Lee,",
      "Shugeng Gao, Ke-Neng Chen,",
      "Christophe Dooms, Margarita Majem,",
      "Ekkehard Eigendorff,",
      "Gastón L Martinengo, Olivier Bylicki,",
      "Delvys Rodríguez-Abreu,",
      "Jamie E Chaft, Silvia Novello,",
      "Jing Yang, Steven M Keller,",
      "Ayman Samkari, Jonathan D Spicer;",
      "KEYNOTE-671 Investigators.",
      "Perioperative Pembrolizumab",
      "for Early-Stage Non-Small-Cell",
      "Lung Cancer.",
    ];
    const lines = [
      item("References", 1100),
      ...Array.from({ length: 5 }, (_, i) =>
        item(reference(i + 1), 1070 - i * 25),
      ),
      item("6. Heather Wakelee,", 930),
      ...names.map((line, i) => item(line, 915 - i * 15)),
      item("N Engl J Med. 2023;389(6):491-503. doi:10.1056/NEJMoa2302983", 705),
      item("Acknowledgements", 685),
      item("We thank all participants and funding agencies.", 670),
    ];
    const result = await env.parser.parsePDFReferencesDetailed(
      fixture(lines).reader,
    );
    assert.equal(result.refs.length, 6);
    for (const name of names) assert.ok(result.refs[5].text.includes(name));
    assert.equal(result.refs[5].identifiers.DOI, "10.1056/NEJMoa2302983");
    assert.equal(result.refs[5].number, 6);
    assert.equal(result.refs[5].page, 0);
    assert.equal(result.refs[5].x, 100);
    assert.equal(result.refs[5].y, 940);
    assert.ok(!result.refs[5].text.includes("Acknowledgements"));
    assert.equal(result.diagnostics.status, "extracted");
    assert.equal(result.diagnostics.truncations, undefined);
  },
);
await check(
  "a known tail text budget reports the cut and preserves already accepted raw text",
  async () => {
    const env = environment();
    const fragments = Array.from({ length: 20 }, (_, i) =>
      item(`author fragment ${i} ${"longname ".repeat(250)}`, 1315 - i * 15),
    );
    const lines = [
      item("References", 1500),
      ...Array.from({ length: 5 }, (_, i) =>
        item(reference(i + 1), 1470 - i * 25),
      ),
      item("6. Consortium Investigators,", 1330),
      ...fragments,
      item("Journal. 2021;9:111-121. doi:10.1000/budget-tail", 1000),
    ];
    const result = await env.parser.parsePDFReferencesDetailed(
      fixture(lines).reader,
    );
    assert.equal(result.refs.length, 6);
    assert.equal(result.diagnostics.status, "limited");
    assert.ok(result.diagnostics.warnings.includes("reference-truncated"));
    const cut = result.diagnostics.truncations[0];
    assert.equal(cut.reason, "tail-character-budget");
    assert.equal(cut.entryOrdinal, 6);
    assert.equal(cut.printedNumber, 6);
    assert.equal(cut.retainedText, `6. ${result.refs[5].text}`);
    assert.ok(cut.retainedText.length <= cut.limit);
    assert.equal(cut.firstOmittedLine.page, 0);
    assert.equal(cut.firstOmittedLine.x, 100);
    assert.ok(cut.firstOmittedLine.text.startsWith("author fragment"));
    assert.ok(!result.refs[5].identifiers.DOI);
  },
);
console.log(
  `PDF session regression: ${passed} checks passed (no application/profile access).`,
);
