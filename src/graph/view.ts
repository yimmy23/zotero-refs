import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import type { Simulation } from "d3-force";
import type { GraphData, GraphEdge, GraphNode } from "../core/types";

/**
 * SVG renderer for the citation graph. Pure rendering: takes GraphData,
 * lays it out with d3-force, and reports interactions through handlers.
 * No network access, no imports from ui/ or hooks.
 */

export interface GraphHandlers {
  /** single click on a node */
  onSelect?: (node: GraphNode) => void;
  /** double click on a node */
  onOpen?: (node: GraphNode) => void;
  /** right click on a node (screen coords for a context menu) */
  onContext?: (node: GraphNode, screenX: number, screenY: number) => void;
  /** hover enter (with the circle's screen rect) / leave (null) */
  onHover?: (
    node: GraphNode | null,
    rect?: { x: number; y: number; width: number; height: number },
  ) => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
let nextArrowID = 0;

const KIND_COLOR: Record<GraphNode["kind"], string> = {
  // origin carries the plugin accent (Zest green); the other kinds stay
  // on distinguishable hues away from it
  origin: "#2da44e",
  reference: "#4a90d9",
  citation: "#e8710a",
  related: "#9b7fd4",
};

/**
 * Layout budget. The first WARMUP_TICKS run synchronously before the first
 * paint (a few ms for 50 nodes) so nodes start near their final positions;
 * only the tail is animated. Animating from a random cloud meant ~1s of
 * heavy motion competing with the other sections' rendering — visibly
 * janky. Now the visible motion is a short settle.
 */
const WARMUP_TICKS = 110;
const SETTLE_TICKS = 50;
/** simulation steps per animation frame */
const TICKS_PER_FRAME = 2;
/** stop animating once the largest per-tick displacement drops below this */
const MOTION_EPS = 0.08;
/** label budget scales with canvas width (origin always labeled) */
const LABEL_MIN = 4;
const LABEL_MAX = 12;
const PX_PER_LABEL = 45;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
/** pointer movement (px) below which a press counts as a click */
const CLICK_SLOP = 3;

function nodeRadius(n: GraphNode): number {
  // log10 with a hard cap: heavily-cited classics must not dwarf the canvas
  const r = 4.5 + 2.2 * Math.log10(1 + (n.ref.citationCount || 0));
  const clamped = Math.min(r, 13);
  return n.kind === "origin" ? clamped + 4 : clamped;
}

/** "Surname Year" label, falling back to a title stub. */
function nodeLabel(n: GraphNode): string {
  const author = (n.ref.authors?.[0] || "").trim();
  const surname = author.split(/\s+/).pop() || "";
  const label = [surname, n.ref.year || ""].filter(Boolean).join(" ");
  return label || (n.ref.title || "").slice(0, 18);
}

/**
 * Every live view, so plugin shutdown / window unload can tear down the
 * ResizeObserver + matchMedia listeners that would otherwise keep closed
 * windows' DOM alive. (The per-body WeakMap in graphSection cannot be
 * iterated.)
 */
const liveViews = new Set<GraphView>();

export function destroyAllGraphViews(owner?: Window): void {
  for (const view of [...liveViews]) {
    if (owner && !view.belongsToWindow(owner)) continue;
    try {
      view.destroy();
    } catch {
      // already-dead window — nothing to release
    }
  }
  if (!owner) liveViews.clear();
}

export class GraphView {
  private container: HTMLElement;
  private handlers: GraphHandlers;
  private doc: Document;
  private win: Window;

  private svg: SVGSVGElement;
  private arrowID = `refs-citation-arrow-${++nextArrowID}`;
  private arrowPath: SVGPathElement;
  /** pan/zoom transform root; children: edge, node, label layers */
  private root: SVGGElement;
  private edgeLayer: SVGGElement;
  private nodeLayer: SVGGElement;
  private labelLayer: SVGGElement;

  private data: GraphData | null = null;
  private sim: Simulation<GraphNode, GraphEdge> | null = null;
  private nodeEls = new Map<string, SVGCircleElement>();
  private labelEls = new Map<string, SVGTextElement>();
  private edgeEls: Array<{ el: SVGLineElement; edge: GraphEdge }> = [];

  private width = 300;
  private height = 300;
  private panX = 0;
  private panY = 0;
  private scale = 1;

  private rafId = 0;
  private tickBudget = 0;

  private resizeObs: ResizeObserver | null = null;
  private darkQuery: MediaQueryList | null = null;
  private onThemeChange = () => this.applyTheme();
  /** ids of nodes that carry a caption (collision radius is larger) */
  private labeledIds = new Set<string>();

  constructor(container: HTMLElement, handlers: GraphHandlers = {}) {
    liveViews.add(this);
    this.container = container;
    this.handlers = handlers;
    this.doc = container.ownerDocument as Document;
    this.win = this.doc.defaultView as Window;

    this.svg = this.createSVG<SVGSVGElement>("svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.style.display = "block";
    this.svg.style.cursor = "grab";
    const defs = this.createSVG<SVGDefsElement>("defs");
    const marker = this.createSVG<SVGMarkerElement>("marker");
    marker.setAttribute("id", this.arrowID);
    marker.setAttribute("viewBox", "0 0 6 6");
    marker.setAttribute("refX", "6");
    marker.setAttribute("refY", "3");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto");
    this.arrowPath = this.createSVG<SVGPathElement>("path");
    this.arrowPath.setAttribute("d", "M0,0 L6,3 L0,6 Z");
    marker.appendChild(this.arrowPath);
    defs.appendChild(marker);
    this.svg.appendChild(defs);
    this.root = this.createG(this.svg);
    this.edgeLayer = this.createG(this.root);
    this.nodeLayer = this.createG(this.root);
    this.labelLayer = this.createG(this.root);
    container.appendChild(this.svg);

    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.width = rect.width;
      this.height = rect.height;
    }
    this.updateViewBox();
    this.applyTransform();

    // keep the viewBox matching the container size
    const RO = (this.win as any)?.ResizeObserver;
    if (RO) {
      const obs = new RO(() => {
        const r = this.container.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          this.width = r.width;
          this.height = r.height;
          this.updateViewBox();
          this.applyTransform();
        }
      }) as ResizeObserver;
      obs.observe(container);
      this.resizeObs = obs;
    }

    try {
      const mq = this.win.matchMedia("(prefers-color-scheme: dark)");
      if (mq) {
        mq.addEventListener("change", this.onThemeChange);
        this.darkQuery = mq;
      }
    } catch {
      this.darkQuery = null;
    }

    this.svg.addEventListener("wheel", this.onWheel, { passive: false });
    this.svg.addEventListener("pointerdown", this.onBackgroundDown);
  }

  setData(data: GraphData): void {
    this.clearScene();
    // d3 mutates node positions and replaces edge IDs with node objects.
    // Keep each window's simulation separate from the shared data cache.
    data = {
      ...data,
      nodes: data.nodes.map((node) => ({
        ...node,
        roles: [...(node.roles || [node.kind])],
      })),
      edges: data.edges.map((edge) => ({
        ...edge,
        source: typeof edge.source === "object" ? edge.source.id : edge.source,
        target: typeof edge.target === "object" ? edge.target.id : edge.target,
      })),
    };
    this.data = data;

    // origin pinned at the simulation center
    const origin = data.nodes.find((n) => n.id === data.originId);
    if (origin) {
      origin.fx = 0;
      origin.fy = 0;
    }

    for (const edge of data.edges) {
      const line = this.createSVG<SVGLineElement>("line");
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("data-edge-type", edge.type);
      line.setAttribute("data-provenance", edge.provenance);
      if (edge.sharedCount !== undefined)
        line.setAttribute("data-shared-count", String(edge.sharedCount));
      if (edge.type === "citation")
        line.setAttribute("marker-end", `url(#${this.arrowID})`);
      this.edgeLayer.appendChild(line);
      this.edgeEls.push({ el: line, edge });
    }

    for (const node of data.nodes) {
      const c = this.createSVG<SVGCircleElement>("circle");
      c.setAttribute("r", String(nodeRadius(node)));
      c.setAttribute("fill", KIND_COLOR[node.kind]);
      // in-library nodes are solid, everything else is translucent —
      // the same visual language as the dimmed reference rows
      c.setAttribute(
        "fill-opacity",
        node.kind === "origin" || node.inLibrary ? "1" : "0.55",
      );
      c.style.cursor = "pointer";
      this.attachNodeEvents(c, node);
      this.nodeLayer.appendChild(c);
      this.nodeEls.set(node.id, c);
    }

    // labels: origin + the largest nodes, as many as the width can hold
    // without piling up (a 300px pane gets ~6, a wide one 12)
    const labelBudget = Math.max(
      LABEL_MIN,
      Math.min(LABEL_MAX, Math.round(this.width / PX_PER_LABEL)),
    );
    const largest = data.nodes
      .filter((n) => n.kind !== "origin")
      .sort((a, b) => nodeRadius(b) - nodeRadius(a))
      .slice(0, labelBudget);
    const labeled = origin ? [origin, ...largest] : largest;
    this.labeledIds = new Set(labeled.map((n) => n.id));
    for (const node of labeled) {
      const t = this.createSVG<SVGTextElement>("text");
      t.textContent = nodeLabel(node);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-size", "10.5");
      t.setAttribute("font-family", "system-ui, -apple-system, sans-serif");
      t.setAttribute("paint-order", "stroke");
      t.setAttribute("stroke-width", "2.5");
      t.setAttribute("stroke-linejoin", "round");
      t.style.pointerEvents = "none";
      this.labelLayer.appendChild(t);
      this.labelEls.set(node.id, t);
    }

    this.applyTheme();

    // The sandbox has no ambient timers, so the simulation is created
    // stopped and stepped manually from a requestAnimationFrame loop.
    this.sim = forceSimulation<GraphNode>(data.nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphEdge>(data.edges)
          .id((n) => n.id)
          .distance((e) => (e.type === "bibliographic-coupling" ? 46 : 70))
          .strength((e) =>
            e.type === "bibliographic-coupling"
              ? Math.min(1, e.weight / 6)
              : 0.3,
          ),
      )
      .force("charge", forceManyBody<GraphNode>().strength(-120))
      .force("center", forceCenter<GraphNode>(0, 0))
      .force(
        "collide",
        // labeled nodes reserve room for their caption below the circle
        forceCollide<GraphNode>((n) =>
          this.labeledIds.has(n.id) ? nodeRadius(n) + 13 : nodeRadius(n) + 5,
        ).strength(0.9),
      )
      // weak pull keeps disconnected components on screen
      .force("x", forceX<GraphNode>(0).strength(0.02))
      .force("y", forceY<GraphNode>(0).strength(0.02))
      .stop();

    // off-screen warm-up: converge most of the way before the first paint
    for (let i = 0; i < WARMUP_TICKS; i++) this.sim.tick();
    this.clampToCanvas();
    this.updatePositions();
    this.runTicks(SETTLE_TICKS);
  }

  /** flip a node's in-library state (solid vs translucent) after an import */
  setInLibrary(id: string, inLibrary: boolean): void {
    const node = this.data?.nodes.find((n) => n.id === id);
    if (node) node.inLibrary = inLibrary;
    const c = this.nodeEls.get(id);
    if (c && node) {
      c.setAttribute(
        "fill-opacity",
        node.kind === "origin" || inLibrary ? "1" : "0.55",
      );
    }
  }

  belongsToWindow(win: Window): boolean {
    return this.win === win;
  }

  destroy(): void {
    this.handlers.onHover?.(null);
    this.stopSim();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    try {
      this.darkQuery?.removeEventListener("change", this.onThemeChange);
    } catch {
      // ignore: view may already be torn down
    }
    this.darkQuery = null;
    this.svg.removeEventListener("wheel", this.onWheel);
    this.svg.removeEventListener("pointerdown", this.onBackgroundDown);
    this.svg.remove();
    this.nodeEls.clear();
    this.labelEls.clear();
    this.edgeEls = [];
    this.data = null;
    liveViews.delete(this);
  }

  // ------------------------------------------------------------------ scene

  /**
   * Create an SVG element in the container's document. Unconstrained
   * generic: the Gecko typings' SVG element interfaces are structurally
   * incompatible with their own Element (className shape), so a
   * `T extends Element` constraint would not compile.
   */
  private createSVG<T>(tag: string): T {
    return this.doc.createElementNS(SVG_NS, tag) as unknown as T;
  }

  private createG(parent: SVGElement): SVGGElement {
    const g = this.createSVG<SVGGElement>("g");
    parent.appendChild(g);
    return g;
  }

  private clearScene() {
    this.stopSim();
    this.edgeLayer.textContent = "";
    this.nodeLayer.textContent = "";
    this.labelLayer.textContent = "";
    this.nodeEls.clear();
    this.labelEls.clear();
    this.edgeEls = [];
    this.data = null;
  }

  private updateViewBox() {
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
  }

  private applyTransform() {
    // simulation space is centered at (0,0); base translate moves it to
    // the middle of the viewport, pan/zoom on top
    const tx = this.width / 2 + this.panX;
    const ty = this.height / 2 + this.panY;
    this.root.setAttribute(
      "transform",
      `translate(${tx},${ty}) scale(${this.scale})`,
    );
  }

  /** client (screen) coordinates -> simulation coordinates */
  private toLocal(clientX: number, clientY: number) {
    const r = this.svg.getBoundingClientRect();
    const sx = r.width > 0 ? ((clientX - r.left) / r.width) * this.width : 0;
    const sy = r.height > 0 ? ((clientY - r.top) / r.height) * this.height : 0;
    return {
      x: (sx - this.width / 2 - this.panX) / this.scale,
      y: (sy - this.height / 2 - this.panY) / this.scale,
    };
  }

  // ------------------------------------------------------------- simulation

  /**
   * Step the simulation from a requestAnimationFrame loop, a few ticks per
   * frame, updating DOM positions each frame, until the budget runs out or
   * the simulation cools below alphaMin.
   */
  private runTicks(budget: number) {
    if (this.win.matchMedia("(prefers-reduced-motion: reduce)")?.matches) {
      this.sim?.tick(budget);
      this.clampToCanvas();
      this.updatePositions();
      return;
    }
    this.tickBudget = Math.max(this.tickBudget, budget);
    if (this.rafId) return; // loop already running
    const step = () => {
      this.rafId = 0;
      const sim = this.sim;
      if (!sim) return;
      let ticked = 0;
      let maxMove = 0;
      while (ticked < TICKS_PER_FRAME && this.tickBudget > 0) {
        if (sim.alpha() < sim.alphaMin() && sim.alphaTarget() === 0) {
          this.tickBudget = 0;
          break;
        }
        sim.tick();
        ticked++;
        this.tickBudget--;
        for (const n of this.data?.nodes || []) {
          const m = Math.abs(n.vx || 0) + Math.abs(n.vy || 0);
          if (m > maxMove) maxMove = m;
        }
      }
      if (ticked) {
        this.clampToCanvas();
        this.updatePositions();
        // nothing visibly moving any more (and no drag holding alpha up):
        // stop early instead of burning frames on sub-pixel drift
        if (maxMove < MOTION_EPS && sim.alphaTarget() === 0) {
          this.tickBudget = 0;
        }
      }
      if (this.tickBudget > 0) {
        this.rafId = this.win.requestAnimationFrame(step);
      }
    };
    this.rafId = this.win.requestAnimationFrame(step);
  }

  private stopSim() {
    if (this.rafId) {
      this.win.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.tickBudget = 0;
    this.sim?.stop();
    this.sim = null;
  }

  /**
   * Keep every node inside the visible canvas. Zeroing the velocity on the
   * clamped axis matters: clamping position alone lets the force keep
   * pushing outward every tick, and the node visibly shivers at the border.
   */
  private clampToCanvas() {
    const boundX = Math.max(60, this.width / 2 - 14);
    const boundY = Math.max(60, this.height / 2 - 14);
    for (const node of this.data?.nodes || []) {
      if (typeof node.x === "number") {
        if (node.x < -boundX) {
          node.x = -boundX;
          node.vx = 0;
        } else if (node.x > boundX) {
          node.x = boundX;
          node.vx = 0;
        }
      }
      if (typeof node.y === "number") {
        if (node.y < -boundY) {
          node.y = -boundY;
          node.vy = 0;
        } else if (node.y > boundY) {
          node.y = boundY;
          node.vy = 0;
        }
      }
    }
  }

  private updatePositions() {
    for (const { el, edge } of this.edgeEls) {
      // after simulation init, forceLink resolved ids to node objects
      const s = edge.source as GraphNode;
      const t = edge.target as GraphNode;
      if (typeof s !== "object" || typeof t !== "object") continue;
      const dx = (t.x ?? 0) - (s.x ?? 0);
      const dy = (t.y ?? 0) - (s.y ?? 0);
      const length = Math.hypot(dx, dy) || 1;
      // Citation arrows end at the cited node's rim, not behind its circle.
      const start =
        edge.type === "citation" ? Math.min(nodeRadius(s) + 1, length / 2) : 0;
      const end =
        edge.type === "citation" ? Math.min(nodeRadius(t) + 2, length / 2) : 0;
      el.setAttribute("x1", String((s.x ?? 0) + (dx * start) / length));
      el.setAttribute("y1", String((s.y ?? 0) + (dy * start) / length));
      el.setAttribute("x2", String((t.x ?? 0) - (dx * end) / length));
      el.setAttribute("y2", String((t.y ?? 0) - (dy * end) / length));
    }
    for (const node of this.data?.nodes || []) {
      const c = this.nodeEls.get(node.id);
      if (c) {
        c.setAttribute("cx", String(node.x ?? 0));
        c.setAttribute("cy", String(node.y ?? 0));
      }
      const t = this.labelEls.get(node.id);
      if (t) {
        t.setAttribute("x", String(node.x ?? 0));
        t.setAttribute("y", String((node.y ?? 0) + nodeRadius(node) + 10));
      }
    }
  }

  // ------------------------------------------------------------------ theme

  private nodeOutline(): string {
    return this.darkQuery?.matches ? "#2b2b2b" : "#ffffff";
  }

  private applyTheme() {
    const dark = !!this.darkQuery?.matches;
    const labelFill = dark ? "#e6e6e6" : "#333333";
    const labelHalo = dark ? "#1e1e1e" : "#ffffff";
    const edgeStroke = dark ? "#cccccc" : "#555555";
    const nodeOutline = this.nodeOutline();
    this.arrowPath.setAttribute("fill", edgeStroke);
    for (const t of this.labelEls.values()) {
      t.setAttribute("fill", labelFill);
      t.setAttribute("stroke", labelHalo);
    }
    for (const { el, edge } of this.edgeEls) {
      el.setAttribute("stroke", edgeStroke);
      if (edge.type === "citation") {
        el.setAttribute("stroke-width", "1.4");
        el.setAttribute("stroke-opacity", "0.25");
      } else if (edge.type === "provider-related") {
        el.setAttribute("stroke-width", "1.4");
        el.setAttribute("stroke-opacity", "0.25");
        el.setAttribute("stroke-dasharray", "4 3");
      } else {
        // Bibliographic coupling: shared references, not co-citation.
        el.setAttribute(
          "stroke-width",
          String(Math.min(1.2, 0.4 + edge.weight * 0.1)),
        );
        el.setAttribute("stroke-opacity", "0.12");
      }
    }
    for (const node of this.data?.nodes || []) {
      const c = this.nodeEls.get(node.id);
      if (c) {
        c.setAttribute("stroke", nodeOutline);
        c.setAttribute("stroke-width", "1");
      }
    }
  }

  // ----------------------------------------------------------- interactions

  private onWheel = (ev: WheelEvent) => {
    // plain wheel scrolls the item pane; only Ctrl/Cmd+wheel (and trackpad
    // pinch, which Firefox reports as ctrlKey wheel) zooms the graph
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    if (k === this.scale) return;
    // zoom anchored at the cursor: keep the point under it fixed
    const r = this.svg.getBoundingClientRect();
    const sx = r.width > 0 ? ((ev.clientX - r.left) / r.width) * this.width : 0;
    const sy =
      r.height > 0 ? ((ev.clientY - r.top) / r.height) * this.height : 0;
    const lx = (sx - this.width / 2 - this.panX) / this.scale;
    const ly = (sy - this.height / 2 - this.panY) / this.scale;
    this.scale = k;
    this.panX = sx - this.width / 2 - k * lx;
    this.panY = sy - this.height / 2 - k * ly;
    this.applyTransform();
  };

  /** background drag = pan (node circles stop propagation) */
  private onBackgroundDown = (ev: PointerEvent) => {
    if (ev.target !== this.svg) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startPanX = this.panX;
    const startPanY = this.panY;
    const rect = this.svg.getBoundingClientRect();
    const kx = rect.width > 0 ? this.width / rect.width : 1;
    const ky = rect.height > 0 ? this.height / rect.height : 1;
    this.svg.style.cursor = "grabbing";
    const move = (e: PointerEvent) => {
      this.panX = startPanX + (e.clientX - startX) * kx;
      this.panY = startPanY + (e.clientY - startY) * ky;
      this.applyTransform();
    };
    const up = () => {
      this.svg.style.cursor = "grab";
      this.svg.removeEventListener("pointermove", move);
      this.svg.removeEventListener("pointerup", up);
      this.svg.removeEventListener("pointercancel", up);
      try {
        this.svg.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore: view may already be torn down
      }
    };
    try {
      this.svg.setPointerCapture(ev.pointerId);
    } catch {
      // ignore: view may already be torn down
    }
    this.svg.addEventListener("pointermove", move);
    this.svg.addEventListener("pointerup", up);
    this.svg.addEventListener("pointercancel", up);
  };

  private attachNodeEvents(circle: SVGCircleElement, node: GraphNode) {
    circle.setAttribute("tabindex", "0");
    circle.setAttribute("role", "button");
    circle.setAttribute("aria-label", node.ref.title || nodeLabel(node));
    circle.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) this.handlers.onOpen?.(node);
        else this.handlers.onSelect?.(node);
      } else if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        const rect = circle.getBoundingClientRect();
        this.handlers.onContext?.(
          node,
          this.win.screenX + rect.x,
          this.win.screenY + rect.bottom,
        );
      }
    });
    // true when the last press turned into a drag; suppresses the click
    let dragOccurred = false;

    circle.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      dragOccurred = false;
      // raise above overlapping siblings while pressed / dragged
      if ((this.nodeLayer.lastElementChild as unknown) !== circle) {
        this.nodeLayer.appendChild(circle);
      }
      const startX = ev.clientX;
      const startY = ev.clientY;
      let dragging = false;
      const move = (e: PointerEvent) => {
        if (
          !dragging &&
          Math.hypot(e.clientX - startX, e.clientY - startY) < CLICK_SLOP
        ) {
          return;
        }
        if (!dragging) {
          dragging = true;
          this.sim?.alphaTarget(0.3);
        }
        const p = this.toLocal(e.clientX, e.clientY);
        node.fx = p.x;
        node.fy = p.y;
        this.runTicks(60);
      };
      const up = () => {
        circle.removeEventListener("pointermove", move);
        circle.removeEventListener("pointerup", up);
        circle.removeEventListener("pointercancel", up);
        try {
          circle.releasePointerCapture(ev.pointerId);
        } catch {
          // ignore: view may already be torn down
        }
        dragOccurred = dragging;
        if (dragging) {
          this.sim?.alphaTarget(0);
          // origin stays pinned wherever it was dropped
          if (node.kind !== "origin") {
            node.fx = null;
            node.fy = null;
          }
          this.runTicks(90);
        }
      };
      try {
        circle.setPointerCapture(ev.pointerId);
      } catch {
        // ignore: view may already be torn down
      }
      circle.addEventListener("pointermove", move);
      circle.addEventListener("pointerup", up);
      circle.addEventListener("pointercancel", up);
    });

    circle.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      if (dragOccurred) return;
      this.handlers.onSelect?.(node);
    });

    circle.addEventListener("dblclick", (ev: MouseEvent) => {
      ev.stopPropagation();
      this.handlers.onOpen?.(node);
    });

    circle.addEventListener("contextmenu", (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      this.handlers.onContext?.(node, ev.screenX, ev.screenY);
    });

    circle.addEventListener("pointerenter", () => {
      // NEVER move the element in the DOM here: re-inserting the node
      // under the pointer fires pointerleave/pointerenter again and the
      // cursor flips grab ↔ pointer in a loop (visible as a flickering
      // hand). Highlight in place instead.
      circle.setAttribute("stroke", KIND_COLOR[node.kind]);
      circle.setAttribute("stroke-width", "3");
      circle.setAttribute("stroke-opacity", "0.45");
      const r = circle.getBoundingClientRect();
      this.handlers.onHover?.(node, {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      });
    });

    circle.addEventListener("pointerleave", () => {
      circle.setAttribute("stroke", this.nodeOutline());
      circle.setAttribute("stroke-width", "1");
      circle.removeAttribute("stroke-opacity");
      this.handlers.onHover?.(null);
    });
  }
}
