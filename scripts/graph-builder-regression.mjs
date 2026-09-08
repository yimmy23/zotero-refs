/** Real graph builder/view with synthetic provider data; no app or network. */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import vm from "node:vm";
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
} from "node:timers";
import { build } from "esbuild";

const stubs = {
  "../core/libmatch": "export const libraryIndex = fixture.libraryIndex;",
  "../utils/locale":
    "export const getString = (id, options) => id + JSON.stringify(options || {});",
  "../sources/openalex":
    "export const {getWorkFull, getWorksBatch, openalex} = fixture;",
};
const compiled = await build({
  stdin: {
    contents:
      'export {buildGraph} from "./src/graph/build"; export {GraphView} from "./src/graph/view";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [
    {
      name: "graph-fixture-providers",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) =>
          Object.hasOwn(stubs, path)
            ? { path, namespace: "fixture" }
            : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: stubs[path],
          loader: "js",
        }));
      },
    },
  ],
});

const paper = (id, citationCount = 0) => ({
  identifiers: { openAlex: id },
  title: `Fixture ${id}`,
  authors: [],
  source: "openalex",
  citationCount,
});
const work = (
  id,
  referencedWorks = [],
  relatedWorks = [],
  citationCount = 0,
) => ({
  ref: paper(id, citationCount),
  referencedWorks,
  relatedWorks,
});
function fixture({ origin = work("W0"), works = [], citing = [], match } = {}) {
  const requests = [],
    matches = [],
    logs = [];
  const providers = {
    getWorkFull: async (ids) => {
      requests.push({ type: "origin", ids });
      return origin;
    },
    getWorksBatch: async (ids, full, options) => {
      requests.push({
        type: full ? "references" : "related",
        ids: [...ids],
        full,
        options,
      });
      return new Map(
        ids.flatMap((id) => {
          const found = works.find(
            (candidate) => candidate.ref.identifiers.openAlex === id,
          );
          return found ? [[id, found]] : [];
        }),
      );
    },
    openalex: {
      getCitations: async (ids, offset, limit) => {
        requests.push({ type: "citing", ids, offset, limit });
        return { items: citing };
      },
    },
    libraryIndex: {
      match: async (ref, libraryID) => {
        matches.push({ ref, libraryID });
        return match?.(ref, libraryID);
      },
    },
  };
  const context = vm.createContext({
    module: { exports: {} },
    fixture: providers,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ztoolkit: { log: (...args) => logs.push(args) },
  });
  vm.runInContext(compiled.outputFiles[0].text, context);
  return {
    ...context.module.exports,
    requests,
    matches,
    logs,
    graph(maxNodes = 50, ids = { openAlex: "W0" }) {
      return context.module.exports.buildGraph(
        { ids, libraryID: 7 },
        { maxNodes },
      );
    },
  };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const edge = (graph, type, source, target) =>
  graph.edges.find(
    (value) =>
      value.type === type && value.source === source && value.target === target,
  );
const tests = [];
const test = (name, run) => tests.push([name, run]);

test("citation direction is citing to cited, and provider recommendations are not citations", async () => {
  const f = fixture({
    origin: work("W0", ["WR"], ["WP"]),
    works: [work("WR"), work("WP")],
    citing: [paper("WC")],
  });
  const graph = await f.graph();
  assert.equal(
    edge(graph, "citation", "W0", "WR")?.provenance,
    "openalex:referenced-works",
  );
  assert.equal(
    edge(graph, "citation", "WC", "W0")?.provenance,
    "openalex:citing-works",
  );
  assert.equal(
    edge(graph, "provider-related", "W0", "WP")?.provenance,
    "openalex:related-works",
  );
  assert.equal(edge(graph, "citation", "W0", "WC"), undefined);
  assert.equal(edge(graph, "citation", "W0", "WP"), undefined);
  assert.equal(graph.edges.length, 3);
  assert.ok(
    graph.edges.every(
      (value) => value.sharedCount === undefined && value.weight === 1,
    ),
  );
});

test("overlapping roles survive while first metadata, primary kind and node order stay stable", async () => {
  const original = work("W1", [], [], 10);
  const incoming = {
    ...paper("W1", 999),
    title: "Later metadata must not change ranking",
  };
  const f = fixture({
    origin: work("W0", ["W1", "W0"], ["W1", "W0"]),
    works: [original, work("W0")],
    citing: [incoming, incoming, paper("W0"), { identifiers: {} }],
  });
  const graph = await f.graph();
  const node = graph.nodes.find((value) => value.id === "W1");
  assert.deepEqual(plain(node.roles), ["reference", "citation", "related"]);
  assert.equal(node.kind, "reference");
  assert.equal(node.ref, original.ref);
  assert.equal(node.ref.citationCount, 10);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(plain(graph.nodes[0].roles), ["origin"]);
  assert.equal(graph.edges.length, 3);
  assert.ok(edge(graph, "citation", "W0", "W1"));
  assert.ok(edge(graph, "citation", "W1", "W0"));
  assert.ok(edge(graph, "provider-related", "W0", "W1"));
  assert.ok(graph.edges.every((value) => value.source !== value.target));
});

test("bibliographic coupling counts distinct shared cited works and is never labelled co-citation", async () => {
  const f = fixture({
    origin: work("W0", ["WA", "WB", "WD"]),
    works: [
      work("WA", ["X", "Y", "Z", "Z"]),
      work("WB", ["X", "Y", "Z", "Z"]),
      work("WD", ["X", "Y"]),
    ],
  });
  const graph = await f.graph();
  const coupling = graph.edges.filter(
    (value) => value.type === "bibliographic-coupling",
  );
  assert.equal(coupling.length, 1);
  assert.equal(coupling[0].source, "WA");
  assert.equal(coupling[0].target, "WB");
  assert.equal(coupling[0].sharedCount, 3);
  assert.equal(coupling[0].weight, 3);
  assert.equal(coupling[0].provenance, "openalex:referenced-works");
  assert.ok(
    graph.edges.every((value) => !["cocite", "direct"].includes(value.kind)),
  );
});

test("references retaining a citation role still participate in bibliographic coupling", async () => {
  const f = fixture({
    origin: work("W0", ["W1", "W2"]),
    works: [work("W1", ["X", "Y", "Z"]), work("W2", ["X", "Y", "Z"])],
    citing: [paper("W1")],
  });
  const graph = await f.graph();
  assert.ok(edge(graph, "bibliographic-coupling", "W1", "W2"));
  assert.ok(edge(graph, "citation", "W1", "W0"));
});

test("node budget and citation-count sampling preserve original ordering and keep only valid endpoints", async () => {
  const f = fixture({
    origin: work("W0", ["W1", "W2"], ["W4"]),
    works: [
      work("W1", [], [], 10),
      work("W2", [], [], 30),
      work("W4", [], [], 20),
    ],
    citing: [paper("W3", 30), paper("W1", 1000)],
  });
  const graph = await f.graph(3);
  assert.deepEqual(plain(graph.nodes.map((value) => value.id)), [
    "W0",
    "W2",
    "W3",
  ]);
  assert.equal(f.matches.length, 3);
  assert.ok(f.matches.every((value) => value.libraryID === 7));
  const kept = new Set(graph.nodes.map((value) => value.id));
  assert.ok(
    graph.edges.every(
      (value) => kept.has(value.source) && kept.has(value.target),
    ),
  );
  const originOnly = await f.graph(1);
  assert.equal(originOnly.nodes.length, 1);
  assert.equal(originOnly.edges.length, 0);
});

test("provider calls, cited page limit and related sample remain unchanged before node capping", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `W${i + 1}`);
  const f = fixture({
    origin: work("W0", ids, ids),
    works: ids.map((id) => work(id)),
  });
  await f.graph(2);
  assert.deepEqual(
    f.requests.map((value) => value.type),
    ["origin", "references", "citing", "related"],
  );
  assert.deepEqual(f.requests[1].ids, ids);
  assert.deepEqual(plain(f.requests[1].options), { lean: true });
  assert.equal(f.requests[1].full, true);
  assert.equal(f.requests[2].offset, 0);
  assert.equal(f.requests[2].limit, 15);
  assert.deepEqual(f.requests[3].ids, ids.slice(0, 10));
  assert.deepEqual(plain(f.requests[3].options), { lean: true });
  assert.equal(f.requests[3].full, false);
});

test("coupling keeps the existing minimum and 200-edge descending-weight cap", async () => {
  const ids = Array.from({ length: 22 }, (_, i) => `W${i + 1}`);
  const f = fixture({
    origin: work("W0", ids),
    works: ids.map((id, i) =>
      work(id, ["X", "Y", "Z", ...(i < 2 ? ["Q"] : [])]),
    ),
  });
  const graph = await f.graph(50);
  const coupling = graph.edges.filter(
    (value) => value.type === "bibliographic-coupling",
  );
  assert.equal(coupling.length, 200);
  assert.equal(coupling[0].sharedCount, 4);
  assert.ok(
    coupling.every(
      (value, i) =>
        value.weight >= 3 &&
        (i === 0 || coupling[i - 1].weight >= value.weight),
    ),
  );
});

test("graph assembly is read-only and isolated across builds including overlapping role arrays", async () => {
  const origin = work("W0", ["W1"], ["W1"]),
    works = [work("W1")],
    citing = [paper("W1")];
  const before = JSON.stringify({ origin, works, citing });
  const f = fixture({ origin, works, citing, match: () => ({ id: 1 }) });
  const first = await f.graph(),
    second = await f.graph();
  first.nodes[1].roles.push("origin");
  assert.deepEqual(plain(second.nodes[1].roles), [
    "reference",
    "citation",
    "related",
  ]);
  assert.equal(JSON.stringify({ origin, works, citing }), before);
  assert.ok(second.nodes.every((node) => node.inLibrary));
});

test("missing host identifiers or missing origin fail without extra provider requests", async () => {
  const f = fixture();
  assert.equal(await f.graph(50, {}), null);
  assert.equal(f.requests.length, 0);
  const missing = fixture({ origin: null });
  assert.equal(await missing.graph(), null);
  assert.deepEqual(
    missing.requests.map((value) => value.type),
    ["origin"],
  );
});

function graphDOM({ reduced = false } = {}) {
  const pending = new Map();
  let nextID = 0;
  let time = 0;
  const size = { width: 340, height: 400 };
  let resize;
  const win = {
    performance: { now: () => time++ },
    ResizeObserver: class {
      constructor(callback) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        resize = null;
      }
    },
    matchMedia: (query) => ({
      matches: reduced && query.includes("reduced-motion"),
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame: (fn) => {
      pending.set(++nextID, fn);
      return nextID;
    },
    cancelAnimationFrame: (id) => pending.delete(id),
  };
  let hitTarget = null,
    hitTests = 0;
  const doc = {
    defaultView: win,
    createElementNS: (_ns, tag) => node(tag),
    elementFromPoint: () => {
      hitTests++;
      return hitTarget;
    },
  };
  function node(tag) {
    return {
      tagName: tag,
      ownerDocument: doc,
      attributes: new Map(),
      children: [],
      style: {},
      listeners: new Map(),
      captures: new Set(),
      reads: 0,
      measurements: 0,
      hovered: false,
      matches(selector) {
        return selector === ":hover" && this.hovered;
      },
      getBBox() {
        this.measurements++;
        return { width: this.textContent.length * 6, height: 12, y: -9 };
      },
      writes: new Map(),
      setAttribute(name, value) {
        this.writes.set(name, (this.writes.get(name) || 0) + 1);
        this.attributes.set(name, String(value));
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
      get lastElementChild() {
        return this.children.at(-1);
      },
      appendChild(child) {
        child.remove?.();
        this.children.push(child);
        child.parent = this;
      },
      remove() {
        if (this.parent)
          this.parent.children = this.parent.children.filter(
            (child) => child !== this,
          );
      },
      set textContent(value) {
        this.text = value;
        this.children = [];
      },
      get textContent() {
        return this.text || "";
      },
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
      },
      setPointerCapture(id) {
        this.captures.add(id);
      },
      releasePointerCapture(id) {
        this.captures.delete(id);
      },
      dispatch(type, options = {}) {
        if (type === "pointerenter") this.hovered = true;
        if (type === "pointerleave") this.hovered = false;
        const event = {
          target: this,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX: 170,
          clientY: 200,
          deltaY: 0,
          deltaMode: 0,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {},
          ...options,
        };
        for (const listener of [...(this.listeners.get(type) || [])])
          listener(event);
        return event;
      },
      getBoundingClientRect() {
        this.reads++;
        return { ...size, left: 0, top: 0, x: 0, y: 0, bottom: size.height };
      },
    };
  }
  const frame = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback();
  };
  return {
    container: node("div"),
    pending,
    frame,
    hit: (target) => {
      hitTarget = target;
    },
    hitTests: () => hitTests,
    flush() {
      let count = 0;
      while (pending.size && count++ < 500) frame();
      assert.equal(pending.size, 0, "RAF work must eventually settle");
    },
    resize(width, height) {
      Object.assign(size, { width, height });
      resize?.();
    },
  };
}

test("view preserves directed edge metadata, marks only citations and never mutates shared roles", async () => {
  const f = fixture({
    origin: work("W0", ["WR"], ["WP"]),
    works: [work("WR"), work("WP")],
    citing: [paper("WC")],
  });
  const graph = await f.graph(),
    before = JSON.stringify(graph);
  const firstDOM = graphDOM(),
    secondDOM = graphDOM();
  const first = new f.GraphView(firstDOM.container),
    second = new f.GraphView(secondDOM.container);
  try {
    first.setData(graph);
    second.setData(graph);
    firstDOM.flush();
    secondDOM.flush();
    assert.notEqual(first.arrowID, second.arrowID);
    const arrows = first.edgeEls.filter(({ el }) =>
      el.getAttribute("marker-end"),
    );
    assert.equal(arrows.length, 2);
    assert.ok(arrows.every(({ edge }) => edge.type === "citation"));
    const provider = first.edgeEls.find(
      ({ edge }) => edge.type === "provider-related",
    );
    assert.equal(provider.el.getAttribute("stroke-dasharray"), "4 3");
    assert.equal(
      provider.el.getAttribute("data-provenance"),
      "openalex:related-works",
    );
    first.data.nodes[0].roles.push("related");
    assert.deepEqual(plain(second.data.nodes[0].roles), ["origin"]);
    assert.equal(JSON.stringify(graph), before);
    const incoming = first.edgeEls.find(({ edge }) => edge.source.id === "WC");
    assert.equal(incoming.edge.target.id, "W0");
    assert.ok(
      Math.hypot(
        Number(incoming.el.getAttribute("x2")) - incoming.edge.target.x,
        Number(incoming.el.getAttribute("y2")) - incoming.edge.target.y,
      ) > 0,
      "arrow endpoint must stop at the node rim rather than its center",
    );
  } finally {
    first.destroy();
    second.destroy();
  }
  assert.equal(firstDOM.pending.size, 0);
  assert.equal(secondDOM.pending.size, 0);
});

async function graphViewFixture(options = {}, handlers = {}) {
  const f = fixture({
    origin: work("W0", ["WR"], ["WP"]),
    works: [work("WR"), work("WP")],
    citing: [paper("WC")],
  });
  const graph = await f.graph();
  const dom = graphDOM(options);
  const view = new f.GraphView(dom.container, handlers);
  view.setData(graph);
  return { view, dom, graph };
}

function instrument(view, method) {
  const original = view[method].bind(view);
  let calls = 0;
  view[method] = (...args) => {
    calls++;
    return original(...args);
  };
  return () => calls;
}

function assertReleased(view, target) {
  assert.equal(view.gesture, null);
  assert.equal(target.captures.size, 0);
  for (const event of [
    "pointermove",
    "pointerup",
    "pointercancel",
    "lostpointercapture",
  ])
    assert.equal(target.listeners.get(event)?.size || 0, 0, event);
  assert.equal(view.svg.style.cursor, "grab");
}

test("startup warm-up yields within its time budget and reveals only settled positions", async () => {
  const { view, dom } = await graphViewFixture();
  try {
    const ticks = instrument(view.sim, "tick");
    assert.equal(view.root.style.visibility, "hidden");
    assert.equal(ticks(), 0);
    dom.frame();
    assert.ok(
      ticks() > 0 && ticks() <= 4,
      "one frame must yield at the 4 ms budget",
    );
    assert.equal(view.root.style.visibility, "hidden");
    assert.equal(view.nodeEls.get("WR").getAttribute("cx"), null);
    dom.flush();
    assert.equal(view.root.style.visibility, "visible");
    assert.ok(
      Number.isFinite(Number(view.nodeEls.get("WR").getAttribute("cx"))),
    );
    assert.ok(ticks() >= 110);
    assert.equal(view.edgeLayer.style.pointerEvents, "none");
  } finally {
    view.destroy();
  }
});

test("empty graphs finish immediately without simulation or animation work", async () => {
  const { view, dom } = await graphViewFixture();
  try {
    view.setData({ originId: "", nodes: [], edges: [] });
    assert.equal(view.sim, null);
    assert.equal(view.root.style.visibility, "visible");
    assert.equal(view.nodeEls.size, 0);
    assert.equal(dom.pending.size, 0);
  } finally {
    view.destroy();
  }
});

test("wheel is proportional, mode-normalized, cursor-anchored and commits once per frame", async () => {
  const { view, dom } = await graphViewFixture();
  try {
    dom.flush();
    const transforms = instrument(view, "applyTransform");
    const reads = view.svg.reads;
    const wheel = (deltaY, extra = {}) =>
      view.svg.dispatch("wheel", {
        ctrlKey: true,
        deltaY,
        clientX: 250,
        clientY: 270,
        ...extra,
      });
    for (const delta of [0, NaN, Infinity, -Infinity]) wheel(delta);
    assert.equal(view.scale, 1);
    assert.equal(dom.pending.size, 0);
    assert.equal(wheel(10, { ctrlKey: false }).defaultPrevented, undefined);
    assert.equal(view.scale, 1);
    const before = view.toLocal(250, 270);
    for (let i = 0; i < 100; i++) wheel(-0.1);
    assert.ok(Math.abs(view.scale - Math.exp(0.02)) < 1e-12);
    assert.equal(transforms(), 0);
    assert.equal(view.svg.reads - reads, 1);
    assert.equal(dom.pending.size, 1);
    const after = view.toLocal(250, 270);
    assert.ok(
      Math.abs(before.x - after.x) < 1e-10 &&
        Math.abs(before.y - after.y) < 1e-10,
    );
    dom.frame();
    assert.equal(transforms(), 1);
    const scale = view.scale;
    wheel(1, { deltaMode: 1 });
    assert.ok(Math.abs(view.scale / scale - Math.exp(-16 * 0.002)) < 1e-12);
    dom.frame();
    const lineScale = view.scale;
    wheel(0.1, { deltaMode: 2 });
    assert.ok(Math.abs(view.scale / lineScale - Math.exp(-40 * 0.002)) < 1e-12);
    dom.flush();
  } finally {
    view.destroy();
  }
});

test("node dragging coalesces samples, applies release coordinates and suppresses accidental activation", async () => {
  let selected = 0,
    opened = 0;
  const { view, dom } = await graphViewFixture(
    {},
    { onSelect: () => selected++, onOpen: () => opened++ },
  );
  try {
    dom.flush();
    const circle = view.nodeEls.get("WR"),
      node = view.data.nodes.find((n) => n.id === "WR");
    const positions = instrument(view, "updatePositions"),
      ticks = instrument(view.sim, "tick");
    const reads = view.svg.reads;
    circle.dispatch("pointerdown");
    for (let i = 0; i < 100; i++)
      circle.dispatch("pointermove", { clientX: 180 + i / 10, clientY: 210 });
    assert.equal(positions(), 0);
    assert.equal(ticks(), 0);
    assert.equal(view.svg.reads, reads);
    circle.dispatch("pointerup", { clientX: 215, clientY: 230 });
    circle.dispatch("click");
    circle.dispatch("dblclick");
    assert.equal(selected + opened, 0);
    dom.frame();
    assert.equal(positions(), 1);
    assert.equal(view.svg.reads - reads, 1);
    assert.ok(
      Math.abs(node.x - 45) < 5 && Math.abs(node.y - 30) < 5,
      "release must include final unpainted sample",
    );
    assert.equal(node.fx, null);
    assert.equal(view.sim.alphaTarget(), 0);
    assertReleased(view, circle);
    dom.flush();
    circle.dispatch("pointerdown");
    circle.dispatch("pointerup");
    circle.dispatch("click");
    assert.equal(selected, 1);
    dom.flush();
  } finally {
    view.destroy();
  }
});

test("reduced-motion dragging never batch-ticks or passively settles after release", async () => {
  const { view, dom } = await graphViewFixture({ reduced: true });
  try {
    dom.flush();
    const circle = view.nodeEls.get("WR"),
      node = view.data.nodes.find((n) => n.id === "WR");
    const ticks = instrument(view.sim, "tick");
    circle.dispatch("pointerdown");
    for (let i = 0; i < 80; i++)
      circle.dispatch("pointermove", { clientX: 200 + i / 10 });
    assert.equal(ticks(), 0);
    dom.frame();
    assert.ok(Math.abs(node.x - 37.9) < 1e-10);
    circle.dispatch("pointerup", { clientX: 220, clientY: 230 });
    dom.frame();
    assert.equal(node.x, 50);
    assert.ok(Math.abs(node.y - 30) < 1e-10);
    assert.equal(node.fx, null);
    assert.equal(ticks(), 0);
    assert.equal(dom.pending.size, 0);
    assertReleased(view, circle);
  } finally {
    view.destroy();
  }
});

test("gesture identity, cancellation, replacement and destruction clean up capture and pending work", async () => {
  const { view, dom, graph } = await graphViewFixture();
  try {
    dom.flush();
    let circle = view.nodeEls.get("WR");
    for (const extra of [{ button: 2 }, { isPrimary: false }]) {
      circle.dispatch("pointerdown", extra);
      view.svg.dispatch("pointerdown", extra);
      assert.equal(view.gesture, null);
    }
    circle.dispatch("pointerdown");
    circle.dispatch("pointermove", { pointerId: 2, clientX: 240 });
    circle.dispatch("pointerup", { pointerId: 2 });
    assert.equal(view.gesture.dragging, false);
    circle.dispatch("pointermove", { clientX: 240 });
    dom.frame();
    circle.dispatch("lostpointercapture");
    assertReleased(view, circle);
    assert.equal(view.data.nodes.find((n) => n.id === "WR").fx, null);
    circle.dispatch("pointerdown");
    circle.dispatch("pointermove", { clientX: 260 });
    const oldNode = view.data.nodes.find((n) => n.id === "WR");
    view.setData(graph);
    assertReleased(view, circle);
    assert.equal(oldNode.fx, null);
    dom.flush();
    circle = view.nodeEls.get("WR");
    circle.dispatch("pointerdown");
    circle.dispatch("pointermove", { clientX: 280 });
    view.destroy();
    assertReleased(view, circle);
    assert.equal(dom.pending.size, 0);
    dom.frame();
  } finally {
    view.destroy();
  }
});

test("same-frame release accepts the next gesture or zoom without losing its final sample", async () => {
  let selected = 0;
  const { view, dom } = await graphViewFixture(
    { reduced: true },
    { onSelect: () => selected++ },
  );
  try {
    dom.flush();
    const circle = view.nodeEls.get("WR"),
      node = view.data.nodes.find((n) => n.id === "WR");
    circle.dispatch("pointerdown");
    circle.dispatch("pointermove", { clientX: 200 });
    circle.dispatch("pointerup", { clientX: 220 });
    circle.dispatch("click");
    assert.equal(selected, 0);
    circle.dispatch("pointerdown", { pointerId: 2 });
    assert.equal(node.x, 50, "new press must first apply the prior release");
    assert.equal(view.gesture.pointerId, 2);
    assert.equal(view.gesture.ending, undefined);
    circle.dispatch("pointerup", { pointerId: 2 });
    circle.dispatch("click");
    assert.equal(selected, 1, "new click must not inherit drag suppression");
    circle.dispatch("pointerdown", { pointerId: 3 });
    circle.dispatch("pointermove", { pointerId: 3, clientX: 240 });
    circle.dispatch("pointerup", { pointerId: 3, clientX: 250 });
    view.svg.dispatch("wheel", { ctrlKey: true, deltaY: -1 });
    assert.ok(
      Math.abs(node.x - 80) < 1e-10,
      "zoom must first apply the pending release",
    );
    assertReleased(view, circle);
    dom.flush();
    assert.ok(Math.abs(node.x - 80) < 1e-10);
    assert.equal(dom.pending.size, 0);
  } finally {
    view.destroy();
  }
});

test("click, double-click, keyboard and context actions survive gesture cleanup", async () => {
  let selected = 0,
    opened = 0,
    context = 0;
  const { view, dom } = await graphViewFixture(
    {},
    {
      onSelect: () => selected++,
      onOpen: () => opened++,
      onContext: () => context++,
    },
  );
  try {
    dom.flush();
    const circle = view.nodeEls.get("WR");
    circle.dispatch("pointerdown");
    circle.dispatch("pointerup");
    // Native implicit capture release occurs before the animation callback.
    circle.dispatch("lostpointercapture");
    circle.dispatch("click");
    circle.dispatch("dblclick");
    assert.equal(selected, 1);
    assert.equal(opened, 1);
    dom.flush();
    assertReleased(view, circle);
    circle.dispatch("pointerdown", { button: 2 });
    circle.dispatch("contextmenu");
    assert.equal(context, 1);
    circle.dispatch("pointerdown");
    circle.dispatch("pointercancel");
    circle.dispatch("click");
    circle.dispatch("dblclick");
    assert.equal(selected, 1);
    assert.equal(opened, 1);
    assertReleased(view, circle);
    circle.dispatch("keydown", { key: "Enter" });
    circle.dispatch("keydown", { key: "Enter", ctrlKey: true });
    circle.dispatch("keydown", { key: "ContextMenu" });
    assert.equal(selected, 2);
    assert.equal(opened, 2);
    assert.equal(context, 2);
  } finally {
    view.destroy();
  }
});

test("release restores hovered-node details once, but cancellation and superseding input do not", async () => {
  const hovers = [];
  const { view, dom, graph } = await graphViewFixture(
    { reduced: true },
    { onHover: (node) => hovers.push(node?.id || null) },
  );
  try {
    dom.flush();
    const circle = view.nodeEls.get("WR");
    dom.hit(circle);
    circle.dispatch("pointerenter");
    circle.dispatch("pointerdown");
    circle.dispatch("pointermove", { clientX: 200 });
    circle.dispatch("pointerup", { clientX: 210 });
    assert.deepEqual(hovers, ["WR", null]);
    dom.frame();
    assert.deepEqual(hovers, ["WR", null, "WR"]);
    assert.equal(dom.hitTests(), 1);
    for (let i = 0; i < 5; i++) dom.frame();
    assert.equal(dom.hitTests(), 1, "idle/simulation frames must not hit-test");
    circle.dispatch("pointerdown");
    circle.dispatch("pointercancel");
    dom.flush();
    assert.equal(hovers.at(-1), null);
    assert.equal(dom.hitTests(), 1);
    circle.dispatch("pointerdown");
    circle.dispatch("pointerup");
    circle.dispatch("pointerdown", { pointerId: 2 });
    dom.frame();
    assert.equal(
      dom.hitTests(),
      1,
      "a continuing gesture must not reopen details",
    );
    circle.dispatch("pointerup", { pointerId: 2 });
    view.svg.dispatch("wheel", { ctrlKey: true, deltaY: 2 });
    dom.flush();
    assert.equal(dom.hitTests(), 1, "zoom must not reopen details");
    circle.dispatch("pointerdown");
    circle.dispatch("pointerup");
    dom.hit(null);
    dom.flush();
    assert.equal(dom.hitTests(), 2);
    assert.equal(
      hovers.at(-1),
      null,
      "release away from node must not open details",
    );
    circle.dispatch("pointerdown");
    circle.dispatch("pointerup");
    view.setData(graph);
    dom.flush();
    assert.equal(dom.hitTests(), 2, "rebuild must not reopen old details");
    const replacement = view.nodeEls.get("WR");
    replacement.dispatch("pointerdown");
    replacement.dispatch("pointerup");
    view.destroy();
    dom.frame();
    assert.equal(
      dom.hitTests(),
      2,
      "destroy must cancel pending hover restoration",
    );
  } finally {
    view.destroy();
  }
});

test("pointer leaving after release cannot reopen a card from stale release coordinates", async () => {
  const hovers = [];
  const { view, dom } = await graphViewFixture(
    { reduced: true },
    { onHover: (node) => hovers.push(node?.id || null) },
  );
  try {
    dom.flush();
    const circle = view.nodeEls.get("WR");
    dom.hit(circle);
    circle.dispatch("pointerenter");
    circle.dispatch("pointerdown");
    circle.dispatch("pointermove", { clientX: 200 });
    circle.dispatch("pointerup", { clientX: 210 });
    circle.dispatch("pointerleave", { clientX: 300, clientY: 300 });
    dom.frame();
    assert.deepEqual(hovers, ["WR", null]);
    assert.equal(
      dom.hitTests(),
      1,
      "old coordinates alone cannot prove current hover",
    );
    assert.equal(view.hoveredCircle, null);
  } finally {
    view.destroy();
  }
});

test("label geometry is measured once and captions stay inside resized canvas edges", async () => {
  const { view, dom } = await graphViewFixture();
  try {
    dom.flush();
    const labels = [...view.labelEls.values()];
    assert.ok(labels.every((label) => label.measurements === 1));
    const node = view.data.nodes.find((n) => n.id === "WR");
    const label = view.labelEls.get("WR");
    node.x = node.fx = 160;
    node.y = node.fy = 190;
    view.updatePositions();
    assert.ok(
      Number(label.getAttribute("y")) < node.y,
      "bottom labels should move above their node",
    );
    for (const [width, height] of [
      [320, 400],
      [90, 100],
      [40, 100],
      [680, 600],
    ]) {
      dom.resize(width, height);
      dom.frame();
      for (const [id, caption] of view.labelEls) {
        const m = view.labelMetrics.get(id);
        const x = Number(caption.getAttribute("x"));
        const y = Number(caption.getAttribute("y"));
        if (m.width > width - 8) {
          assert.equal(caption.style.visibility, "hidden");
          assert.equal(
            x,
            0,
            "oversized captions must not reverse their bounds",
          );
          continue;
        }
        assert.equal(caption.style.visibility, "visible");
        assert.ok(x - m.width / 2 >= -width / 2 + 4);
        assert.ok(x + m.width / 2 <= width / 2 - 4);
        assert.ok(y - m.ascent >= -height / 2 + 4);
        assert.ok(y + m.descent <= height / 2 - 4);
      }
    }
    assert.ok(
      labels.every((label) => label.measurements === 1),
      "resizing must reuse text geometry",
    );
  } finally {
    view.destroy();
  }
});

test("pan, resize and hover avoid redundant layout work and leave a valid smaller canvas", async () => {
  const hovers = [];
  const { view, dom } = await graphViewFixture(
    {},
    { onHover: (node) => hovers.push(node?.id || null) },
  );
  try {
    dom.flush();
    const transforms = instrument(view, "applyTransform"),
      positions = instrument(view, "updatePositions");
    const circle = view.nodeEls.get("WR");
    circle.dispatch("pointerenter");
    assert.equal(hovers.at(-1), "WR");
    view.svg.dispatch("wheel", { ctrlKey: true, deltaY: 1 });
    assert.equal(hovers.at(-1), null);
    circle.dispatch("pointerenter");
    assert.equal(hovers.at(-1), null);
    dom.flush();
    view.svg.dispatch("pointerdown");
    for (let i = 0; i < 20; i++)
      view.svg.dispatch("pointermove", { clientX: 200 + i });
    view.svg.dispatch("pointerup", { clientX: 230 });
    const before = transforms();
    dom.frame();
    assert.equal(view.panX, 60);
    assert.equal(transforms() - before, 1);
    assertReleased(view, view.svg);
    const commits = transforms() + positions();
    dom.resize(340, 400);
    assert.equal(dom.pending.size, 0);
    assert.equal(transforms() + positions(), commits);
    dom.resize(90, 100);
    dom.frame();
    assert.ok(
      view.data.nodes.every((n) => Math.abs(n.x) <= 45 && Math.abs(n.y) <= 50),
    );
    assert.equal(positions(), 1);
  } finally {
    view.destroy();
  }
});

let failures = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`, error);
  }
}
console.log(
  `${tests.length - failures}/${tests.length} graph regressions passed`,
);
if (failures) process.exitCode = 1;
