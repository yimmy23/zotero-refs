/** Reader/dev-endpoint lifecycle tests with in-memory doubles only. */
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
function compile(file, imports, globals) {
  const code = transformSync(fs.readFileSync(root + file, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  }).code;
  const module = { exports: {} };
  new Function("module", "exports", "require", ...Object.keys(globals), code)(
    module,
    module.exports,
    (name) => {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
    ...Object.values(globals),
  );
  return module.exports;
}
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
function windowDouble() {
  const listeners = new Map();
  return {
    document: {},
    PDFViewerApplication: { pdfDocument: {} },
    addEventListener(type, callback) {
      const set = listeners.get(type) || new Set();
      set.add(callback);
      listeners.set(type, set);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    emit(type, event = {}) {
      for (const callback of [...(listeners.get(type) || [])]) callback(event);
    },
    count(type) {
      return listeners.get(type)?.size || 0;
    },
  };
}
function readerFixture() {
  let clock = 0;
  const win = windowDouble();
  const primaryCalls = [],
    secondaryCalls = [];
  const position = { pageIndex: 3, rects: [[1, 2, 3, 4]] };
  const nativePopup = () => {};
  const original = (location) => primaryCalls.push(location);
  const view = {
    _iframeWindow: win,
    navigate: original,
    pointerEventToPosition: () => ({}),
    _getSelectableOverlay: () => ({
      type: "citation",
      references: [{ position }],
    }),
    _onSetOverlayPopup: nativePopup,
  };
  const secondary = {
    _iframeWindow: {},
    navigate: (location) => secondaryCalls.push(location),
  };
  const internal = { _primaryView: view, _secondaryView: secondary };
  const reader = { _internalReader: internal };
  const prefs = { clickLink: true, clickLinkCmd: "splitHorizontally" };
  const { ReaderLinks } = compile(
    "src/pdf/readerLinks.ts",
    { "../utils/prefs": { getPref: (key) => prefs[key] } },
    {
      ztoolkit: { log() {} },
      Date: { now: () => clock },
      Zotero: {
        Reader: { _readers: [reader] },
        Promise: {
          delay: async (ms) => {
            clock += ms;
          },
        },
      },
    },
  );
  const links = new ReaderLinks();
  return {
    win,
    view,
    reader,
    internal,
    secondary,
    original,
    position,
    prefs,
    links,
    primaryCalls,
    secondaryCalls,
    nativePopup,
  };
}
await check("attach is idempotent and preserves native hover", async () => {
  const f = readerFixture();
  f.links.attach(f.reader);
  await settle();
  const wrapped = f.view.navigate;
  f.links.attach(f.reader);
  await settle();
  assert.equal(f.view.navigate, wrapped);
  assert.equal(f.win.count("pointerup"), 1);
  assert.equal(f.win.count("unload"), 1);
  assert.equal(f.view._onSetOverlayPopup, f.nativePopup);
});
await check(
  "obsolete reader-view unload cannot tear down current view",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    const nextWin = windowDouble(),
      nextOriginal = () => {};
    const next = { _iframeWindow: nextWin, navigate: nextOriginal };
    f.internal._primaryView = next;
    f.links.attach(f.reader);
    await settle();
    assert.equal(f.win.count("unload"), 0);
    f.win.emit("unload");
    assert.notEqual(next.navigate, nextOriginal);
    nextWin.emit("unload");
    assert.equal(next.navigate, nextOriginal);
    assert.equal(nextWin.count("pointerup"), 0);
  },
);
await check("teardown preserves a later plugin wrapper", async () => {
  const f = readerFixture();
  f.links.attach(f.reader);
  await settle();
  const newer = () => {};
  f.view.navigate = newer;
  f.links.detachAll();
  assert.equal(f.view.navigate, newer);
  assert.equal(f.win.count("unload"), 0);
});
await check(
  "only correlated primary-button clicks use split navigation",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    f.view.navigate({ position: f.position });
    assert.equal(f.primaryCalls.length, 1);
    f.win.emit("pointerup", { button: 0 });
    f.view.navigate({ position: f.position });
    await settle();
    assert.equal(f.primaryCalls.length, 1);
    assert.equal(f.secondaryCalls.length, 1);
    f.win.emit("pointerup", { button: 2 });
    f.view.navigate({ position: f.position });
    await settle();
    assert.equal(f.primaryCalls.length, 2);
    f.prefs.clickLink = false;
    f.win.emit("pointerup", { button: 0 });
    f.view.navigate({ position: f.position });
    assert.equal(f.primaryCalls.length, 3);
  },
);
for (const failure of [
  "missing split API",
  "throwing split API",
  "split timeout",
  "rejected navigation",
]) {
  await check(`${failure} falls back to native click`, async () => {
    const f = readerFixture();
    if (failure === "rejected navigation")
      f.secondary.navigate = async () => {
        throw new Error("Not ready");
      };
    else {
      f.internal._secondaryView = null;
      if (failure === "throwing split API")
        f.internal.toggleHorizontalSplit = () => {
          throw new Error("Cannot split");
        };
      if (failure === "split timeout")
        f.internal.toggleHorizontalSplit = () => {};
    }
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0 });
    f.view.navigate({ position: f.position });
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(f.primaryCalls.length, 1);
    assert.equal(f.secondaryCalls.length, 0);
  });
}
await check("pending split does not navigate after shutdown", async () => {
  const f = readerFixture();
  const wait = deferred();
  f.internal._secondaryView = null;
  f.internal.toggleHorizontalSplit = () => wait.promise;
  f.links.attach(f.reader);
  await settle();
  f.win.emit("pointerup", { button: 0 });
  f.view.navigate({ position: f.position });
  f.links.detachAll();
  wait.resolve();
  await settle();
  assert.equal(f.primaryCalls.length, 0);
  assert.equal(f.view.navigate, f.original);
});
function hookFixture() {
  const wait = deferred();
  const reader = { _initPromise: wait.promise };
  const addon = { data: { alive: true } };
  const timers = new Map();
  let next = 0,
    attached = 0;
  const hooks = compile(
    "src/pdf/readerHook.ts",
    {
      "./readerLinks": {
        ReaderLinks: class {
          attach() {
            attached++;
          }
          detachAll() {}
          sweep() {}
        },
      },
      "../utils/window": {
        setTimeout(fn) {
          timers.set(++next, fn);
          return next;
        },
        clearTimeout(id) {
          timers.delete(id);
        },
      },
    },
    {
      addon,
      Zotero: { Reader: { _readers: [reader], getByTabID: () => reader } },
    },
  );
  return { hooks, wait, addon, timers, attached: () => attached };
}
for (const path of ["startup", "tab selection"]) {
  await check(
    `reader init completed after ${path} shutdown never reattaches`,
    async () => {
      const f = hookFixture();
      const pending =
        path === "startup"
          ? f.hooks.attachAllReaders()
          : f.hooks.onReaderTabSelect("tab");
      f.hooks.detachAllReaders();
      f.addon.data.alive = false;
      f.wait.resolve();
      await pending;
      await settle();
      assert.equal(f.attached(), 0);
      assert.equal(f.timers.size, 0);
    },
  );
}
await check("shutdown clears both delayed reader sweeps", async () => {
  const f = hookFixture();
  f.wait.resolve();
  await f.hooks.attachAllReaders();
  assert.equal(f.timers.size, 2);
  f.hooks.detachAllReaders();
  assert.equal(f.timers.size, 0);
});
function devFixture() {
  const wait = deferred();
  const addon = { data: { alive: true, env: "development" } };
  const endpoints = {};
  const writes = new Map();
  const dev = compile(
    "src/modules/devEval.ts",
    Object.fromEntries(
      [
        "../core/libmatch",
        "../core/storage",
        "../pdf/parser",
        "../sources/openalex",
        "../sources/crossref",
        "../pdf/readerHook",
      ].map((name) => [name, {}]),
    ),
    {
      __env__: "development",
      addon,
      ztoolkit: { log() {} },
      Zotero: {
        initializationPromise: wait.promise,
        DataDirectory: { dir: "/synthetic/.scaffold/dev-data" },
        Server: { Endpoints: endpoints },
        Promise: { delay: async () => {} },
      },
      globalThis: {
        IOUtils: {
          writeUTF8: async (path, value) => {
            writes.set(path, value);
          },
        },
        PathUtils: { join: (...parts) => parts.join("/") },
      },
    },
  );
  return { dev, wait, endpoints, writes };
}
await check(
  "dev endpoint registration cancels during initialization",
  async () => {
    const f = devFixture();
    f.dev.registerDevEval();
    f.dev.unregisterDevEval();
    f.wait.resolve();
    await settle();
    assert.equal(Object.keys(f.endpoints).length, 0);
  },
);
await check(
  "dev endpoint authenticates and unregisters without deleting a replacement",
  async () => {
    const f = devFixture();
    f.wait.resolve();
    f.dev.registerDevEval();
    await settle();
    const handler = f.endpoints["/refs-dev/eval"];
    assert.ok(handler);
    assert.equal(
      (
        await new handler().init({ data: { token: "wrong", code: "return 1" } })
      )[0],
      403,
    );
    const token = f.writes.get(
      "/synthetic/.scaffold/dev-data/dev-eval-token.txt",
    );
    assert.equal(
      (await new handler().init({ data: { token, code: "return 1" } }))[0],
      200,
    );
    f.dev.unregisterDevEval();
    assert.equal(f.endpoints["/refs-dev/eval"], undefined);
    assert.equal(
      (await new handler().init({ data: { token, code: "return 1" } }))[0],
      403,
    );
    f.dev.registerDevEval();
    await settle();
    const newer = () => {};
    f.endpoints["/refs-dev/eval"] = newer;
    f.dev.unregisterDevEval();
    assert.equal(f.endpoints["/refs-dev/eval"], newer);
  },
);
console.log(
  `Reader regression: ${passed} checks passed (no application/profile access).`,
);
