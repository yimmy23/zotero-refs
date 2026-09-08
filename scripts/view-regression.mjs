/** Real view methods with minimal DOM mechanics; no application or network. */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { build } from "esbuild";
import { setTimeout, clearTimeout } from "node:timers";
import { DOMImplementation } from "@xmldom/xmldom";
Error.stackTraceLimit = 0;

const bundle = await build({
  stdin: {
    contents:
      'export {GraphView} from "./src/graph/view"; export {PopupCard} from "./src/ui/popup"; export {clearPopupTranslations} from "./src/core/popupTranslation";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  define: { __env__: '"production"' },
});
const { GraphView, PopupCard, clearPopupTranslations } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const fakeGraph = () => ({
  clearScene() {},
  root: { style: {} },
  scheduleFrame() {},
  createSVG() {
    return { setAttribute() {}, style: {} };
  },
  edgeLayer: { appendChild() {} },
  edgeEls: [],
  attachNodeEvents() {},
  nodeLayer: { appendChild() {} },
  nodeEls: new Map(),
  labelLayer: { appendChild() {} },
  labelEls: new Map(),
  width: 400,
  applyTheme() {},
  clampToCanvas() {},
  updatePositions() {},
  runTicks() {},
});
const data = {
  originId: "W1",
  nodes: ["W1", "W2"].map((id, i) => ({
    id,
    kind: i ? "reference" : "origin",
    inLibrary: false,
    ref: { identifiers: {}, authors: [], title: id },
  })),
  edges: [{ source: "W1", target: "W2", kind: "direct", weight: 1 }],
};
const snapshot = JSON.stringify(data),
  a = fakeGraph(),
  b = fakeGraph();
GraphView.prototype.setData.call(a, data);
GraphView.prototype.setData.call(b, data);
b.sim.nodes()[1].fx = 777;
assert.equal(
  JSON.stringify(data),
  snapshot,
  "rendering must not mutate cached graph data",
);
assert.notEqual(a.sim.nodes()[1], b.sim.nodes()[1]);
assert.notEqual(
  a.sim.nodes()[1].fx,
  777,
  "dragging one graph must not move another window's graph",
);
const reused = fakeGraph();
GraphView.prototype.setData.call(reused, a.data);
assert.notEqual(
  reused.data.edges[0].source,
  a.data.edges[0].source,
  "resolved edge endpoints belong to their own view",
);
for (const view of [a, b, reused]) view.sim.stop();
console.log("PASS graph simulations keep cache and other windows isolated");

let width = 1600,
  height = 1000;
const listeners = new Map();
const win = {
  setTimeout,
  clearTimeout,
  addEventListener: (name, fn) => listeners.set(name, fn),
  removeEventListener: (name, fn) => {
    if (listeners.get(name) === fn) listeners.delete(name);
  },
  matchMedia: () => ({ matches: false }),
};
const doc = {
  defaultView: win,
  documentElement: {
    getBoundingClientRect: () => ({ width, height }),
    appendChild: (node) => {
      node.isConnected = true;
    },
  },
};
win.document = doc;
const Zotero = (globalThis.Zotero = {
  getMainWindow: () => win,
  Prefs: {
    get: (key) => (key.endsWith("ctrlClickTranslate") ? true : undefined),
  },
});
globalThis.Components = { utils: { isDeadWrapper: () => false } };
globalThis.addon = {
  data: {
    locale: { current: { formatMessagesSync: ([{ id }]) => [{ value: id }] } },
  },
};
globalThis.ztoolkit = {
  UI: {
    createElement: (ownerDocument) => ({
      ownerDocument,
      style: {},
      isConnected: false,
      remove() {
        this.isConnected = false;
      },
      getBoundingClientRect() {
        return {
          width: Math.min(parseFloat(this.style.width) || 520, width - 24),
          height: Math.min(720, height - 24),
        };
      },
    }),
  },
};
const card = new PopupCard();
card.onInit({ x: 1450, y: 850, width: 100, height: 20 }, "left");
card.place();
assert.ok(listeners.has("resize"));
width = 800;
height = 500;
listeners.get("resize")();
const rect = card.container.getBoundingClientRect();
assert.ok(parseFloat(card.container.style.left) + rect.width <= width - 12);
assert.ok(parseFloat(card.container.style.top) + rect.height <= height - 12);
card.clear();
assert.equal(
  listeners.has("resize"),
  false,
  "clearing a popup releases its window listener",
);
console.log(
  "PASS popup follows resized owner viewport and releases resize listener",
);

// Real text-only DOM construction. Supply only the modern DOM conveniences
// absent from the XML DOM; the production renderer and translation methods run.
const abstractDoc = new DOMImplementation().createDocument(null, "root", null);
const createElement = abstractDoc.createElementNS.bind(abstractDoc);
abstractDoc.createElementNS = (namespace, name) => {
  const element = createElement(namespace, name);
  element.append = (...children) =>
    children.forEach((child) => element.appendChild(child));
  return element;
};
const body = abstractDoc.createElementNS("http://www.w3.org/1999/xhtml", "div");
body.dataset = { contentKind: "abstract" };
body.closest = () => null;
body.replaceChildren = function (...children) {
  while (this.firstChild) this.removeChild(this.firstChild);
  children.forEach((child) => this.appendChild(child));
};
abstractDoc.documentElement.appendChild(body);
Object.defineProperty(body, "classList", {
  value: { contains: (name) => name === "abstract" },
});
const abstractCard = new PopupCard();
const source =
  "Background: Need. Methods: Trial. Results: P<0.001; literal <script> stays text. Conclusions: Follow-up.";
body.dataset.sourceText = source;
abstractCard.renderText(body, source);
assert.equal(body.getElementsByTagName("p").length, 4);
assert.deepEqual(
  [...body.getElementsByTagName("strong")].map((n) => n.textContent),
  ["Background", "Methods", "Results", "Conclusions"],
);
assert.equal(body.getElementsByTagName("script").length, 0);
assert.equal(
  body.getElementsByTagName("span")[2].textContent,
  "P<0.001; literal <script> stays text.",
);
const copied = abstractCard.readableText(body);
assert.equal(
  copied,
  "Background:\nNeed.\n\nMethods:\nTrial.\n\nResults:\nP<0.001; literal <script> stays text.\n\nConclusions:\nFollow-up.",
);
console.log(
  "PASS abstract DOM and copy preserve four labelled sections and literal comparisons",
);

let translateCalls = 0;
Zotero.PDFTranslate = {
  api: {
    translate: async (text) => {
      translateCalls++;
      assert.equal(text, copied);
      return "背景：需要。方法：试验。结果：P<0.001。结论：随访。";
    },
  },
};
await abstractCard.toggleTranslation(body);
assert.equal(body.dataset.showTranslation, "true");
assert.equal(body.getElementsByTagName("p").length, 4);
assert.deepEqual(
  [...body.getElementsByTagName("strong")].map((n) => n.textContent),
  ["背景", "方法", "结果", "结论"],
);
await abstractCard.toggleTranslation(body);
assert.equal(body.dataset.showTranslation, "false");
assert.equal(abstractCard.readableText(body), copied);
assert.equal(translateCalls, 1);
console.log(
  "PASS translation receives paragraph breaks and toggles back with structure intact",
);

clearPopupTranslations();
delete body.dataset.translatedText;
let resolveTranslation;
let pendingCalls = 0;
Zotero.PDFTranslate.api.translate = () => {
  pendingCalls++;
  return new Promise((resolve) => {
    resolveTranslation = resolve;
  });
};
const pending = abstractCard.toggleTranslation(body);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(body.dataset.translating, "true");
const replacement = abstractDoc.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
);
replacement.dataset = { ...body.dataset };
replacement.closest = body.closest;
replacement.replaceChildren = body.replaceChildren;
abstractDoc.documentElement.replaceChild(replacement, body);
abstractCard.container = { querySelector: () => replacement };
abstractCard.renderText(replacement, source);
abstractCard.restoreTranslation(replacement);
await abstractCard.toggleTranslation(replacement);
assert.equal(
  pendingCalls,
  1,
  "a refreshed node must not send the same pending translation again",
);
resolveTranslation("背景：需要。方法：试验。结果：完整。结论：随访。");
await pending;
assert.equal(replacement.dataset.translating, "false");
assert.equal(replacement.dataset.showTranslation, "true");
assert.equal(replacement.getElementsByTagName("p").length, 4);
console.log(
  "PASS pending translation follows a metadata refresh of the same abstract without a duplicate request",
);

clearPopupTranslations();
replacement.dataset.showTranslation = "false";
delete replacement.dataset.translatedText;
abstractCard.renderText(replacement, source);
Object.defineProperty(replacement, "classList", {
  value: { contains: (name) => name === "abstract" },
});
const stale = abstractCard.toggleTranslation(replacement);
await new Promise((resolve) => setTimeout(resolve, 5));
const changed = abstractDoc.createElementNS(
  "http://www.w3.org/1999/xhtml",
  "div",
);
changed.dataset = {
  contentKind: "abstract",
  sourceText: "Different source abstract.",
};
changed.closest = body.closest;
changed.replaceChildren = body.replaceChildren;
abstractDoc.documentElement.replaceChild(changed, replacement);
abstractCard.container.querySelector = () => changed;
abstractCard.renderText(changed, changed.dataset.sourceText);
resolveTranslation("Old translation must not replace a different abstract.");
await stale;
assert.equal(changed.textContent, "Different source abstract.");
assert.equal(changed.dataset.translatedText, undefined);
console.log(
  "PASS an old pending translation cannot overwrite changed abstract text",
);

body.dataset.contentKind = "citation";
const citation = "Methods: Author. Results: Title. Synthetic Journal 2024;1:2.";
abstractCard.renderText(body, citation);
assert.equal(body.getElementsByTagName("p").length, 0);
assert.equal(body.textContent, citation);
assert.equal(abstractCard.readableText(body), citation);
console.log(
  "PASS citation fallback keeps original text without abstract section formatting",
);
// A new card/DOM restores the user's translated view without a second click.
clearPopupTranslations();
let revisitCalls = 0;
Zotero.PDFTranslate.api.translate = async () => {
  revisitCalls++;
  return "背景：缓存。方法：复用。结果：立即显示。结论：保留。";
};
const makeBody = () => {
  const node = abstractDoc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div",
  );
  node.dataset = { contentKind: "abstract", sourceText: source };
  node.closest = body.closest;
  node.replaceChildren = body.replaceChildren;
  abstractDoc.documentElement.appendChild(node);
  return node;
};
const firstBody = makeBody();
const firstCard = new PopupCard();
firstCard.renderText(firstBody, source);
await firstCard.toggleTranslation(firstBody);
abstractDoc.documentElement.removeChild(firstBody);
const secondBody = makeBody();
const secondCard = new PopupCard();
secondCard.renderText(secondBody, source);
secondCard.restoreTranslation(secondBody);
assert.equal(secondBody.dataset.showTranslation, "true");
assert.ok(secondBody.textContent.includes("立即显示"));
assert.equal(revisitCalls, 1);
await secondCard.toggleTranslation(secondBody);
const thirdBody = makeBody();
const thirdCard = new PopupCard();
thirdCard.renderText(thirdBody, source);
thirdCard.restoreTranslation(thirdBody);
assert.equal(thirdBody.dataset.showTranslation, "false");
assert.equal(thirdCard.readableText(thirdBody), copied);
assert.equal(revisitCalls, 1);
console.log(
  "PASS new cards restore the explicitly chosen translation/original view without requests",
);
clearPopupTranslations();
let finishRemoved;
Zotero.PDFTranslate.api.translate = () =>
  new Promise((resolve) => {
    finishRemoved = resolve;
  });
const removedBody = makeBody();
const removedCard = new PopupCard();
removedCard.renderText(removedBody, source);
const removedTask = removedCard.toggleTranslation(removedBody);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(removedBody.dataset.translating, "true");
Zotero.PDFTranslate = undefined;
finishRemoved("Stale provider text.");
await removedTask;
assert.equal(removedBody.dataset.translating, "false");
assert.equal(removedBody.dataset.showTranslation, "false");
assert.equal(removedBody.dataset.displayText, source);
console.log(
  "PASS removing the translation provider clears busy state and preserves original content",
);
clearPopupTranslations();
console.log("9 view regressions passed");
