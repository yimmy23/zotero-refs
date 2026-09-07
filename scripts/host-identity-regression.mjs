import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

// Real cache/panel modules; only application I/O and browser mechanics are fake.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function host(id = 1, libraryID = 1) {
  const fields = {
    title: "Paper A",
    DOI: "10.5555/a",
    date: "2024-01-02",
    extra: "",
    url: "",
  };
  return {
    id,
    libraryID,
    key: "SHAREDKEY",
    fields,
    relatedItems: [],
    getField: (key) => fields[key] || "",
    isRegularItem: () => true,
  };
}
const reference = (title) => ({
  title,
  text: title,
  authors: ["Synthetic Author"],
  identifiers: {},
});
class Element {
  constructor(tag, doc) {
    this.localName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.style = {};
    this.events = new Map();
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.classList = {
      add: (name) => {
        this.className += " " + name;
      },
    };
  }
  get isConnected() {
    return !!(this.root || this.parentElement?.isConnected);
  }
  set textContent(value) {
    for (const child of this.children) child.parentElement = undefined;
    this.children = [];
    this.text = String(value);
  }
  get textContent() {
    return (
      this.text || this.children.map((child) => child.textContent).join("")
    );
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(child) {
    this.append(child);
    return child;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  addEventListener(key, fn) {
    this.events.set(key, fn);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const result = [];
    const match = selector.replace(/^.*\./, "");
    for (const child of this.children) {
      if (child.className.split(/\s+/).includes(match)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}
function document() {
  const doc = { createElement: (tag) => new Element(tag, doc) };
  doc.body = doc.createElement("body");
  doc.body.root = true;
  return doc;
}
function fixture(options = {}) {
  const prefs = new Map([
    ["savePDFReferences", true],
    ["saveAPIReferences", true],
    ["loadingCitations", false],
    ["loadingRelated", true],
    ["graphMaxNodes", 10],
  ]);
  const timers = new Map(),
    writes = [],
    panes = new Map();
  let sequence = 0;
  const file = { raw: options.raw };
  class ProgressWindow {
    createLine() {
      return this;
    }
    show() {
      return this;
    }
    changeLine() {
      return this;
    }
    changeHeadline() {
      return this;
    }
    startCloseTimer() {}
    close() {}
  }
  const globals = {
    Zotero: {
      DataDirectory: { dir: "/synthetic" },
      File: {
        getContentsAsync: async () => file.raw,
        putContentsAsync: async (_path, raw) => {
          file.raw = raw;
          writes.push(raw);
        },
      },
      Items: { get: () => undefined, getByLibraryAndKey: () => undefined },
      Reader: { _readers: [] },
      ItemPaneManager: {
        registerSection: (definition) => {
          panes.set(definition.paneID, definition);
        },
      },
      Prefs: { get: () => undefined },
    },
    addon: { data: { alive: true } },
    ztoolkit: { log: () => {}, ProgressWindow },
    PathUtils: { join: path.join },
    IOUtils: {
      exists: () =>
        options.loadGate?.promise || Promise.resolve(file.raw !== undefined),
    },
  };
  const windowTools = {
    setTimeout: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    getWin: () => ({}),
  };
  const load = (relative, imports = {}, extra = "") => {
    const compiled = transformSync(
      fs.readFileSync(path.join(root, relative), "utf8") + extra,
      { loader: "ts", format: "cjs", target: "es2022" },
    ).code;
    const module = { exports: {} };
    new Function(
      "module",
      "exports",
      "require",
      ...Object.keys(globals),
      compiled,
    )(
      module,
      module.exports,
      (name) => {
        if (name === "../../package.json") return pkg;
        assert.ok(name in imports, `${relative}: unmocked ${name}`);
        return imports[name];
      },
      ...Object.values(globals),
    );
    return module.exports;
  };
  const text = load("src/core/text.ts"),
    types = load("src/core/types.ts");
  const storage = load("src/core/storage.ts", {
    "../utils/window": windowTools,
    "./text": text,
  });
  const shared = {
    "../utils/window": windowTools,
    "../utils/locale": { getString: (key) => key, getLocaleID: (key) => key },
    "../utils/prefs": {
      getPref: (key) => prefs.get(key),
      getNumPref: (key, fallback) => prefs.get(key) ?? fallback,
    },
    "../utils/guard": { guard: (_key, fn) => fn, guardAsync: (_key, fn) => fn },
    "../core/text": text,
    "../core/types": types,
    "../core/storage": storage,
    "./controls": {
      createSearch: (body) => {
        const node = body.ownerDocument.createElement("input");
        body.append(node);
        return node;
      },
      actionButton: (doc) => doc.createElement("button"),
      setListMessage: (list, message) => {
        list.message = message;
      },
    },
    "./rows": {
      renderRefRow: (ctx, refs, index) => {
        const row = ctx.list.ownerDocument.createElement("div");
        row.className = "references-row";
        row.textContent = refs[index].title;
        ctx.list.append(row);
      },
      filterRows: () => {},
      closePopup: () => {},
    },
  };
  const section = (overrides = {}) =>
    load(
      "src/ui/section.ts",
      {
        ...shared,
        "../core/fuse": {
          fuseReferences: async (pdf, api) => ({
            refs: pdf.length ? pdf : api,
            tailStart: pdf.length ? pdf.length : api.length,
            stats: {},
          }),
        },
        "../sources": {
          sources: { crossref: {} },
          getReferencesByAPI: async () => null,
        },
        "../pdf/parser": { parsePDFReferences: async () => [] },
        "./batchImport": {},
        ...overrides,
      },
      "\nexport {getState,findReaderForItem,fetchReferences,refresh,states};\n",
    );
  return {
    globals,
    load,
    shared,
    section,
    storage,
    prefs,
    timers,
    writes,
    file,
    panes,
    async fire(ms) {
      for (const [id, timer] of [...timers])
        if (timer.ms === ms && timers.delete(id)) timer.fn();
      await tick();
    },
  };
}

test("identity changes only with paper identity fields and includes library scope", () => {
  const {
    storage: { itemStateKey: key },
  } = fixture();
  const item = host();
  const original = key(item);
  item.fields.DOI = "https://doi.org/10.5555/A";
  assert.equal(key(item), original);
  item.fields.readingTime = "300";
  item.fields.abstractNote = "Updated abstract";
  assert.equal(key(item), original);
  for (const field of ["DOI", "title", "date", "extra"]) {
    const old = item.fields[field];
    item.fields[field] =
      field === "date"
        ? "2025"
        : field === "extra"
          ? "PMID: 123456"
          : "Changed identity";
    assert.notEqual(key(item), original, field);
    item.fields[field] = old;
  }
  item.libraryID = 2;
  assert.notEqual(key(item), original);
});

test("reader selection does not cross libraries sharing an item key", () => {
  const env = fixture(),
    item = host(22, 2),
    wrong = { itemID: 101 },
    right = { itemID: 202 };
  const items = new Map([
    [
      101,
      {
        id: 101,
        parentID: 11,
        key: "PDF1",
        libraryID: 1,
        parentItem: host(11, 1),
      },
    ],
    [
      202,
      { id: 202, parentID: 22, key: "PDF2", libraryID: 2, parentItem: item },
    ],
  ]);
  env.globals.Zotero.Reader._readers = [wrong, right];
  env.globals.Zotero.Items.get = (id) => items.get(id);
  assert.equal(env.section().findReaderForItem(item), right);
  assert.equal(env.section().findReaderForItem(host(33, 3)), null);
});

test("CNKI URL changes invalidate every slot and reject the previous paper's completion", async () => {
  const env = fixture(),
    item = host(),
    { itemStateKey: key, refStorage: store } = env.storage;
  item.fields.DOI = "";
  item.fields.url =
    "https://kns.cnki.net/kcms/detail/detail.aspx?filename=PAPER_A&dbname=CJFDLAST2024";
  const before = key(item);
  for (const slot of ["PDF", "API", "FUSED"])
    await store.set(item, slot, [reference("CNKI A reference")], before);
  item.fields.url = item.fields.url.replace("PAPER_A", "PAPER_B");
  assert.notEqual(key(item), before);
  for (const slot of ["PDF", "API", "FUSED"]) {
    assert.equal(await store.get(item, slot), undefined);
    await store.set(item, slot, [reference("Late CNKI A reference")], before);
    assert.equal(await store.get(item, slot), undefined);
  }
});

test("host title identity preserves semantic symbols while normalizing case and whitespace", async () => {
  const env = fixture(),
    item = host(),
    { itemStateKey: key, refStorage: store } = env.storage;
  item.fields.DOI = "";
  item.fields.title = "Prognosis of HER2+ breast cancer";
  const positive = key(item);
  await store.set(
    item,
    "API",
    [reference("HER2 positive reference")],
    positive,
  );
  item.fields.title = "  prognosis of  ＨＥＲ２+ breast\ncancer ";
  assert.equal(key(item), positive);
  item.fields.title = "Prognosis of HER2− breast cancer";
  assert.notEqual(key(item), positive);
  assert.equal(await store.get(item, "API"), undefined);
  await store.set(
    item,
    "API",
    [reference("Late positive reference")],
    positive,
  );
  assert.equal(await store.get(item, "API"), undefined);
});

test("all persistent slots reject changed host identity and old request writes", async () => {
  const env = fixture(),
    item = host(),
    { refStorage: store, itemStateKey: key } = env.storage;
  const old = key(item);
  for (const slot of ["PDF", "API", "FUSED"])
    await store.set(item, slot, [reference("Paper A reference")], old);
  assert.equal((await store.get(item, "FUSED"))[0].title, "Paper A reference");
  item.fields.DOI = "10.5555/b";
  for (const slot of ["PDF", "API", "FUSED"])
    assert.equal(await store.get(item, slot), undefined);
  const fresh = key(item);
  await store.set(item, "FUSED", [reference("Paper B reference")], fresh);
  for (const slot of ["PDF", "API", "FUSED"])
    await store.set(item, slot, [reference("Late A reference")], old);
  assert.equal((await store.get(item, "FUSED"))[0].title, "Paper B reference");
  assert.equal(await store.get(item, "API"), undefined);
  assert.equal(await store.get(item, "PDF"), undefined);
  await store.flush();
  const persisted = JSON.parse(env.writes.at(-1));
  assert.equal(persisted.items["1/SHAREDKEY"].FUSED.identity, fresh);
  const reopened = fixture({ raw: env.file.raw });
  assert.equal(
    (await reopened.storage.refStorage.get(item, "FUSED"))[0].title,
    "Paper B reference",
  );
});

test("cache I/O captures identity before awaiting initial file load", async () => {
  const gate = deferred(),
    env = fixture({ loadGate: gate }),
    item = host();
  const pending = env.storage.refStorage.set(item, "API", [
    reference("Old request"),
  ]);
  item.fields.title = "Paper B";
  gate.resolve(false);
  await pending;
  assert.equal(await env.storage.refStorage.get(item, "API"), undefined);
});

test("a read started for A cannot return B after delayed cache-file loading", async () => {
  const item = host();
  const future = host();
  future.fields.DOI = "10.5555/b";
  const identity = fixture().storage.itemStateKey(future);
  const raw = JSON.stringify({
    v: 2,
    items: {
      "1/SHAREDKEY": {
        API: { identity, t: 1, refs: [reference("B reference")] },
      },
    },
  });
  const gate = deferred(),
    env = fixture({ raw, loadGate: gate });
  const pending = env.storage.refStorage.get(item, "API");
  item.fields.DOI = "10.5555/b";
  gate.resolve(true);
  assert.equal(await pending, undefined);
  assert.equal(
    (await env.storage.refStorage.get(item, "API"))[0].title,
    "B reference",
  );
});

test("legacy unstamped entries remain recoverable but are never presented as verified references", async () => {
  const raw = JSON.stringify({
    v: 2,
    items: {
      "1/SHAREDKEY": { API: { t: 1, refs: [reference("Legacy reference")] } },
    },
  });
  const env = fixture({ raw }),
    item = host();
  assert.equal(await env.storage.refStorage.get(item, "API"), undefined);
  await env.storage.refStorage.flush();
  assert.equal(
    JSON.parse(env.writes.at(-1)).items["1/SHAREDKEY"].API.refs[0].title,
    "Legacy reference",
  );
});

test("references state changes on host edits and old PDF/API completion cannot write or repaint", async () => {
  const env = fixture(),
    item = host(),
    pdf = deferred(),
    api = deferred();
  const attachment = {
    id: 2,
    parentID: item.id,
    libraryID: item.libraryID,
    key: "PDF",
    parentItem: item,
  };
  env.globals.Zotero.Items.get = () => attachment;
  env.globals.Zotero.Reader._readers = [{ itemID: 2 }];
  const section = env.section({
    "../pdf/parser": { parsePDFReferences: () => pdf.promise },
    "../sources": {
      sources: { crossref: {} },
      getReferencesByAPI: () => api.promise,
    },
  });
  const state = section.getState(item),
    doc = document(),
    body = doc.body;
  body.dataset.itemKey = state.stateKey;
  const list = doc.createElement("div");
  list.className = "references-list";
  body.append(list);
  state.renders.set(body, () =>
    assert.fail("old request repainted changed host"),
  );
  const pending = section.refresh(body, item, state, () => {}, {
    useCache: false,
    fromCurrentPage: false,
  });
  item.fields.DOI = "10.5555/b";
  const next = section.getState(item);
  assert.notEqual(next, state);
  assert.deepEqual(next.refs, []);
  body.dataset.itemKey = next.stateKey;
  await env.storage.refStorage.set(
    item,
    "FUSED",
    [reference("New host reference")],
    next.stateKey,
  );
  pdf.resolve([reference("Old PDF reference")]);
  api.resolve({ refs: [reference("Old API reference")], source: "crossref" });
  await pending;
  assert.equal(state.loadedOnce, false);
  assert.deepEqual(next.refs, []);
  assert.equal(
    (await env.storage.refStorage.get(item, "FUSED"))[0].title,
    "New host reference",
  );
  assert.equal(await env.storage.refStorage.get(item, "PDF"), undefined);
  assert.equal(await env.storage.refStorage.get(item, "API"), undefined);
});

test("citation paging discards a response belonging to the host's previous DOI", async () => {
  const env = fixture(),
    item = host(),
    wait = deferred();
  const citations = env.load(
    "src/ui/citations.ts",
    { ...env.shared, "../sources": { getCitationsByAPI: () => wait.promise } },
    "\nexport {states,loadMore};\n",
  );
  citations.registerCitationsSection();
  const pane = env.panes.get("citations"),
    doc = document();
  await pane.onAsyncRender({
    body: doc.body,
    item,
    setSectionSummary: () => {},
  });
  const oldKey = env.storage.itemStateKey(item),
    state = citations.states.get(oldKey);
  const pending = citations.loadMore(item, state);
  item.fields.DOI = "10.5555/b";
  await pane.onAsyncRender({
    body: doc.body,
    item,
    setSectionSummary: () => {},
  });
  const next = citations.states.get(env.storage.itemStateKey(item));
  assert.notEqual(next, state);
  wait.resolve({
    items: [reference("Old citing paper")],
    source: "openalex",
    total: 1,
    nextOffset: 1,
  });
  await pending;
  assert.deepEqual(state.refs, []);
  assert.deepEqual(next.refs, []);
  assert.equal(doc.body.querySelectorAll(".references-row").length, 0);
});

test("related recommendations cannot cache or paint an obsolete host response", async () => {
  const env = fixture(),
    item = host(),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  const related = env.load(
    "src/ui/related.ts",
    {
      ...env.shared,
      "../sources": {
        getRelatedByAPI: () => (++calls === 1 ? old.promise : fresh.promise),
      },
    },
    "\nexport {cache};\n",
  );
  related.registerRelatedSection();
  const pane = env.panes.get("related-papers"),
    doc = document();
  await pane.onAsyncRender({
    body: doc.body,
    item,
    setSectionSummary: () => {},
  });
  const oldKey = env.storage.itemStateKey(item);
  await env.fire(350);
  item.fields.DOI = "10.5555/b";
  await pane.onAsyncRender({
    body: doc.body,
    item,
    setSectionSummary: () => {},
  });
  await env.fire(350);
  old.resolve([reference("Old recommendation")]);
  await tick();
  assert.equal(related.cache.has(oldKey), false);
  fresh.resolve([reference("Current recommendation")]);
  await tick();
  assert.equal(
    related.cache.get(env.storage.itemStateKey(item))[0].title,
    "Current recommendation",
  );
  assert.equal(
    doc.body.querySelectorAll(".references-row")[0].textContent,
    "Current recommendation",
  );
});

test("graph builds cannot cache or paint after host identity changes", async () => {
  const env = fixture(),
    item = host(),
    wait = deferred(),
    painted = [];
  const graph = env.load(
    "src/ui/graphSection.ts",
    {
      ...env.shared,
      "../graph/build": { buildGraph: () => wait.promise },
      "../graph/view": {
        GraphView: class {
          destroy() {}
          setData(data) {
            painted.push(data);
          }
        },
      },
      "../core/importer": {},
      "../core/libmatch": {},
    },
    "\nexport {renderGraph,dataCache};\n",
  );
  const doc = document();
  for (const className of [
    "references-graph-container",
    "references-graph-status",
  ]) {
    const child = doc.createElement("div");
    child.className = className;
    doc.body.append(child);
  }
  const pending = graph.renderGraph(doc.body, item, () => {});
  item.fields.DOI = "10.5555/b";
  wait.resolve({
    originId: "W1",
    nodes: [
      {
        id: "W1",
        kind: "origin",
        inLibrary: false,
        ref: reference("Old graph"),
      },
    ],
    edges: [],
  });
  await pending;
  assert.equal(graph.dataCache.size, 0);
  assert.equal(painted.length, 0);
});

test("graph node imports do not relate or repaint after host changes, deletion or shutdown", async () => {
  for (const change of ["identity", "delete", "shutdown", "unchanged"]) {
    const env = fixture(),
      item = host(),
      wait = deferred(),
      relations = [],
      painted = [];
    const graph = env.load(
      "src/ui/graphSection.ts",
      {
        ...env.shared,
        "../graph/build": {},
        "../graph/view": {},
        "../core/importer": {
          importReference: () => wait.promise,
          addRelation: async (...args) => relations.push(args),
        },
        "../core/libmatch": { isRelated: () => false },
      },
      "\nexport {importNode};\n",
    );
    const node = {
      id: "W2",
      kind: "reference",
      inLibrary: false,
      ref: reference("Imported graph work"),
    };
    const pending = graph.importNode(item, node, {
      setInLibrary: (...args) => painted.push(args),
    });
    if (change === "identity") item.fields.DOI = "10.5555/b";
    if (change === "delete") item.deleted = true;
    if (change === "shutdown") env.globals.addon.data.alive = false;
    wait.resolve({ id: 99 });
    await pending;
    assert.equal(relations.length, change === "unchanged" ? 1 : 0, change);
    assert.equal(painted.length, change === "unchanged" ? 1 : 0, change);
    assert.equal(node.inLibrary, change === "unchanged", change);
    assert.equal(node.ref.libItemID, change === "unchanged" ? 99 : undefined);
  }
});

test("graph node import completion does not repaint if the host changes during relation save", async () => {
  const env = fixture(),
    item = host(),
    wait = deferred(),
    painted = [];
  const graph = env.load(
    "src/ui/graphSection.ts",
    {
      ...env.shared,
      "../graph/build": {},
      "../graph/view": {},
      "../core/importer": {
        importReference: async () => ({ id: 99 }),
        addRelation: () => wait.promise,
      },
      "../core/libmatch": { isRelated: () => false },
    },
    "\nexport {importNode};\n",
  );
  const node = {
    id: "W2",
    kind: "reference",
    inLibrary: false,
    ref: reference("Imported graph work"),
  };
  const pending = graph.importNode(item, node, {
    setInLibrary: (...args) => painted.push(args),
  });
  await tick();
  item.fields.DOI = "10.5555/b";
  wait.resolve();
  await pending;
  assert.equal(painted.length, 0);
  assert.equal(node.inLibrary, false);
  assert.equal(node.ref.libItemID, undefined);
});

test("graph navigation revalidates cached bindings in the current library and rejects obsolete views", async () => {
  for (const scenario of [
    "stale-binding",
    "valid",
    "detached",
    "obsolete-before-start",
    "failed-match",
  ]) {
    const env = fixture(),
      wait = deferred(),
      selected = [],
      matchedLibraries = [];
    const win = {
      Zotero_Tabs: { select: () => {} },
      ZoteroPane: { selectItem: (id) => selected.push(id) },
    };
    const graph = env.load(
      "src/ui/graphSection.ts",
      {
        ...env.shared,
        "../utils/window": {
          ...env.shared["../utils/window"],
          getWin: () => win,
        },
        "../graph/build": {},
        "../graph/view": {},
        "../core/importer": {},
        "../core/libmatch": {
          libraryIndex: {
            match: (_ref, libraryID) => {
              matchedLibraries.push(libraryID);
              if (scenario === "failed-match")
                throw new Error("Synthetic unavailable library");
              return wait.promise;
            },
          },
        },
      },
      "\nexport {nodeClicked};\n",
    );
    const node = {
      id: "W2",
      kind: "reference",
      inLibrary: true,
      ref: { ...reference("Originally matched paper"), libItemID: 77 },
    };
    let current = scenario !== "obsolete-before-start";
    const pending = graph.nodeClicked(node, 2, () => current);
    if (scenario === "detached") current = false;
    wait.resolve(scenario === "stale-binding" ? undefined : { id: 99 });
    await pending;
    assert.deepEqual(selected, scenario === "valid" ? [99] : [], scenario);
    assert.deepEqual(
      matchedLibraries,
      scenario === "obsolete-before-start" ? [] : [2],
      scenario,
    );
  }
});

test("an already opened graph hover card cannot import after its host or graph changes", async () => {
  for (const change of ["identity", "detached", "generation", "unchanged"]) {
    const env = fixture(),
      item = host(),
      doc = document();
    env.prefs.set("showPopup", true);
    let actions,
      imports = 0;
    const graph = env.load(
      "src/ui/graphSection.ts",
      {
        ...env.shared,
        "../graph/build": {},
        "../graph/view": {},
        "../core/importer": {
          importReference: async () => {
            imports++;
            return { id: 99 };
          },
          addRelation: async () => {},
        },
        "../core/libmatch": { isRelated: () => false },
        "./rows": {
          getCurrentPopup: () => undefined,
          showRefPopup: (_ref, _rect, _position, _id, callbacks) => {
            actions = callbacks;
            return {};
          },
        },
      },
      "\nexport {makeHoverHandler,requests};\n",
    );
    const hover = graph.makeHoverHandler(doc.body, item);
    hover(
      {
        id: "W2",
        kind: "reference",
        inLibrary: false,
        ref: reference("Graph reference"),
      },
      { x: 0, y: 0, width: 10, height: 10 },
    );
    await env.fire(550);
    assert.ok(actions);
    if (change === "identity") item.fields.DOI = "10.5555/b";
    if (change === "detached") doc.body.root = false;
    if (change === "generation") graph.requests.set(doc.body, 1);
    actions.onImport();
    await tick();
    assert.equal(imports, change === "unchanged" ? 1 : 0, change);
  }
});

test("an already opened graph context menu cannot import after a host edit", async () => {
  for (const changed of [false, true]) {
    const env = fixture(),
      item = host(),
      doc = document();
    let imports = 0;
    doc.createXULElement = (tag) => {
      const element = doc.createElement(tag);
      element.openPopupAtScreen = () => {};
      return element;
    };
    doc.getElementById = () => undefined;
    doc.querySelector = () => undefined;
    doc.documentElement = doc.body;
    const graph = env.load(
      "src/ui/graphSection.ts",
      {
        ...env.shared,
        "../utils/window": {
          ...env.shared["../utils/window"],
          getWin: () => ({ document: doc }),
        },
        "../graph/build": {},
        "../graph/view": {},
        "../core/importer": {
          importReference: async () => {
            imports++;
            return { id: 99 };
          },
          addRelation: async () => {},
        },
        "../core/libmatch": { isRelated: () => false },
      },
      "\nexport {showNodeMenu};\n",
    );
    graph.showNodeMenu(
      doc.body,
      item,
      () => {},
      {
        id: "W2",
        kind: "reference",
        inLibrary: false,
        ref: reference("Graph reference"),
      },
      0,
      0,
    );
    const command = doc.body.children[0].children[0];
    assert.equal(command.attributes.get("label"), "graph-menu-import");
    if (changed) item.fields.DOI = "10.5555/b";
    command.events.get("command")();
    await tick();
    assert.equal(imports, changed ? 0 : 1);
  }
});
