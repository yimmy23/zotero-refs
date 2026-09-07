import console from "node:console";
import process from "node:process";
import { setImmediate } from "node:timers";
/** Synthetic UI regression checks. No application, profile, network or real data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { transformSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(root + "package.json", "utf8"));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Only browser mechanics are simulated. Parsing, event callbacks, filtering,
// settings logic and async request ownership execute the actual source below.
class Node {
  constructor(name, doc) {
    this.localName = name;
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.hidden = false;
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
    this.events = new Map();
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => {
        this.className = [
          ...new Set([...this.className.split(/\s+/), ...names]),
        ]
          .join(" ")
          .trim();
      },
      remove: (name) => {
        this.className = this.className
          .split(/\s+/)
          .filter((part) => part !== name)
          .join(" ");
      },
      toggle: (name, on) => {
        (on ? this.classList.add : this.classList.remove)(name);
      },
    };
  }
  get isConnected() {
    return !!(this.connectedRoot || this.parentElement?.isConnected);
  }
  get childElementCount() {
    return this.children.filter((child) => child.localName !== "#text").length;
  }
  get textContent() {
    return (
      this.ownText || this.children.map((child) => child.textContent).join("")
    );
  }
  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.ownText = String(value);
  }
  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse())
      this.insertBefore(node, this.children[0]);
  }
  insertBefore(node, before) {
    if (typeof node === "string") {
      const text = new Node("#text", this.ownerDocument);
      text.textContent = node;
      node = text;
    }
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentElement = this;
    this.ownText = "";
    return node;
  }
  remove() {
    const parent = this.parentElement;
    if (parent) parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceWith(node) {
    const parent = this.parentElement;
    if (!parent) return;
    node.remove();
    parent.insertBefore(node, this);
    this.remove();
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  matches(selector) {
    if (selector.startsWith("."))
      return this.classList.contains(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const attr = selector.match(/^\[([^=]+)=([^\]]+)\]$/);
    if (attr)
      return this.getAttribute(attr[1]) === attr[2].replace(/["']/g, "");
    return this.localName === selector;
  }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > "))
      return this.children.filter((child) => child.matches(selector.slice(9)));
    const parts = selector.split(/\s+/);
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(parts.at(-1))) {
          let ancestor = child.parentElement;
          let i = parts.length - 2;
          while (i >= 0 && ancestor) {
            if (ancestor.matches(parts[i])) i--;
            ancestor = ancestor.parentElement;
          }
          if (i < 0) found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(name, fn) {
    const list = this.events.get(name) || [];
    list.push(fn);
    this.events.set(name, list);
  }
  async emit(name, fields = {}) {
    const event = {
      type: name,
      target: this,
      currentTarget: this,
      button: 0,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...fields,
    };
    for (const fn of this.events.get(name) || []) {
      await fn(event);
      if (event.stopped) break;
    }
    return event;
  }
}
function document() {
  const doc = {
    createElement: (name) => new Node(name, doc),
    getElementById: (id) => doc.root.querySelector(`#${id}`),
  };
  doc.root = doc.createElement("root");
  doc.root.connectedRoot = true;
  doc.defaultView = { document: doc };
  return doc;
}
function append(parent, tag, className) {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className || "";
  parent.append(node);
  return node;
}
const locale = { getString: (key) => key, getLocaleID: (key) => key };
const identityGuards = {
  guard: (_label, fn) => fn,
  guardAsync: (_label, fn) => fn,
};
function environment() {
  const preferences = new Map([
    [`${pkg.config.prefsPrefix}.notInLibraryOpacity`, "0.7"],
  ]);
  const errors = [],
    timers = [],
    copied = [];
  const Zotero = {
    Prefs: {
      get: (key) => preferences.get(key),
      set: (key, value) => preferences.set(key, value),
    },
    Items: { get: () => undefined },
  };
  class ProgressWindow {
    createLine() {
      return this;
    }
    show() {
      return this;
    }
  }
  const ztoolkit = {
    log: (...args) => errors.push(args),
    ProgressWindow,
    Clipboard: class {
      addText(value) {
        this.value = value;
        return this;
      }
      copy() {
        copied.push(this.value);
      }
    },
  };
  const globals = { Zotero, addon: { data: { alive: true } }, ztoolkit };
  const windowTools = {
    getWin: () => ({}),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: (id) => {
      if (id) timers[id - 1] = null;
    },
  };
  function load(file, imports = {}, extra = "") {
    const code = transformSync(fs.readFileSync(root + file, "utf8") + extra, {
      loader: "ts",
      format: "cjs",
      target: "es2022",
    }).code;
    const module = { exports: {} };
    new Function("module", "exports", "require", ...Object.keys(globals), code)(
      module,
      module.exports,
      (name) => {
        if (name === "../../package.json") return pkg;
        assert.ok(name in imports, `${file}: unmocked dependency ${name}`);
        return imports[name];
      },
      ...Object.values(globals),
    );
    return module.exports;
  }
  const prefs = load("src/utils/prefs.ts");
  const text = load("src/core/text.ts");
  const controls = load("src/ui/controls.ts", { "../utils/locale": locale });
  const types = load("src/core/types.ts");
  const popupMetadata = load("src/core/popupMetadata.ts", {
    "./text": text,
    "./abstractText": load("src/core/abstractText.ts"),
    "./types": types,
  });
  const shared = {
    "../utils/locale": locale,
    "../utils/prefs": prefs,
    "../utils/window": windowTools,
    "../utils/guard": identityGuards,
    "../core/text": text,
    "../core/types": types,
    "../core/popupMetadata": popupMetadata,
    "./controls": controls,
    "../core/storage": {
      itemCacheKey: (item) => `${item.libraryID}/${item.key}`,
      itemStateKey: (item) => `${item.libraryID}/${item.key}`,
    },
  };
  return { load, shared, globals, errors, timers, copied, preferences, prefs };
}
function host() {
  return {
    libraryID: 1,
    key: "HOST",
    isRegularItem: () => true,
    getField: (key) => (key === "DOI" ? "10.1234/host" : ""),
    getCollections: () => [],
  };
}
function rowsModule(env, match = async () => undefined) {
  return env.load("src/ui/rows.ts", {
    ...env.shared,
    "../core/libmatch": { libraryIndex: { match }, isRelated: () => true },
    "../core/importer": {},
    "../sources": {},
    "../sources/cnki": {},
    "../sources/abstract": {},
    "./popup": {},
  });
}
const ref = (title, extras = {}) => ({
  title,
  text: title,
  authors: ["Author"],
  identifiers: {},
  ...extras,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function formatter() {
  const env = environment();
  return env.load("src/ui/section.ts", {
    ...env.shared,
    "../core/fuse": {},
    "../sources": {},
    "../pdf/parser": {},
    "./rows": {},
    "./batchImport": {},
  }).formatReferences;
}

test("Markdown export preserves bracketed titles as one escaped link label", () => {
  const format = formatter();
  const output = format(
    [
      ref("Study [phase 2]\r\nFollow-up\\results\nFinal", {
        url: "https://example.test/work(a)",
      }),
    ],
    "markdown",
  );
  assert.equal(
    output,
    "1. [Study \\[phase 2\\] Follow-up\\\\results Final](<https://example.test/work(a)>)",
  );
  assert.equal(output.split("\n").length, 1);
});

test("Markdown export rejects script URLs and can use a safe DOI fallback", () => {
  const format = formatter();
  assert.equal(
    format([ref("Unsafe source", { url: "javascript:alert(1)" })], "markdown"),
    "1. Unsafe source",
  );
  assert.equal(
    format(
      [
        ref("Unsafe identifier", {
          identifiers: { CNKI: "javascript:alert(1)" },
        }),
      ],
      "markdown",
    ),
    "1. Unsafe identifier",
  );
  const fallback = format(
    [
      ref("Verified identifier", {
        url: "javascript:alert(1)",
        identifiers: { DOI: "10.1234/safe" },
      }),
    ],
    "markdown",
  );
  assert.equal(
    fallback,
    "1. [Verified identifier](<https://doi.org/10.1234%2Fsafe>)",
  );
  assert.ok(!fallback.includes("javascript:"));
});

test("CSV export neutralizes formula prefixes across fields and quotes embedded text", () => {
  const format = formatter();
  const output = format(
    [
      ref("=SUM(1,2)", {
        authors: ["+Author"],
        year: "-2024",
        primaryVenue: "@venue",
        identifiers: { DOI: "\t10.1234/test" },
        url: "\rhttps://example.test",
        text: 'Plain "quoted", note',
      }),
    ],
    "csv",
  );
  assert.equal(
    output,
    [
      "number,title,authors,year,venue,doi,url,text",
      '1,"\'=SUM(1,2)","\'+Author","\'-2024","\'@venue","\'\t10.1234/test","\'\rhttps://example.test","Plain ""quoted"", note"',
    ].join("\n"),
  );
});

test("new graph center survives an older request completing last", async () => {
  const env = environment(),
    doc = document(),
    body = append(doc.root, "div");
  append(body, "div", "references-graph-container");
  append(body, "span", "references-graph-status");
  const homeButton = append(body, "button", "references-graph-home");
  const pending = [],
    painted = [],
    summaries = [];
  const graph = env.load(
    "src/ui/graphSection.ts",
    {
      ...env.shared,
      "../graph/build": {
        buildGraph: (input, options) =>
          new Promise((resolve) => pending.push({ input, options, resolve })),
      },
      "../graph/view": {
        GraphView: class {
          constructor(container) {
            this.container = container;
          }
          destroy() {}
          setData(data) {
            painted.push(data.id);
          }
        },
      },
      "../core/importer": {},
      "../core/libmatch": {},
      "./rows": {},
    },
    "\nexport { renderGraph, centers };\n",
  );
  const first = graph.renderGraph(body, host(), (value) =>
    summaries.push(value),
  );
  graph.centers.set(body, {
    ids: { DOI: "10.1234/new" },
    key: "new",
    label: "new center",
  });
  const second = graph.renderGraph(body, host(), (value) =>
    summaries.push(value),
  );
  pending[1].resolve({ id: "new", nodes: [{}, {}] });
  await second;
  pending[0].options.onStatus("obsolete progress");
  pending[0].resolve({ id: "old", nodes: [{}] });
  await first;
  assert.deepEqual(painted, ["new"]);
  assert.deepEqual(summaries, ["2"]);
  assert.ok(homeButton.title.includes("new center"));
  assert.equal(
    body.querySelector(".references-graph-status").textContent,
    "2 graph-nodes",
  );
  assert.equal(env.errors.length, 0);
});

test("zero citations remain exhausted and hide Load more on revisit", async () => {
  const env = environment(),
    doc = document(),
    body = append(doc.root, "div");
  let section,
    calls = 0;
  env.globals.Zotero.ItemPaneManager = {
    registerSection: (value) => {
      section = value;
    },
  };
  const module = env.load("src/ui/citations.ts", {
    ...env.shared,
    "../sources": {
      getCitationsByAPI: async () => {
        calls++;
        return { items: [], total: 0, source: "openalex" };
      },
    },
    "./rows": rowsModule(env),
  });
  module.registerCitationsSection();
  const render = () =>
    section.onAsyncRender({ body, item: host(), setSectionSummary() {} });
  await render();
  await body.querySelector(".references-load-more").emit("click");
  await render();
  const more = body.querySelector(".references-load-more");
  assert.ok(more.hidden || more.style.display === "none");
  assert.ok(
    body
      .querySelector(".references-list")
      .textContent.includes("citations-empty"),
  );
  await more.emit("click");
  assert.equal(calls, 1);
  assert.equal(env.errors.length, 0);
});

test("badge and metadata filters select the same rows for batch import", async () => {
  const env = environment(),
    rows = rowsModule(env),
    doc = document(),
    body = append(doc.root, "div");
  const refs = [
    ref("Alpha", { tags: [{ text: "API" }], retracted: true, year: "2024" }),
    ref("Beta", { year: "2023" }),
  ];
  let imported;
  const section = env.load(
    "src/ui/section.ts",
    {
      ...env.shared,
      "../core/fuse": {},
      "../sources": {},
      "../pdf/parser": {},
      "./rows": rows,
      "./batchImport": {
        runBatchImport: async (_host, targets) => {
          imported = targets;
          return null;
        },
      },
    },
    "\nexport { buildToolbar };\n",
  );
  section.buildToolbar(body, host(), { refs, importing: false }, () => {});
  const list = append(body, "div", "references-list");
  refs.forEach((_, index) =>
    rows.renderRefRow({ hostItem: host(), list }, refs, index),
  );
  const input = body.querySelector(".references-search input");
  const button = body.querySelector(".references-icon-import").parentElement;
  for (const query of ["API", "retracted-badge", "2024 Author", "Alpha"]) {
    input.value = query;
    await input.emit("input");
    await button.emit("click");
    assert.deepEqual(
      list.querySelectorAll(".references-row").map((row) => row.hidden),
      [false, true],
      query,
    );
    assert.deepEqual(imported, [refs[0]], query);
  }
  assert.equal(env.errors.length, 0);
});

test("editing replaces old identity and relation state while retaining printed position", async () => {
  const env = environment(),
    doc = document(),
    list = append(doc.root, "div", "references-list");
  const refs = [
    ref("Old study", {
      identifiers: { DOI: "10.1234/old" },
      libItemID: 9,
      url: "https://example.test/old",
      oaUrl: "https://example.test/old.pdf",
      retracted: true,
      tags: [{ text: "API" }],
      number: 3,
      page: 5,
      x: 40,
      y: 500,
    }),
  ];
  const rows = rowsModule(env, async (reference) =>
    reference.identifiers.DOI === "10.1234/old"
      ? { id: 9, itemType: "journalArticle" }
      : undefined,
  );
  rows.renderRefRow({ hostItem: host(), list, editable: true }, refs, 0);
  await tick();
  assert.equal(list.querySelector(".references-row-action").textContent, "-");
  await list
    .querySelector(".references-row-label")
    .emit("keydown", { key: "F2" });
  const edit = list.querySelector("textarea");
  edit.value =
    "Brown B. New clinical study. Journal. 2025; 1:11–21. doi:10.1234/new";
  await edit.emit("blur");
  await tick();
  assert.equal(refs[0].identifiers.DOI, "10.1234/new");
  for (const field of ["libItemID", "oaUrl", "retracted", "tags"])
    assert.equal(refs[0][field], undefined, field);
  assert.equal(decodeURIComponent(refs[0].url), "https://doi.org/10.1234/new");
  assert.deepEqual(
    [refs[0].number, refs[0].page, refs[0].x, refs[0].y],
    [3, 5, 40, 500],
  );
  assert.equal(list.querySelectorAll(".references-row").length, 1);
  assert.equal(list.querySelector(".references-row-action").textContent, "+");
  await list
    .querySelector(".references-row-label")
    .emit("keydown", { key: "Enter" });
  assert.ok(env.copied.at(-1).includes("10.1234/new"));
  assert.ok(!env.copied.at(-1).includes("10.1234/old"));
  assert.equal(env.errors.length, 0);
});

test("Escape cancels editing without changing reference data", async () => {
  const env = environment(),
    doc = document(),
    list = append(doc.root, "div", "references-list"),
    rows = rowsModule(env);
  const original = ref("Original citation"),
    refs = [original];
  rows.renderRefRow({ hostItem: host(), list, editable: true }, refs, 0);
  await list
    .querySelector(".references-row-label")
    .emit("keydown", { key: "F2" });
  const edit = list.querySelector("textarea");
  edit.value = "Discard this change";
  await edit.emit("keydown", { key: "Escape" });
  await edit.emit("blur");
  assert.equal(refs[0], original);
  assert.equal(list.querySelector("textarea"), null);
});

test("built full preference keys restore invalid values and invalidate CNKI sessions", async () => {
  const env = environment(),
    doc = document(),
    panel = append(doc.root, "vbox");
  panel.setAttribute("id", "refs-preferences");
  const module = env.load("src/modules/preferenceScript.ts", {
    "../utils/prefs": env.prefs,
  });
  await module.registerPrefsScripts(doc.defaultView);
  await module.registerPrefsScripts(doc.defaultView);
  assert.equal(panel.events.get("change").length, 1);
  const input = append(panel, "input");
  input.type = "number";
  input.validity = { valid: false };
  input.value = "999";
  input.reportValidity = () => {
    input.reported = true;
  };
  input.setAttribute(
    "preference",
    `${pkg.config.prefsPrefix}.citationsPageSize`,
  );
  env.prefs.setPref("citationsPageSize", 25);
  const event = await panel.emit("change", { target: input });
  assert.equal(input.value, "25");
  assert.ok(event.stopped);
  assert.ok(input.reported);
  assert.equal(env.prefs.getPref("citationsPageSize"), 25);
  for (const key of ["CNKI.username", "CNKI.password"]) {
    env.prefs.setPref("CNKI.token", "synthetic-token");
    input.type = "text";
    input.validity.valid = true;
    input.value = "changed";
    input.setAttribute("preference", `${pkg.config.prefsPrefix}.${key}`);
    await panel.emit("change", { target: input });
    assert.equal(env.prefs.getPref("CNKI.token"), "");
  }
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
console.log(
  `UI regression: ${tests.length - failed}/${tests.length} checks passed (synthetic DOM; no rendering claim).`,
);
process.exitCode = failed ? 1 : 0;
