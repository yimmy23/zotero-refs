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

function graphDOM() {
  const pending = new Map();
  let nextID = 0;
  const win = {
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame: (fn) => {
      pending.set(++nextID, fn);
      return nextID;
    },
    cancelAnimationFrame: (id) => pending.delete(id),
  };
  const doc = { defaultView: win, createElementNS: (_ns, tag) => node(tag) };
  function node(tag) {
    return {
      tagName: tag,
      ownerDocument: doc,
      attributes: new Map(),
      children: [],
      style: {},
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      appendChild(child) {
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
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({
        width: 340,
        height: 400,
        left: 0,
        top: 0,
      }),
    };
  }
  return { container: node("div"), pending };
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
