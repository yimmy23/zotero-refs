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
    secondaryCalls = [],
    primaryOptions = [],
    primaryReceivers = [];
  const position = { pageIndex: 3, rects: [[1, 2, 3, 4]] };
  const nativePopup = () => {};
  const original = function (location, options) {
    primaryOptions.push(options);
    primaryReceivers.push(this);
    return primaryCalls.push(location);
  };
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
    primaryOptions,
    primaryReceivers,
    secondaryCalls,
    nativePopup,
    advanceClock: (ms) => {
      clock += ms;
    },
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
for (const type of ["citation", "reference", "internal-link"]) {
  for (const splitOpen of [false, true]) {
    await check(
      `ordinary ${type} click stays native with split ${splitOpen ? "open" : "closed"}`,
      async () => {
        const f = readerFixture();
        let splitCalls = 0;
        if (!splitOpen) f.internal._secondaryView = null;
        f.internal.toggleHorizontalSplit = () => {
          splitCalls++;
          f.internal._secondaryView = f.secondary;
        };
        f.view._getSelectableOverlay = () =>
          type === "internal-link"
            ? { type, destinationPosition: f.position }
            : { type, references: [{ position: f.position }] };
        f.links.attach(f.reader);
        await settle();
        f.win.emit("pointerup", { button: 0 });
        const result = f.view.navigate({ position: f.position });
        // Native return value and jump must be preserved synchronously.
        assert.equal(result, 1);
        assert.equal(f.primaryCalls.length, 1);
        await settle();
        assert.equal(splitCalls, 0);
        assert.equal(f.secondaryCalls.length, 0);
      },
    );
  }
}
await check(
  "only explicit Alt/Option left-click uses existing split",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0, altKey: true });
    f.view.navigate({ position: JSON.parse(JSON.stringify(f.position)) });
    await settle();
    assert.equal(f.primaryCalls.length, 0);
    assert.equal(f.secondaryCalls.length, 1);
    // A gesture can authorize only one navigation.
    f.view.navigate({ position: f.position });
    assert.equal(f.primaryCalls.length, 1);
  },
);
for (const direction of ["splitHorizontally", "splitVertically"]) {
  await check(`explicit gesture opens ${direction}`, async () => {
    const f = readerFixture();
    f.prefs.clickLinkCmd = direction;
    f.internal._secondaryView = null;
    let opened = 0;
    const method =
      direction === "splitHorizontally"
        ? "toggleHorizontalSplit"
        : "toggleVerticalSplit";
    f.internal[method] = (enabled) => {
      assert.equal(enabled, true);
      opened++;
      f.internal._secondaryView = f.secondary;
    };
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0, altKey: true });
    f.view.navigate({ position: f.position });
    await settle();
    assert.equal(opened, 1);
    assert.equal(f.secondaryCalls.length, 1);
    assert.equal(f.primaryCalls.length, 0);
  });
}
await check(
  "other modifiers and disabled split preference stay native",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    const gestures = [
      { button: 0, ctrlKey: true },
      { button: 0, metaKey: true },
      { button: 0, shiftKey: true },
      { button: 0, altKey: true, ctrlKey: true },
      { button: 0, altKey: true, metaKey: true },
      { button: 0, altKey: true, shiftKey: true },
      { button: 1, altKey: true },
      { button: 2, altKey: true },
    ];
    for (const event of gestures) {
      f.win.emit("pointerup", event);
      f.view.navigate({ position: f.position });
    }
    f.prefs.clickLink = false;
    f.win.emit("pointerup", { button: 0, altKey: true });
    f.view.navigate({ position: f.position });
    assert.equal(f.primaryCalls.length, gestures.length + 1);
    await settle();
    assert.equal(f.secondaryCalls.length, 0);
  },
);
await check(
  "unrelated destination on same page consumes gesture without interception",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0, altKey: true });
    const unrelated = {
      pageIndex: f.position.pageIndex,
      rects: [[11, 22, 33, 44]],
    };
    f.view.navigate({ position: unrelated });
    f.view.navigate({ position: f.position });
    await settle();
    assert.equal(f.primaryCalls.length, 2);
    assert.equal(f.secondaryCalls.length, 0);
  },
);
await check(
  "destination mutation after gesture cannot authorize a different jump",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0, altKey: true });
    f.position.rects[0][0] = 99;
    f.view.navigate({ position: f.position });
    assert.equal(f.primaryCalls.length, 1);
    await settle();
    assert.equal(f.secondaryCalls.length, 0);
  },
);
await check("ordinary click clears an earlier explicit gesture", async () => {
  const f = readerFixture();
  f.links.attach(f.reader);
  await settle();
  f.win.emit("pointerup", { button: 0, altKey: true });
  f.win.emit("pointerup", { button: 0 });
  f.view.navigate({ position: f.position });
  assert.equal(f.primaryCalls.length, 1);
  await settle();
  assert.equal(f.secondaryCalls.length, 0);
});
await check(
  "expired gesture preserves native location, options and receiver",
  async () => {
    const f = readerFixture();
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0, altKey: true });
    f.advanceClock(301);
    const location = { position: f.position };
    const options = { skipHistory: true };
    assert.equal(f.view.navigate(location, options), 1);
    assert.equal(f.primaryCalls[0], location);
    assert.equal(f.primaryOptions[0], options);
    assert.equal(f.primaryReceivers[0], f.view);
    await settle();
    assert.equal(f.secondaryCalls.length, 0);
  },
);
await check("later wrappers remain native after Refs teardown", async () => {
  const f = readerFixture();
  f.links.attach(f.reader);
  await settle();
  const refsWrap = f.view.navigate;
  const newer = (...args) => refsWrap(...args);
  f.view.navigate = newer;
  f.win.emit("pointerup", { button: 0, altKey: true });
  f.links.detachAll();
  assert.equal(f.view.navigate, newer);
  f.view.navigate({ position: f.position });
  assert.equal(f.primaryCalls.length, 1);
  await settle();
  assert.equal(f.secondaryCalls.length, 0);
});
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
    f.win.emit("pointerup", { button: 0, altKey: true });
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
  f.win.emit("pointerup", { button: 0, altKey: true });
  f.view.navigate({ position: f.position });
  f.links.detachAll();
  wait.resolve();
  await settle();
  assert.equal(f.primaryCalls.length, 0);
  assert.equal(f.view.navigate, f.original);
});
await check(
  "pending split cannot navigate a replaced reader view",
  async () => {
    const f = readerFixture();
    const wait = deferred();
    f.internal._secondaryView = null;
    f.internal.toggleHorizontalSplit = () => wait.promise;
    f.links.attach(f.reader);
    await settle();
    f.win.emit("pointerup", { button: 0, altKey: true });
    f.view.navigate({ position: f.position });
    f.internal._primaryView = { _iframeWindow: windowDouble(), navigate() {} };
    f.internal._secondaryView = f.secondary;
    wait.resolve();
    await settle();
    assert.equal(f.primaryCalls.length, 0);
    assert.equal(f.secondaryCalls.length, 0);
  },
);
await check("pending split fallback retains original options", async () => {
  const f = readerFixture();
  f.internal._secondaryView = null;
  f.links.attach(f.reader);
  await settle();
  f.win.emit("pointerup", { button: 0, altKey: true });
  const location = { position: f.position };
  const options = { skipHistory: true };
  f.view.navigate(location, options);
  await settle();
  assert.equal(f.primaryCalls[0], location);
  assert.equal(f.primaryOptions[0], options);
  assert.equal(f.primaryReceivers[0], f.view);
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
function devFixture(environment = "development") {
  const wait = deferred();
  const addon = { data: { alive: true, env: environment } };
  const endpoints = {};
  const writes = new Map();
  const dev = compile(
    "src/modules/devEval.ts",
    Object.fromEntries(
      [
        "../core/libmatch",
        "../core/storage",
        "../graph/build",
        "../graph/view",
        "../pdf/parser",
        "../pdf/sequenceReader",
        "../sources/openalex",
        "../sources/semanticscholar",
        "../sources/crossref",
        "../pdf/readerHook",
        "../ui/rows",
        "../sources/abstract",
      ].map((name) => [name, {}]),
    ),
    {
      __env__: environment,
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
  "production does not register dev endpoints or write tokens",
  async () => {
    const f = devFixture("production");
    f.wait.resolve();
    f.dev.registerDevEval();
    await settle();
    assert.equal(Object.keys(f.endpoints).length, 0);
    assert.equal(f.writes.size, 0);
  },
);
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
// Match Zotero's real lifecycle boundary: registrations are removed
// synchronously, while serial notifier callbacks can reach readers later.
function itemPaneLifecycleFixture() {
  const config = {
    addonID: "refs@zotero-refs.app",
    addonRef: "refs",
    addonInstance: "Refs",
    addonName: "Refs",
  };
  const ids = [
    "references",
    "citations",
    "related-papers",
    "citation-graph",
  ].map((id) => `refs\\@zotero-refs\\.app-${id}`);
  const registry = new Map();
  const errors = [],
    calls = [];
  let updateID = 0;
  const old = { alive: false },
    fresh = { alive: true };
  const register = (id, owner, pluginID = config.addonID) => {
    registry.set(id, {
      paneID: id,
      pluginID,
      hooks: { render: () => (owner.alive ? "ready" : "loading") },
    });
    updateID++;
  };
  for (const id of ids) register(id, old);
  register("other-plugin-pane", fresh, "other-plugin");
  const details = (initialized = true) => ({
    initialized,
    panes: new Map(),
    observed: new Set(),
    sidenav: new Set(),
    removed: [],
    renderCustomSections() {
      calls.push(this);
      if (this.lastUpdate === updateID) return;
      this.lastUpdate = updateID;
      for (const [id, element] of this.panes)
        if (!registry.has(id)) {
          this.observed.delete(element);
          this.panes.delete(id);
          this.sidenav.delete(id);
          this.removed.push(element);
        }
      for (const [id, option] of registry)
        if (!this.panes.has(id)) {
          const element = { paneID: id, _hooks: option.hooks };
          this.panes.set(id, element);
          this.observed.add(element);
          this.sidenav.add(id);
        }
    },
  });
  const library = details(),
    reader = details(),
    secondReader = details(),
    uninitialized = details(false);
  const document = { querySelectorAll: () => [library, reader, uninitialized] };
  const win = { document, MozXULElement: { insertFTLIfNeeded() {} } };
  const readerWin = { document: { querySelectorAll: () => [secondReader] } };
  const manager = {
    get customSectionData() {
      return { updateID, options: [...registry.values()] };
    },
    unregisterSection(id) {
      const removed = registry.delete(id);
      if (removed) updateID++;
      return removed;
    },
  };
  for (const pane of [library, reader, secondReader])
    pane.renderCustomSections();
  calls.length = 0;
  const Zotero = {
    ItemPaneManager: manager,
    getMainWindows: () => [win],
    Reader: { _readers: [{ _window: readerWin }, { _window: win }] },
  };
  const ztoolkit = { log: (...args) => errors.push(args) };
  const lifecycle = compile(
    "src/utils/itemPaneLifecycle.ts",
    { "../../package.json": { config } },
    { Zotero, ztoolkit },
  );
  return {
    config,
    ids,
    registry,
    old,
    fresh,
    register,
    library,
    reader,
    secondReader,
    uninitialized,
    calls,
    errors,
    win,
    readerWin,
    Zotero,
    ztoolkit,
    lifecycle,
  };
}

await check(
  "pre-registration cleanup repairs readers after native unregister notification races",
  async () => {
    // The control reproduces the native same-ID preservation bug; the actual
    // cleanup then makes all readers attach callbacks from the current addon.
    const f = itemPaneLifecycleFixture();
    const oldReaderPane = f.reader.panes.get(f.ids[3]);
    for (const id of f.ids) f.Zotero.ItemPaneManager.unregisterSection(id);
    const gate = deferred();
    const notify = (async () => {
      f.library.renderCustomSections();
      await gate.promise;
      f.reader.renderCustomSections();
    })();
    for (const id of f.ids) f.register(id, f.fresh);
    gate.resolve();
    await notify;
    assert.equal(f.reader.panes.get(f.ids[3]), oldReaderPane);
    assert.equal(oldReaderPane._hooks.render(), "loading");
    const other = f.reader.panes.get("other-plugin-pane");
    const result = f.lifecycle.unregisterItemPaneSections();
    assert.equal(
      result,
      undefined,
      "cleanup must finish synchronously before registration",
    );
    for (const pane of [f.library, f.reader, f.secondReader]) {
      assert.equal(pane.panes.size, 1);
      assert.equal(pane.observed.size, 1);
      assert.equal(pane.sidenav.size, 1);
    }
    assert.equal(f.reader.panes.get("other-plugin-pane"), other);
    assert.ok(!f.calls.includes(f.uninitialized));
    assert.ok(!f.reader.observed.has(oldReaderPane));
    for (const id of f.ids) f.register(id, f.fresh);
    for (const pane of [f.library, f.reader, f.secondReader]) {
      pane.renderCustomSections();
      assert.equal(pane.panes.get(f.ids[3])._hooks.render(), "ready");
      assert.notEqual(pane.panes.get(f.ids[3]), oldReaderPane);
    }
    assert.equal(f.errors.length, 0);
  },
);

await check(
  "cleanup consumes an already-empty registration window and isolates dead panes",
  async () => {
    const f = itemPaneLifecycleFixture();
    for (const id of f.ids) f.Zotero.ItemPaneManager.unregisterSection(id);
    // Old auto-unregister has emptied the registry; it has not reached readers.
    assert.ok(f.reader.panes.has(f.ids[0]));
    const broken = {
      initialized: true,
      renderCustomSections() {
        throw new Error("closed pane");
      },
    };
    const original = f.win.document.querySelectorAll;
    f.win.document.querySelectorAll = () => [broken, ...original()];
    f.lifecycle.unregisterItemPaneSections();
    assert.equal(f.reader.panes.size, 1);
    assert.equal(f.secondReader.panes.size, 1);
    assert.equal(f.errors.length, 1);
    assert.equal(
      f.calls.filter((pane) => pane === f.library).length,
      1,
      "duplicate reader/main windows must be visited once",
    );
    f.lifecycle.unregisterItemPaneSections();
    assert.equal(
      f.reader.panes.size,
      1,
      "repeated cleanup must preserve other plugins",
    );
  },
);

function addonLifecycleFixture() {
  const f = itemPaneLifecycleFixture();
  const events = [],
    flush = deferred(),
    initialized = deferred();
  const addon = { data: { alive: true }, hooks: null };
  const noop = () => {};
  const record = (name) => () => events.push(name);
  Object.assign(f.Zotero, {
    initializationPromise: initialized.promise,
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    PreferencePanes: { register: noop },
    Notifier: {
      registerObserver: () => "observer",
      unregisterObserver: record("observer removed"),
    },
    logError: noop,
  });
  f.ztoolkit.unregisterAll = record("toolkit removed");
  const imports = {
    "./utils/window": { cancelAllTimers: record("timers cancelled") },
    "./utils/itemPaneLifecycle": {
      unregisterItemPaneSections: () => {
        events.push(
          addon.data.alive ? "startup pane cleanup" : "shutdown pane cleanup",
        );
        f.lifecycle.unregisterItemPaneSections();
      },
    },
    "./utils/locale": { initLocale: noop },
    "./modules/preferenceScript": { registerPrefsScripts: noop },
    "./utils/ztoolkit": { createZToolkit: noop },
    "../package.json": { config: f.config },
    "./core/libmatch": { libraryIndex: { register: noop, unregister: noop } },
    "./core/storage": {
      refStorage: {
        flush: () => {
          events.push("flush");
          return flush.promise;
        },
      },
    },
    "./ui/styles": { registerStyles: noop, unregisterStyles: noop },
    "./ui/rows": { closePopup: noop },
    "./core/popupTranslation": { clearPopupTranslations: noop },
    "./graph/view": { destroyAllGraphViews: record("graphs destroyed") },
    "./modules/menus": {
      registerItemMenus: noop,
      registerWindowMenus: noop,
      unregisterItemMenus: noop,
    },
    "./modules/devEval": { registerDevEval: noop, unregisterDevEval: noop },
    "./pdf/readerHook": {
      attachAllReaders: async () => {},
      detachAllReaders: noop,
      onReaderTabSelect: noop,
      sweepReaders: noop,
    },
  };
  for (const [file, name, id] of [
    ["section", "registerReferencesSection", f.ids[0]],
    ["citations", "registerCitationsSection", f.ids[1]],
    ["related", "registerRelatedSection", f.ids[2]],
    ["graphSection", "registerGraphSection", f.ids[3]],
  ])
    imports[`./ui/${file}`] = {
      [name]: () => {
        events.push(name);
        f.register(id, f.fresh);
      },
      removeGraphMenus: noop,
    };
  const hooks = compile("src/hooks.ts", imports, {
    Zotero: f.Zotero,
    ztoolkit: f.ztoolkit,
    addon,
    rootURI: "chrome://refs/",
  }).default;
  addon.hooks = hooks;
  f.Zotero[f.config.addonInstance] = addon;
  return { ...f, addon, hooks, events, flush, initialized };
}

await check(
  "addon startup and shutdown consume pane cleanup before registration and asynchronous flush",
  async () => {
    const f = addonLifecycleFixture();
    f.initialized.resolve();
    await f.hooks.onStartup();
    assert.ok(
      f.events.indexOf("startup pane cleanup") <
        f.events.indexOf("registerReferencesSection"),
    );
    assert.equal(
      f.reader.panes.size,
      1,
      "old reader callbacks must be gone before new native notifications",
    );
    f.reader.renderCustomSections();
    assert.equal(f.reader.panes.get(f.ids[3])._hooks.render(), "ready");
    const stopping = f.hooks.onShutdown();
    assert.equal(f.addon.data.alive, false);
    assert.equal(f.reader.panes.size, 1);
    assert.ok(
      f.events.indexOf("graphs destroyed") <
        f.events.indexOf("shutdown pane cleanup"),
    );
    assert.ok(
      f.events.indexOf("shutdown pane cleanup") < f.events.indexOf("flush"),
    );
    assert.equal(
      f.registry.size,
      1,
      "shutdown leaves other plugin registrations intact",
    );
    f.flush.resolve();
    await stopping;
    assert.equal(f.errors.length, 0);
  },
);

await check(
  "startup cancelled while Zotero initializes cannot register dead section callbacks",
  async () => {
    const f = addonLifecycleFixture();
    const starting = f.hooks.onStartup();
    f.addon.data.alive = false;
    f.initialized.resolve();
    await starting;
    assert.equal(f.events.length, 0);
  },
);

console.log(
  `Reader regression: ${passed} checks passed (no application/profile access).`,
);
