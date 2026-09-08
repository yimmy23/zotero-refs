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
function relatedResult(refs, { complete = true, sources } = {}) {
  return {
    items: refs.map((ref, index) => ({
      ref,
      evidence: [{ source: "openalex", rank: index + 1 }],
      score: 1 / (61 + index),
    })),
    sources: sources || [
      {
        source: "semanticscholar",
        status: complete ? "ready" : "loading",
        count: 0,
      },
      { source: "openalex", status: "ready", count: refs.length },
    ],
    complete,
  };
}
function relatedPanel(env, related) {
  related.registerRelatedSection();
  const pane = env.panes.get("related-papers"),
    doc = document(),
    section = doc.createElement("collapsible-section"),
    summaries = [];
  doc.body.root = false;
  section.root = true;
  section.open = true;
  section.append(doc.body);
  return {
    pane,
    doc,
    section,
    summaries,
    render: (item) =>
      pane.onAsyncRender({
        body: doc.body,
        item,
        setSectionSummary: (value) => summaries.push(value),
      }),
    rows: () => doc.body.querySelectorAll(".references-row"),
    titles: () =>
      doc.body.querySelectorAll(".references-row").map((row) => row.ref.title),
    status: () =>
      doc.body.querySelector(".references-related-status").textContent,
    list: () => doc.body.querySelector(".references-list"),
    reload: () => doc.body.querySelector(".references-toolbar").children[1],
    toggle: (open) => {
      section.open = open;
      pane.onToggle({ body: doc.body });
    },
  };
}
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
      (this.text || "") +
      this.children.map((child) => child.textContent).join("")
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
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.localName === selector) return node;
    }
    return null;
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
  const events = new Map();
  const doc = {
    hidden: false,
    createElement: (tag) => new Element(tag, doc),
    events,
    addEventListener: (name, fn) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
    },
    removeEventListener: (name, fn) => events.get(name)?.delete(fn),
    dispatch: (name) => {
      for (const fn of [...(events.get(name) || [])]) fn();
    },
  };
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
        row.ref = refs[index];
        row.textContent = refs[index].title;
        ctx.list.append(row);
        return row;
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
  const related = (overrides = {}) =>
    load(
      "src/ui/related.ts",
      {
        ...shared,
        "../core/related": load("src/core/related.ts", {
          "./text": text,
          "./types": types,
        }),
        "../sources": { getRelatedByAPI: async () => relatedResult([]) },
        ...overrides,
      },
      "\nexport {cache};\n",
    );
  return {
    globals,
    load,
    shared,
    section,
    related,
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
  const related = env.related({
    "../sources": {
      getRelatedByAPI: () => (++calls === 1 ? old.promise : fresh.promise),
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  const oldKey = env.storage.itemStateKey(item);
  await env.fire(350);
  item.fields.DOI = "10.5555/b";
  await panel.render(item);
  await env.fire(350);
  old.resolve(relatedResult([reference("Old recommendation")]));
  await tick();
  assert.equal(related.cache.has(oldKey), false);
  fresh.resolve(relatedResult([reference("Current recommendation")]));
  await tick();
  assert.equal(
    related.cache.get(env.storage.itemStateKey(item)).result.items[0].ref.title,
    "Current recommendation",
  );
  assert.equal(panel.rows()[0].ref.title, "Current recommendation");
});

test("related renders the first partial result before final completion and caches only the final result", async () => {
  const env = fixture(),
    item = host(),
    wait = deferred(),
    calls = [];
  let publish;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: (ids, limit, partial, current) => {
        calls.push({ ids, limit, current });
        publish = partial;
        return wait.promise;
      },
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  assert.equal(calls.length, 0, "render does not await provider requests");
  await env.fire(350);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, { DOI: "10.5555/a" });
  assert.equal(calls[0].limit, 40);
  assert.equal(calls[0].current(), true);
  publish(relatedResult([reference("First provider")], { complete: false }));
  assert.deepEqual(panel.titles(), ["First provider"]);
  assert.equal(panel.status(), "related-loading-more");
  assert.equal(panel.list().getAttribute("aria-busy"), "true");
  assert.equal(panel.reload().disabled, true);
  assert.equal(related.cache.size, 0);
  const final = relatedResult([
    reference("First provider"),
    reference("Second provider"),
  ]);
  final.items[0].evidence.push({ source: "semanticscholar", rank: 3 });
  final.sources[0] = { source: "semanticscholar", status: "ready", count: 1 };
  wait.resolve(final);
  await tick();
  assert.deepEqual(panel.titles(), ["First provider", "Second provider"]);
  assert.equal(panel.status(), "related-ranking");
  assert.equal(panel.list().getAttribute("aria-busy"), "false");
  assert.equal(panel.reload().disabled, false);
  assert.equal(panel.summaries.at(-1), "2");
  assert.equal(
    panel.rows()[0].querySelector(".references-related-reason").textContent,
    "related-source-rank · related-source-rank",
  );
  assert.equal(related.cache.get(env.storage.itemStateKey(item)).result, final);
  assert.equal(
    typeof related.cache.get(env.storage.itemStateKey(item)).time,
    "number",
  );
});

for (const change of [
  "collapse",
  "destroy",
  "detach",
  "switch",
  "hidden",
  "shutdown",
  "identity",
]) {
  test(`related drops partial/final completion after ${change}`, async () => {
    const env = fixture(),
      item = host(),
      wait = deferred();
    let publish, current;
    const related = env.related({
      "../sources": {
        getRelatedByAPI: (_ids, _limit, partial, owns) => {
          publish = partial;
          current = owns;
          return wait.promise;
        },
      },
    });
    const panel = relatedPanel(env, related);
    await panel.render(item);
    await env.fire(350);
    publish(relatedResult([reference("Visible partial")], { complete: false }));
    if (change === "collapse") panel.toggle(false);
    if (change === "destroy") panel.pane.onDestroy({ body: panel.doc.body });
    if (change === "detach") panel.section.root = false;
    if (change === "hidden") panel.doc.hidden = true;
    if (change === "shutdown") env.globals.addon.data.alive = false;
    if (change === "identity") item.fields.DOI = "10.5555/changed";
    if (change === "switch") {
      const next = host(2);
      next.key = "OTHERKEY";
      next.fields.DOI = "10.5555/next";
      panel.pane.onItemChange({
        body: panel.doc.body,
        item: next,
        setEnabled: () => {},
      });
      await panel.render(next);
    }
    const before = panel.doc.body.textContent;
    const summaries = panel.summaries.length;
    assert.equal(current(), false, "source cancellation predicate is live");
    publish(relatedResult([reference("Late partial")], { complete: false }));
    wait.resolve(relatedResult([reference("Late final")]));
    await tick();
    assert.equal(panel.doc.body.textContent, before);
    assert.equal(panel.summaries.length, summaries);
    assert.equal(related.cache.size, 0);
  });
}

test("related cancels collapsed/destroyed debounce work and retries when reopened", async () => {
  for (const change of ["collapse", "destroy"]) {
    const env = fixture(),
      item = host();
    let calls = 0;
    const related = env.related({
      "../sources": {
        getRelatedByAPI: async () => {
          calls++;
          return relatedResult([reference("Fresh result")]);
        },
      },
    });
    const panel = relatedPanel(env, related);
    await panel.render(item);
    if (change === "collapse") panel.toggle(false);
    else panel.pane.onDestroy({ body: panel.doc.body });
    await env.fire(350);
    assert.equal(calls, 0, change);
    assert.equal(related.cache.size, 0);
    if (change === "collapse") panel.toggle(true);
    else await panel.render(item);
    await env.fire(350);
    assert.equal(calls, 1, change);
    assert.deepEqual(panel.titles(), ["Fresh result"]);
  }
});

test("related reopening an interrupted request starts a fresh generation without caching the late old result", async () => {
  const env = fixture(),
    item = host(),
    old = deferred(),
    fresh = deferred(),
    owns = [];
  let calls = 0;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: (_ids, _limit, _partial, current) => {
        owns.push(current);
        return ++calls === 1 ? old.promise : fresh.promise;
      },
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  panel.toggle(false);
  assert.equal(panel.list().getAttribute("aria-busy"), "false");
  assert.equal(panel.reload().disabled, false);
  panel.toggle(true);
  await env.fire(350);
  assert.equal(calls, 2);
  assert.equal(owns[0](), false);
  assert.equal(owns[1](), true);
  old.resolve(relatedResult([reference("Abandoned request")]));
  await tick();
  assert.equal(related.cache.size, 0);
  assert.deepEqual(panel.titles(), []);
  fresh.resolve(relatedResult([reference("Retried request")]));
  await tick();
  assert.deepEqual(panel.titles(), ["Retried request"]);
  assert.equal(related.cache.size, 1);
});

test("related row/import enrichment cannot mutate cached provider metadata or later cached views", async () => {
  const env = fixture(),
    item = host();
  const ref = {
    ...reference("Provider paper"),
    text: "Provider description",
    identifiers: { DOI: "10.5555/recommended" },
    tags: [{ tag: "Evidence" }, "Original"],
    firstAuthors: ["First Author"],
    correspondingAuthors: ["Corresponding Author"],
    references: [
      {
        ...reference("Nested reference"),
        identifiers: { DOI: "10.5555/nested" },
      },
    ],
  };
  const result = relatedResult([ref]),
    snapshot = JSON.parse(JSON.stringify(result));
  let calls = 0;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: async () => {
        calls++;
        return result;
      },
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  const rendered = panel.rows()[0].ref;
  assert.notEqual(rendered, ref);
  assert.equal(rendered.text, "Provider description");
  rendered.libItemID = 99;
  rendered.identifiers.DOI = "10.5555/import-enriched";
  rendered.authors.push("Enriched Author");
  rendered.tags[0].tag = "Modified";
  rendered.tags.push("Extra");
  rendered.firstAuthors.push("Enriched First Author");
  rendered.correspondingAuthors.push("Enriched Corresponding Author");
  rendered.references[0].identifiers.DOI = "10.5555/nested-enrichment";
  rendered.references.push(reference("Extra nested reference"));
  rendered.text = "Modified row description";
  assert.deepEqual(
    related.cache.get(env.storage.itemStateKey(item)).result,
    snapshot,
  );
  await panel.render(item);
  await env.fire(350);
  assert.equal(calls, 1, "reopen uses the valid final cache");
  assert.deepEqual(panel.rows()[0].ref, ref);
  assert.equal(panel.rows()[0].ref.libItemID, undefined);
});

test("related visibility changes cancel pending work, resume it, and dispose listeners", async () => {
  const env = fixture(),
    item = host(),
    old = deferred(),
    fresh = deferred();
  let calls = 0;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: () => (++calls === 1 ? old.promise : fresh.promise),
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  assert.equal(panel.doc.events.get("visibilitychange").size, 1);
  await env.fire(350);
  panel.doc.hidden = true;
  panel.doc.dispatch("visibilitychange");
  old.resolve(relatedResult([reference("Hidden completion")]));
  await tick();
  assert.deepEqual(panel.titles(), []);
  assert.equal(related.cache.size, 0);
  panel.doc.hidden = false;
  panel.doc.dispatch("visibilitychange");
  await env.fire(350);
  assert.equal(calls, 2);
  fresh.resolve(relatedResult([reference("Visible retry")]));
  await tick();
  assert.deepEqual(panel.titles(), ["Visible retry"]);
  await panel.render(item);
  assert.equal(
    panel.doc.events.get("visibilitychange").size,
    1,
    "rerender removes the previous listener",
  );
  panel.pane.onDestroy({ body: panel.doc.body });
  assert.equal(panel.doc.events.get("visibilitychange").size, 0);
  panel.doc.dispatch("visibilitychange");
  await env.fire(350);
  assert.equal(calls, 2, "destroyed visibility callbacks cannot restart work");
});

test("related failure is not cached and explicit refresh retries while keeping manual links", async () => {
  const env = fixture(),
    item = host(),
    manual = host(3);
  manual.fields.title = "Manual paper retained on failure";
  manual.fields.DOI = "10.5555/manual";
  manual.getCreators = () => [];
  item.relatedItems = ["MANUAL"];
  env.globals.Zotero.Items.getByLibraryAndKey = () => manual;
  let calls = 0;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: async () =>
        ++calls === 1
          ? relatedResult([], {
              sources: [
                { source: "openalex", status: "unavailable", count: 0 },
                { source: "semanticscholar", status: "unavailable", count: 0 },
              ],
            })
          : relatedResult([reference("Recovered recommendation")]),
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  assert.deepEqual(panel.titles(), ["Manual paper retained on failure"]);
  assert.equal(panel.status(), "panel-load-failed");
  assert.equal(related.cache.size, 0);
  assert.equal(panel.reload().disabled, false);
  panel.reload().events.get("click")();
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(panel.titles(), [
    "Manual paper retained on failure",
    "Recovered recommendation",
  ]);
  assert.equal(related.cache.size, 1);
});

test("related no-identifier items retain manual links without making provider requests", async () => {
  const env = fixture(),
    item = host(),
    manual = host(3);
  item.fields.DOI = "";
  manual.fields.title = "Local relation";
  manual.getCreators = () => [];
  item.relatedItems = ["MANUAL"];
  env.globals.Zotero.Items.getByLibraryAndKey = () => manual;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: () =>
        assert.fail("missing identifier must not trigger provider request"),
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  assert.deepEqual(panel.titles(), ["Local relation"]);
  assert.equal(panel.status(), "related-no-identifier");
  assert.equal(panel.reload().disabled, true);
  assert.equal(related.cache.size, 0);
});

test("related distinguishes empty success, incomplete empty results, and unavailable providers", async () => {
  for (const [statuses, message, cached] of [
    [["ready", "ready"], "related-empty-result", true],
    [["ready", "unavailable"], "related-partial-empty", false],
    [["unavailable", "unavailable"], "panel-load-failed", false],
  ]) {
    const env = fixture(),
      item = host();
    const result = relatedResult([], {
      sources: [
        { source: "semanticscholar", status: statuses[0], count: 0 },
        { source: "openalex", status: statuses[1], count: 0 },
      ],
    });
    const related = env.related({
      "../sources": { getRelatedByAPI: async () => result },
    });
    const panel = relatedPanel(env, related);
    await panel.render(item);
    await env.fire(350);
    assert.equal(panel.list().message, message);
    assert.equal(related.cache.has(env.storage.itemStateKey(item)), cached);
    if (message === "panel-load-failed")
      assert.equal(
        panel.status(),
        "",
        "failure is not duplicated in status and list",
      );
  }
});

test("related partial provider failure keeps useful recommendations but does not freeze them in cache", async () => {
  const env = fixture(),
    item = host();
  let calls = 0;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: async () => {
        calls++;
        return relatedResult([reference("Available provider paper")], {
          sources: [
            { source: "semanticscholar", status: "unavailable", count: 0 },
            { source: "openalex", status: "ready", count: 1 },
          ],
        });
      },
    },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  assert.deepEqual(panel.titles(), ["Available provider paper"]);
  assert.equal(panel.status(), "related-partial");
  assert.equal(related.cache.size, 0);
  await panel.render(item);
  await env.fire(350);
  assert.equal(calls, 2, "a new view can retry the missing provider");
});

test("related cache reuse does not extend TTL and an expired result is fetched again", async () => {
  const env = fixture(),
    item = host(),
    cached = relatedResult([reference("Cached result")]),
    fresh = relatedResult([reference("Fresh result")]);
  let calls = 0;
  const related = env.related({
    "../sources": {
      getRelatedByAPI: async () => {
        calls++;
        return fresh;
      },
    },
  });
  const key = env.storage.itemStateKey(item),
    time = Date.now() - 10000;
  related.cache.set(key, { result: cached, time });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  assert.equal(calls, 0);
  assert.deepEqual(panel.titles(), ["Cached result"]);
  assert.equal(related.cache.get(key).time, time);
  related.cache.get(key).time = Date.now() - 31 * 60 * 1000;
  await panel.render(item);
  await env.fire(350);
  assert.equal(calls, 1);
  assert.deepEqual(panel.titles(), ["Fresh result"]);
  assert.equal(related.cache.get(key).result, fresh);
  assert(related.cache.get(key).time > time);
});

test("related provider display cap does not consume or truncate manual links", async () => {
  const env = fixture(),
    item = host();
  const manuals = Array.from({ length: 22 }, (_, index) => {
    const entry = host(index + 2);
    entry.fields.title = `Manual ${index + 1}`;
    entry.fields.DOI = `10.5555/manual-${index + 1}`;
    entry.getCreators = () => [];
    return entry;
  });
  item.relatedItems = manuals.map((_, index) => String(index));
  env.globals.Zotero.Items.getByLibraryAndKey = (_libraryID, key) =>
    manuals[Number(key)];
  const result = relatedResult(
    Array.from({ length: 25 }, (_, index) => ({
      ...reference(`Recommendation ${index + 1}`),
      identifiers: { DOI: `10.5555/recommendation-${index + 1}` },
    })),
  );
  const related = env.related({
    "../sources": { getRelatedByAPI: async () => result },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  assert.equal(panel.rows().length, 42);
  assert.deepEqual(
    panel.titles().slice(0, 22),
    manuals.map((entry) => entry.fields.title),
  );
  assert.equal(panel.titles().at(-1), "Recommendation 20");
  assert.equal(
    related.cache.get(env.storage.itemStateKey(item)).result.items.length,
    25,
  );
});

test("related preserves an ambiguous ID bridge already retained by real rank fusion", async () => {
  const env = fixture(),
    item = host();
  const { fuseRelated } = env.load("src/core/related.ts");
  const a = {
    ...reference("Work A"),
    identifiers: { DOI: "10.5555/bridge", PMID: "11111111" },
  };
  const b = {
    ...reference("Work B"),
    identifiers: { DOI: "10.5555/bridge", PMID: "22222222" },
  };
  const bridge = {
    ...reference("Ambiguous bridge"),
    identifiers: { DOI: "10.5555/bridge" },
  };
  const result = fuseRelated([
    { source: "semanticscholar", status: "ready", items: [a, b] },
    { source: "openalex", status: "ready", items: [bridge] },
  ]);
  assert.equal(
    result.items.length,
    3,
    "core retains a bridge matching two mutually conflicting identities",
  );
  const related = env.related({
    "../sources": { getRelatedByAPI: async () => result },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  await env.fire(350);
  assert.deepEqual(
    panel.titles(),
    result.items.map(({ ref }) => ref.title),
    "UI only excludes host/manual records, never greedily deduplicates the fused pool again",
  );
  assert.equal(panel.rows().length, 3);
  assert.deepEqual(
    panel.rows().map(({ ref }) => ref.identifiers),
    result.items.map(({ ref }) => ref.identifiers),
  );
});

test("related preserves manual links first, deduplicates strict IDs, and does not drop distinct same-title papers", async () => {
  const env = fixture(),
    item = host(),
    manual = host(3),
    deleted = host(4);
  manual.fields.DOI = "10.5555/manual";
  manual.fields.title = "Manually linked paper";
  manual.getCreators = () => [{ firstName: "Manual", lastName: "Author" }];
  deleted.deleted = true;
  item.relatedItems = ["MANUAL", "DELETED", "MISSING"];
  env.globals.Zotero.Items.getByLibraryAndKey = (libraryID, key) => {
    assert.equal(libraryID, item.libraryID);
    return key === "MANUAL" ? manual : key === "DELETED" ? deleted : undefined;
  };
  const result = relatedResult([
    {
      ...reference("Remote manual duplicate"),
      identifiers: { DOI: "https://doi.org/10.5555/MANUAL" },
    },
    {
      ...reference("Host returned under a different title"),
      identifiers: { DOI: "https://doi.org/10.5555/A" },
    },
    {
      ...reference(item.fields.title),
      identifiers: { DOI: "10.5555/distinct" },
    },
    reference(item.fields.title),
    {
      ...reference("Fresh recommendation"),
      identifiers: { DOI: "10.5555/fresh" },
    },
  ]);
  const related = env.related({
    "../sources": { getRelatedByAPI: async () => result },
  });
  const panel = relatedPanel(env, related);
  await panel.render(item);
  assert.deepEqual(panel.titles(), ["Manually linked paper"]);
  assert.equal(
    panel.rows()[0].querySelector(".references-related-reason").textContent,
    "related-manual",
  );
  await env.fire(350);
  assert.deepEqual(panel.titles(), [
    "Manually linked paper",
    "Paper A",
    "Paper A",
    "Fresh recommendation",
  ]);
  assert.equal(panel.rows()[0].ref.libItemID, manual.id);
  assert.equal(
    related.cache.get(env.storage.itemStateKey(item)).result.items.length,
    5,
    "presentation filtering does not rewrite provider cache",
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
