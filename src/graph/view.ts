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
  /** hover enter (with the circle's screen rect) / leave (null) */
  onHover?: (
    node: GraphNode | null,
    rect?: { x: number; y: number; width: number; height: number },
  ) => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const KIND_COLOR: Record<GraphNode["kind"], string> = {
  origin: "#e8710a",
  reference: "#4a90d9",
  citation: "#35999a",
  related: "#9b7fd4",
};
const IN_LIBRARY_RING = "#d63b3b";

/** initial layout budget (spec: ~150 ticks) */
const SETTLE_TICKS = 150;
/** simulation steps per animation frame */
const TICKS_PER_FRAME = 3;
/** how many of the largest nodes get a label (origin always labeled) */
const LABEL_COUNT = 12;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
/** pointer movement (px) below which a press counts as a click */
const CLICK_SLOP = 3;

function nodeRadius(n: GraphNode): number {
  const r = 5 + 3 * Math.log2(1 + (n.ref.citationCount || 0));
  return n.kind === "origin" ? r + 4 : r;
}

/** "Surname Year" label, falling back to a title stub. */
function nodeLabel(n: GraphNode): string {
  const author = (n.ref.authors?.[0] || "").trim();
  const surname = author.split(/\s+/).pop() || "";
  const label = [surname, n.ref.year || ""].filter(Boolean).join(" ");
  return label || (n.ref.title || "").slice(0, 18);
}

export class GraphView {
  private container: HTMLElement;
  private handlers: GraphHandlers;
  private doc: Document;
  private win: Window;

  private svg: SVGSVGElement;
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

  constructor(container: HTMLElement, handlers: GraphHandlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.doc = container.ownerDocument as Document;
    this.win = this.doc.defaultView as Window;

    this.svg = this.createSVG<SVGSVGElement>("svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.style.display = "block";
    this.svg.style.cursor = "grab";
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
      this.edgeLayer.appendChild(line);
      this.edgeEls.push({ el: line, edge });
    }

    for (const node of data.nodes) {
      const c = this.createSVG<SVGCircleElement>("circle");
      c.setAttribute("r", String(nodeRadius(node)));
      c.setAttribute("fill", KIND_COLOR[node.kind]);
      if (node.inLibrary) {
        c.setAttribute("stroke", IN_LIBRARY_RING);
        c.setAttribute("stroke-width", "2");
      }
      c.style.cursor = "pointer";
      this.attachNodeEvents(c, node);
      this.nodeLayer.appendChild(c);
      this.nodeEls.set(node.id, c);
    }

    // labels: origin + the largest nodes
    const largest = data.nodes
      .filter((n) => n.kind !== "origin")
      .sort((a, b) => nodeRadius(b) - nodeRadius(a))
      .slice(0, LABEL_COUNT);
    const labeled = origin ? [origin, ...largest] : largest;
    for (const node of labeled) {
      const t = this.createSVG<SVGTextElement>("text");
      t.textContent = nodeLabel(node);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-size", "10");
      t.setAttribute("font-family", "sans-serif");
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
          .distance((e) => (e.kind === "direct" ? 80 : 40))
          .strength((e) =>
            e.kind === "direct" ? 0.3 : Math.min(1, e.weight / 6),
          ),
      )
      .force("charge", forceManyBody<GraphNode>().strength(-120))
      .force("center", forceCenter<GraphNode>(0, 0))
      .force(
        "collide",
        forceCollide<GraphNode>((n) => nodeRadius(n) + 2),
      )
      // weak pull keeps disconnected components on screen
      .force("x", forceX<GraphNode>(0).strength(0.02))
      .force("y", forceY<GraphNode>(0).strength(0.02))
      .stop();

    this.runTicks(SETTLE_TICKS);
  }

  destroy(): void {
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
    this.tickBudget = Math.max(this.tickBudget, budget);
    if (this.rafId) return; // loop already running
    const step = () => {
      this.rafId = 0;
      const sim = this.sim;
      if (!sim) return;
      let ticked = 0;
      while (ticked < TICKS_PER_FRAME && this.tickBudget > 0) {
        if (sim.alpha() < sim.alphaMin() && sim.alphaTarget() === 0) {
          this.tickBudget = 0;
          break;
        }
        sim.tick();
        ticked++;
        this.tickBudget--;
      }
      if (ticked) this.updatePositions();
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

  private updatePositions() {
    for (const { el, edge } of this.edgeEls) {
      // after simulation init, forceLink resolved ids to node objects
      const s = edge.source as GraphNode;
      const t = edge.target as GraphNode;
      if (typeof s !== "object" || typeof t !== "object") continue;
      el.setAttribute("x1", String(s.x ?? 0));
      el.setAttribute("y1", String(s.y ?? 0));
      el.setAttribute("x2", String(t.x ?? 0));
      el.setAttribute("y2", String(t.y ?? 0));
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
        t.setAttribute("y", String((node.y ?? 0) + nodeRadius(node) + 12));
      }
    }
  }

  // ------------------------------------------------------------------ theme

  private applyTheme() {
    const dark = !!this.darkQuery?.matches;
    const labelFill = dark ? "#e6e6e6" : "#333333";
    const edgeStroke = dark ? "#cccccc" : "#555555";
    const nodeOutline = dark ? "#2b2b2b" : "#ffffff";
    for (const t of this.labelEls.values()) {
      t.setAttribute("fill", labelFill);
    }
    for (const { el, edge } of this.edgeEls) {
      el.setAttribute("stroke", edgeStroke);
      if (edge.kind === "direct") {
        el.setAttribute("stroke-width", "1.4");
        el.setAttribute("stroke-opacity", "0.25");
      } else {
        // co-citation: thinner and more translucent, width nudged by weight
        el.setAttribute(
          "stroke-width",
          String(Math.min(1.2, 0.4 + edge.weight * 0.1)),
        );
        el.setAttribute("stroke-opacity", "0.12");
      }
    }
    for (const node of this.data?.nodes || []) {
      const c = this.nodeEls.get(node.id);
      if (c && !node.inLibrary) {
        c.setAttribute("stroke", nodeOutline);
        c.setAttribute("stroke-width", "1");
      }
    }
  }

  // ----------------------------------------------------------- interactions

  private onWheel = (ev: WheelEvent) => {
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
    // true when the last press turned into a drag; suppresses the click
    let dragOccurred = false;

    circle.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      dragOccurred = false;
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

    circle.addEventListener("pointerenter", () => {
      // raise above overlapping siblings
      this.nodeLayer.appendChild(circle);
      const r = circle.getBoundingClientRect();
      this.handlers.onHover?.(node, {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      });
    });

    circle.addEventListener("pointerleave", () => {
      this.handlers.onHover?.(null);
    });
  }
}
