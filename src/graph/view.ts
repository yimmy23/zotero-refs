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

/** Prewarm off-screen in short frames, then reveal a mostly settled graph. */
const WARMUP_TICKS = 110;
const SETTLE_TICKS = 50;
/** simulation steps per animation frame */
const TICKS_PER_FRAME = 2;
const FRAME_WORK_MS = 4;
const MAX_WARMUP_TICKS_PER_FRAME = 40;
const WHEEL_LINE_PX = 16;
const ZOOM_PER_PIXEL = 0.002;
/** stop animating once the largest per-tick displacement drops below this */
const MOTION_EPS = 0.08;
/** label budget scales with canvas width (origin always labeled) */
const LABEL_MIN = 4;
const LABEL_MAX = 12;
const PX_PER_LABEL = 45;
const LABEL_PADDING = 4;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
/** pointer movement (px) below which a press counts as a click */
const CLICK_SLOP = 3;

interface Gesture {
  target: SVGElement;
  pointerId: number;
  node?: GraphNode;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  startPanX: number;
  startPanY: number;
  dragging: boolean;
  pending: boolean;
  ending?: "release" | "cancel";
  suppressClick?: () => void;
}

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
  private labelMetrics = new Map<
    string,
    { width: number; ascent: number; descent: number }
  >();
  private edgeEls: Array<{ el: SVGLineElement; edge: GraphEdge }> = [];

  private width = 300;
  private height = 300;
  private panX = 0;
  private panY = 0;
  private scale = 1;

  private rafId = 0;
  private tickBudget = 0;
  private warmupTicks = 0;
  private transformDirty = false;
  private positionsDirty = false;
  private inputRect: DOMRect | null = null;
  private gesture: Gesture | null = null;
  private hoveredCircle: SVGCircleElement | null = null;
  private destroyed = false;
  private motionQuery: MediaQueryList | null = null;
  private onMotionChange = () => {
    if (this.motionQuery?.matches) this.tickBudget = 0;
  };

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
    this.edgeLayer.style.pointerEvents = "none";
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
        if (this.destroyed) return;
        const r = this.container.getBoundingClientRect();
        if (
          r.width > 0 &&
          r.height > 0 &&
          (r.width !== this.width || r.height !== this.height)
        ) {
          this.width = r.width;
          this.height = r.height;
          this.inputRect = null;
          this.updateViewBox();
          this.transformDirty = true;
          this.positionsDirty = true;
          this.scheduleFrame();
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

    try {
      this.motionQuery = this.win.matchMedia(
        "(prefers-reduced-motion: reduce)",
      );
      this.motionQuery?.addEventListener("change", this.onMotionChange);
    } catch {
      this.motionQuery = null;
    }

    this.svg.addEventListener("wheel", this.onWheel, { passive: false });
    this.svg.addEventListener("pointerdown", this.onBackgroundDown);
  }

  setData(data: GraphData): void {
    if (this.destroyed) return;
    this.clearScene();
    this.root.style.visibility = "hidden";
    this.transformDirty = true;
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
    if (!data.nodes.length) {
      this.root.style.visibility = "visible";
      this.applyTransform();
      this.transformDirty = false;
      return;
    }

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

    // Reduced motion also finishes the tail before revealing the graph.
    // Never spend the whole warm-up budget in Zotero's item-pane callback.
    this.warmupTicks =
      WARMUP_TICKS + (this.motionQuery?.matches ? SETTLE_TICKS : 0);
    this.scheduleFrame();
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelHover();
    this.endGesture();
    this.stopSim();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    try {
      this.darkQuery?.removeEventListener("change", this.onThemeChange);
    } catch {
      // ignore: view may already be torn down
    }
    this.darkQuery = null;
    try {
      this.motionQuery?.removeEventListener("change", this.onMotionChange);
    } catch {
      // ignore: view may already be torn down
    }
    this.motionQuery = null;
    this.svg.removeEventListener("wheel", this.onWheel);
    this.svg.removeEventListener("pointerdown", this.onBackgroundDown);
    this.svg.remove();
    this.nodeEls.clear();
    this.labelEls.clear();
    this.labelMetrics.clear();
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
    this.cancelHover();
    this.endGesture();
    this.stopSim();
    this.edgeLayer.textContent = "";
    this.nodeLayer.textContent = "";
    this.labelLayer.textContent = "";
    this.nodeEls.clear();
    this.labelEls.clear();
    this.labelMetrics.clear();
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
    const r = (this.inputRect ??= this.svg.getBoundingClientRect());
    const sx = r.width > 0 ? ((clientX - r.left) / r.width) * this.width : 0;
    const sy = r.height > 0 ? ((clientY - r.top) / r.height) * this.height : 0;
    return {
      x: (sx - this.width / 2 - this.panX) / this.scale,
      y: (sy - this.height / 2 - this.panY) / this.scale,
    };
  }

  // ------------------------------------------------------------- simulation

  /** Input bursts and simulation steps share one DOM commit per frame. */
  private scheduleFrame() {
    if (!this.rafId && !this.destroyed)
      this.rafId = this.win.requestAnimationFrame(this.onFrame);
  }

  private onFrame = () => {
    this.rafId = 0;
    if (this.destroyed) return;
    this.applyGestureSample();
    const sim = this.sim;
    const start = this.win.performance?.now() ?? Date.now();
    if (sim && this.warmupTicks > 0) {
      let steps = 0;
      do {
        sim.tick();
        this.warmupTicks--;
        steps++;
      } while (
        this.warmupTicks > 0 &&
        steps < MAX_WARMUP_TICKS_PER_FRAME &&
        (this.win.performance?.now() ?? Date.now()) - start < FRAME_WORK_MS
      );
      if (!this.warmupTicks) {
        this.positionsDirty = true;
        this.root.style.visibility = "visible";
        this.measureLabels();
        this.runTicks(SETTLE_TICKS);
      }
    } else if (sim && this.tickBudget > 0 && !this.motionQuery?.matches) {
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
        for (const n of this.data?.nodes || [])
          maxMove = Math.max(
            maxMove,
            Math.abs(n.vx || 0) + Math.abs(n.vy || 0),
          );
        if (
          (this.win.performance?.now() ?? Date.now()) - start >=
          FRAME_WORK_MS
        )
          break;
      }
      if (ticked) {
        this.positionsDirty = true;
        if (maxMove < MOTION_EPS && sim.alphaTarget() === 0)
          this.tickBudget = 0;
      }
    }
    // Keep the released node pinned through this frame's last simulation
    // step so its final pointer sample is actually painted before settling.
    const released = this.gesture?.ending ? this.gesture : null;
    if (released) this.endGesture(true);
    if (this.positionsDirty && !this.warmupTicks) {
      this.clampToCanvas();
      this.updatePositions();
      this.positionsDirty = false;
    }
    if (this.transformDirty) {
      this.applyTransform();
      this.transformDirty = false;
    }
    this.inputRect = null;
    // Capture suppresses pointerenter while dragging. After the final DOM
    // commit, restore the existing hover delay only if the pointer is still
    // over this node; cancellation and superseding input never take this path.
    if (
      released?.node &&
      this.doc.elementFromPoint(released.clientX, released.clientY) ===
        (released.target as unknown) &&
      released.target.matches(":hover")
    )
      this.showHover(released.target as SVGCircleElement, released.node);
    if (this.warmupTicks > 0 || this.tickBudget > 0) this.scheduleFrame();
  };

  private runTicks(budget: number) {
    if (!this.sim || this.motionQuery?.matches) return;
    this.tickBudget = Math.max(this.tickBudget, budget);
    this.scheduleFrame();
  }

  private stopSim() {
    if (this.rafId) this.win.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.tickBudget = 0;
    this.warmupTicks = 0;
    this.positionsDirty = false;
    this.transformDirty = false;
    this.inputRect = null;
    this.sim?.stop();
    this.sim = null;
  }

  /**
   * Keep every node inside the visible canvas. Zeroing the velocity on the
   * clamped axis matters: clamping position alone lets the force keep
   * pushing outward every tick, and the node visibly shivers at the border.
   */
  private clampToCanvas() {
    for (const node of this.data?.nodes || []) {
      const boundX = Math.max(0, this.width / 2 - nodeRadius(node) - 2);
      const boundY = Math.max(0, this.height / 2 - nodeRadius(node) - 2);
      if (typeof node.fx === "number")
        node.fx = Math.max(-boundX, Math.min(boundX, node.fx));
      if (typeof node.fy === "number")
        node.fy = Math.max(-boundY, Math.min(boundY, node.fy));
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

  /** Text geometry is measured once, never during simulation or resizing. */
  private measureLabels() {
    for (const [id, label] of this.labelEls) {
      let metrics = {
        width: (label.textContent?.length || 0) * 10.5,
        ascent: 10.5,
        descent: 3,
      };
      try {
        // Labels still have their initial baseline at y=0 here.
        const box = label.getBBox();
        if (box.width > 0 && box.height > 0)
          metrics = {
            width: box.width,
            ascent: Math.max(0, -box.y),
            descent: Math.max(0, box.y + box.height),
          };
      } catch {
        // A hidden document can lack text metrics until it is painted.
      }
      this.labelMetrics.set(id, metrics);
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
        const metrics = this.labelMetrics.get(node.id);
        // A caption wider than a very narrow pane cannot fit at any x.
        // Keep the font intact and restore it as soon as space is available;
        // the node remains interactive and exposes its complete title.
        t.style.visibility =
          metrics &&
          (metrics.width > this.width - LABEL_PADDING * 2 ||
            metrics.ascent + metrics.descent > this.height - LABEL_PADDING * 2)
            ? "hidden"
            : "visible";
        const boundX = Math.max(
          0,
          this.width / 2 - LABEL_PADDING - (metrics?.width || 0) / 2,
        );
        const x = Math.max(-boundX, Math.min(boundX, node.x ?? 0));
        const ascent = metrics?.ascent ?? 10.5;
        const descent = metrics?.descent ?? 3;
        let y = (node.y ?? 0) + nodeRadius(node) + 10;
        const bottom = this.height / 2 - LABEL_PADDING - descent;
        if (y > bottom) y = (node.y ?? 0) - nodeRadius(node) - 5;
        y = Math.min(
          bottom,
          Math.max(-this.height / 2 + LABEL_PADDING + ascent, y),
        );
        t.setAttribute("x", String(x));
        t.setAttribute("y", String(y));
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

  private showHover(circle: SVGCircleElement, node: GraphNode) {
    if (
      this.destroyed ||
      this.gesture ||
      this.transformDirty ||
      this.positionsDirty ||
      this.warmupTicks ||
      this.hoveredCircle === circle
    )
      return;
    this.cancelHover();
    this.hoveredCircle = circle;
    // Highlight in place: re-inserting a hovered SVG node can cause an
    // endless pointerleave/pointerenter loop in Gecko.
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
  }

  private cancelHover() {
    const circle = this.hoveredCircle;
    if (!circle) return;
    this.hoveredCircle = null;
    circle.setAttribute("stroke", this.nodeOutline());
    circle.setAttribute("stroke-width", "1");
    circle.removeAttribute("stroke-opacity");
    this.handlers.onHover?.(null);
  }

  private onWheel = (ev: WheelEvent) => {
    // Plain wheel belongs to the item pane; Ctrl/Cmd wheel and pinch zoom.
    if (!ev.ctrlKey && !ev.metaKey) return;
    if (!Number.isFinite(ev.deltaY) || ev.deltaY === 0) return;
    ev.preventDefault();
    const unit =
      ev.deltaMode === 1 ? WHEEL_LINE_PX : ev.deltaMode === 2 ? this.height : 1;
    const delta = Math.max(-240, Math.min(240, ev.deltaY * unit));
    const k = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, this.scale * Math.exp(-delta * ZOOM_PER_PIXEL)),
    );
    if (k === this.scale) return;
    this.cancelHover();
    this.finishPendingRelease();
    this.endGesture();
    const p = this.toLocal(ev.clientX, ev.clientY);
    // Preserve the cursor anchor across every sample, including moving
    // cursors, but read geometry and write the transform only once a frame.
    this.panX += (this.scale - k) * p.x;
    this.panY += (this.scale - k) * p.y;
    this.scale = k;
    this.transformDirty = true;
    this.scheduleFrame();
  };

  private onBackgroundDown = (ev: PointerEvent) => {
    if (ev.target === this.svg) this.beginGesture(ev, this.svg);
  };

  private beginGesture(
    ev: PointerEvent,
    target: SVGElement,
    node?: GraphNode,
    suppressClick?: () => void,
  ) {
    if (
      ev.button !== 0 ||
      ev.isPrimary === false ||
      this.destroyed ||
      this.warmupTicks
    )
      return false;
    this.finishPendingRelease();
    if (this.gesture) return false;
    ev.preventDefault();
    this.cancelHover();
    this.gesture = {
      target,
      pointerId: ev.pointerId,
      node,
      suppressClick,
      startX: ev.clientX,
      startY: ev.clientY,
      clientX: ev.clientX,
      clientY: ev.clientY,
      startPanX: this.panX,
      startPanY: this.panY,
      dragging: false,
      pending: false,
    };
    if (node && (this.nodeLayer.lastElementChild as unknown) !== target)
      this.nodeLayer.appendChild(target);
    this.svg.style.cursor = "grabbing";
    target.addEventListener("pointermove", this.onGestureMove);
    target.addEventListener("pointerup", this.onGestureEnd);
    target.addEventListener("pointercancel", this.onGestureCancel);
    target.addEventListener("lostpointercapture", this.onGestureCancel);
    try {
      target.setPointerCapture(ev.pointerId);
    } catch {
      // A detached node or an already-ended pointer cannot start a gesture.
      this.endGesture();
      return false;
    }
    return true;
  }

  /** A new input can arrive before the previous release's queued frame. */
  private finishPendingRelease() {
    if (!this.gesture?.ending) return;
    this.applyGestureSample();
    this.endGesture(true);
  }

  private queueGestureSample(ev: PointerEvent) {
    const g = this.gesture;
    if (!g || ev.pointerId !== g.pointerId || g.ending) return;
    g.clientX = ev.clientX;
    g.clientY = ev.clientY;
    g.dragging ||=
      Math.hypot(g.clientX - g.startX, g.clientY - g.startY) >= CLICK_SLOP;
    g.pending = g.dragging;
    if (g.dragging) g.suppressClick?.();
    this.scheduleFrame();
  }

  private onGestureMove = (ev: PointerEvent) => this.queueGestureSample(ev);

  private onGestureEnd = (ev: PointerEvent) => {
    const g = this.gesture;
    if (!g || ev.pointerId !== g.pointerId || g.ending) return;
    this.queueGestureSample(ev);
    g.ending = "release";
    // Browser click follows pointerup before the queued frame executes.
    if (g.dragging) g.suppressClick?.();
  };

  private onGestureCancel = (ev: PointerEvent) => {
    const g = this.gesture;
    if (!g || ev.pointerId !== g.pointerId || g.ending) return;
    g.suppressClick?.();
    this.endGesture();
  };

  private applyGestureSample() {
    const g = this.gesture;
    if (!g) return;
    if (g.pending) {
      g.pending = false;
      if (g.node) {
        const p = this.toLocal(g.clientX, g.clientY);
        const boundX = Math.max(0, this.width / 2 - nodeRadius(g.node) - 2);
        const boundY = Math.max(0, this.height / 2 - nodeRadius(g.node) - 2);
        g.node.x = g.node.fx = Math.max(-boundX, Math.min(boundX, p.x));
        g.node.y = g.node.fy = Math.max(-boundY, Math.min(boundY, p.y));
        g.node.vx = g.node.vy = 0;
        this.positionsDirty = true;
        if (!this.motionQuery?.matches) {
          this.sim?.alphaTarget(0.3);
          this.runTicks(60);
        }
      } else {
        const r = (this.inputRect ??= this.svg.getBoundingClientRect());
        this.panX =
          g.startPanX +
          (g.clientX - g.startX) * (r.width > 0 ? this.width / r.width : 1);
        this.panY =
          g.startPanY +
          (g.clientY - g.startY) * (r.height > 0 ? this.height / r.height : 1);
        this.transformDirty = true;
      }
    }
  }

  /** Release capture/listeners and pins for completion, replacement or teardown. */
  private endGesture(settle = false) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (!settle || g.dragging) g.suppressClick?.();
    g.target.removeEventListener("pointermove", this.onGestureMove);
    g.target.removeEventListener("pointerup", this.onGestureEnd);
    g.target.removeEventListener("pointercancel", this.onGestureCancel);
    g.target.removeEventListener("lostpointercapture", this.onGestureCancel);
    this.svg.style.cursor = "grab";
    try {
      g.target.releasePointerCapture(g.pointerId);
    } catch {
      // The browser may already have released capture during cancellation.
    }
    this.sim?.alphaTarget(0);
    if (g.node && g.dragging) {
      if (g.node.kind !== "origin") g.node.fx = g.node.fy = null;
      if (settle) this.runTicks(90);
    }
  }

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
      if (
        this.beginGesture(ev, circle, node, () => {
          dragOccurred = true;
        })
      )
        dragOccurred = false;
    });

    circle.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      if (dragOccurred) return;
      this.handlers.onSelect?.(node);
    });

    circle.addEventListener("dblclick", (ev: MouseEvent) => {
      ev.stopPropagation();
      if (!dragOccurred) this.handlers.onOpen?.(node);
    });

    circle.addEventListener("contextmenu", (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      this.handlers.onContext?.(node, ev.screenX, ev.screenY);
    });

    circle.addEventListener("pointerenter", () => this.showHover(circle, node));

    circle.addEventListener("pointerleave", () => {
      if (this.hoveredCircle === circle) this.cancelHover();
    });
  }
}
