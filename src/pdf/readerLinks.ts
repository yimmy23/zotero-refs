import type { RefItem } from "../core/types";
import { normalizeTitle } from "../core/text";
import { getPref } from "../utils/prefs";

/**
 * In-PDF citation link enhancement, built on Zotero 7+'s reader overlay
 * pipeline (the pdf.js annotation layer is hidden by the reader's CSS —
 * Zotero renders internal links / citations through its own overlay system,
 * which is why the original plugin shipped this feature disabled).
 *
 * Verified against the Zotero 9.0.6 and 10.0 reader bundles:
 *   - hover: PDFView calls `this._onSetOverlayPopup({...overlay, rect})`
 *     for overlays of type "internal-link" (destinationPosition) and
 *     "citation"/"reference", whose `references[]` carry the printed
 *     bibliography entry the reader extracted itself ({ text, index?,
 *     position }); `rect` is a client rect in the pdf.js iframe viewport;
 *     `null` means hover ended.
 *   - click: PDFView pointer-up resolves `_getSelectableOverlay(position)`
 *     and calls `this.navigate({ position })` for internal links/citations.
 *   - split view: `internal.toggleHorizontalSplit(true)` /
 *     `toggleVerticalSplit(true)`; the second view is
 *     `internal._secondaryView` (a PDFView with `navigate(location)`).
 *     (`reader.menuCmd` no longer exists in Zotero 9.)
 *
 * Integration:
 *   - hoverLink: wrap `_onSetOverlayPopup` — when the destination matches a
 *     parsed reference, show OUR multi-source card and suppress the native
 *     preview; pass everything else through.
 *   - clickLink: wrap `navigate` with a pointerup correlation so ONLY
 *     overlay-click navigations are redirected into the split view (outline
 *     / back-button navigation stays untouched).
 */

export interface LinkPopupHandler {
  (
    anchorRect: { x: number; y: number; width: number; height: number },
    ref: RefItem,
  ): void;
}

export interface ListPopupHandler {
  (
    anchorRect: { x: number; y: number; width: number; height: number },
    refs: RefItem[],
  ): void;
}

const READY_TIMEOUT = 10000;
/** max ms between an overlay pointerup and the navigate() it triggers */
const NAV_CORRELATION_MS = 300;
/** citation clusters bigger than this keep the native popup */
const MAX_CLUSTER = 12;

interface ReaderState {
  cancelled: boolean;
  view: any;
  /** pdf.js iframe window */
  win: any;
  origNavigate?: any;
  origSetOverlayPopup?: any;
  pointerListener?: (event: any) => void;
}

/**
 * Reference whose stored PDF anchor is nearest to the link destination.
 * Anchors are page-local PDF-space coordinates, so the page must match
 * when both sides know it (multi-page bibliographies), and the hit must be
 * genuinely close: a figure/equation/section link points nowhere near a
 * bibliography entry and must keep Zotero's native preview instead.
 */
const MAX_ANCHOR_DIST = 60; // PDF points (~2 text lines)
function nearestRef(
  refs: RefItem[],
  x: number,
  y: number,
  pageIndex?: number,
): RefItem | null {
  let best: RefItem | null = null;
  let bestD = Infinity;
  for (const ref of refs) {
    if (typeof ref.x !== "number" || typeof ref.y !== "number") continue;
    if (
      typeof pageIndex === "number" &&
      typeof ref.page === "number" &&
      ref.page !== pageIndex
    ) {
      continue;
    }
    // vertical distance dominates: entries stack; x differs only by indent
    const d = (x - ref.x) ** 2 * 0.25 + (y - ref.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = ref;
    }
  }
  return best && Math.sqrt(bestD) <= MAX_ANCHOR_DIST ? best : null;
}

/**
 * Match a citation overlay's extracted entry (Zotero's reader parses the
 * printed bibliography itself: { text, index?, position }) against our
 * fused list. Both texts are the same printed entry, so agreement is
 * strict normalized-prefix equality — never mid-string containment.
 */
export function refForCitation(refs: RefItem[], cite: any): RefItem | null {
  const text = String(cite?.text || "");
  if (!text) return null;
  const norm = normalizeTitle(text);
  const agree = (a?: string, b?: string) => {
    if (!a || !b) return false;
    const n = Math.min(a.length, b.length, 25);
    return n >= 10 && a.slice(0, n) === b.slice(0, n);
  };
  const num =
    typeof cite?.index === "number"
      ? cite.index
      : Number(/^\s*[[(]?(\d{1,4})[\])]?[.．、]?\s/.exec(text)?.[1]) ||
        undefined;
  if (num !== undefined) {
    const cands = refs.filter((r) => r.number === num);
    if (cands.length === 1 && agree(norm, normalizeTitle(cands[0].text))) {
      return cands[0];
    }
    // a numbered bibliography that disagrees on this number: don't guess
    if (cands.length) return null;
  }
  // author–year styles carry no number: unique long-prefix match
  if (norm.length >= 30) {
    const pre = norm.slice(0, 30);
    const cands = refs.filter((r) => normalizeTitle(r.text).startsWith(pre));
    if (cands.length === 1) return cands[0];
  }
  return null;
}

/** [x1,y1,x2,y2] | DOMRect-ish -> {x1,y1,x2,y2} */
function normRect(
  rect: any,
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!rect) return null;
  if (Array.isArray(rect) && rect.length >= 4) {
    return { x1: rect[0], y1: rect[1], x2: rect[2], y2: rect[3] };
  }
  if (typeof rect.left === "number") {
    return { x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom };
  }
  return null;
}

/** overlay destination position: {pageIndex, rects: [[x1,y1,x2,y2],...]} */
function overlayDestPosition(overlay: any): any {
  if (!overlay) return null;
  if (overlay.type === "internal-link") return overlay.destinationPosition;
  if (overlay.type === "citation" || overlay.type === "reference") {
    return overlay.references?.[0]?.position;
  }
  return null;
}

/**
 * Convert a client rect inside the pdf.js iframe into main-window
 * coordinates: walk the frame chain as far as frameElement reaches, then
 * hop the chrome boundary via the reader's own browser element. Returns
 * null when the main window cannot be reached.
 */
export function toMainWindowRect(
  reader: any,
  win: any,
  rect: any,
): { x: number; y: number; width: number; height: number } | null {
  const r = normRect(rect);
  if (!r) return null;
  let { x1, y1, x2, y2 } = r;
  try {
    let w: any = win;
    for (let depth = 0; depth < 5; depth++) {
      const frame = w?.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      x1 += fr.x;
      y1 += fr.y;
      x2 += fr.x;
      y2 += fr.y;
      w = frame.ownerDocument?.defaultView;
    }
    if (!w || !(w as any).Zotero_Tabs) {
      // Zotero 10 hosts reader.html in a chrome <browser>: frameElement
      // (and even browsingContext.embedderElement, hidden by the sandbox
      // wrapper) cannot cross it — but the reader knows its own browser
      // element, whose rect lives in the window that owns the tab.
      // A detached (separate-window) reader's owner has no Zotero_Tabs:
      // return null so that reader keeps the native preview (the popup
      // renders into the main window and would be misplaced there).
      const browser = reader?._iframe;
      const owner = browser?.ownerDocument?.defaultView;
      if (!browser || !owner?.Zotero_Tabs) return null;
      const fr = browser.getBoundingClientRect();
      x1 += fr.x;
      y1 += fr.y;
      x2 += fr.x;
      y2 += fr.y;
    }
  } catch {
    return null;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export class ReaderLinks {
  private states = new Map<any, ReaderState>();

  attach(
    reader: any,
    getRefs: () => RefItem[] | undefined,
    showPopup: LinkPopupHandler,
    onLeave?: () => void,
    showListPopup?: ListPopupHandler,
  ): void {
    const existing = this.states.get(reader);
    if (existing && !existing.cancelled) {
      try {
        if (existing.win?.document) return; // already live
      } catch {
        // dead window — re-attach below
      }
    }
    if (existing) this.teardown(existing);
    const state: ReaderState = { cancelled: false, view: null, win: null };
    this.states.set(reader, state);
    this.setup(reader, state, getRefs, showPopup, onLeave, showListPopup).catch(
      (e) => ztoolkit.log("[readerLinks] attach failed", e),
    );
  }

  detach(reader: any): void {
    const state = this.states.get(reader);
    if (!state) return;
    this.teardown(state);
    this.states.delete(reader);
  }

  detachAll(): void {
    this.states.forEach((state) => this.teardown(state));
    this.states.clear();
  }

  /** drop state for readers that no longer exist (call on tab close) */
  sweep(): void {
    const live = new Set((Zotero.Reader as any)._readers || []);
    for (const [reader, state] of this.states) {
      if (!live.has(reader)) {
        this.teardown(state);
        this.states.delete(reader);
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private teardown(state: ReaderState) {
    state.cancelled = true;
    const view = state.view;
    try {
      if (view) {
        if (state.origNavigate) view.navigate = state.origNavigate;
        if (state.origSetOverlayPopup) {
          view._onSetOverlayPopup = state.origSetOverlayPopup;
        }
      }
    } catch {
      // dead object
    }
    try {
      if (state.win && state.pointerListener) {
        state.win.removeEventListener("pointerup", state.pointerListener, true);
      }
    } catch {
      // dead object
    }
    state.view = null;
    state.win = null;
    state.origNavigate = undefined;
    state.origSetOverlayPopup = undefined;
    state.pointerListener = undefined;
  }

  /** wait for the primary PDFView and its iframe window (~10s) */
  private async resolveView(
    reader: any,
    state: ReaderState,
  ): Promise<{ view: any; win: any } | null> {
    const deadline = Date.now() + READY_TIMEOUT;
    for (;;) {
      if (state.cancelled) return null;
      try {
        const internal = (reader as any)._internalReader;
        const view = internal?._primaryView;
        const win = view?._iframeWindow;
        // PDF views only (EPUB/snapshot views have no PDFViewerApplication)
        if (view && win?.PDFViewerApplication?.pdfDocument) {
          return { view, win };
        }
      } catch {
        // still initializing
      }
      if (Date.now() > deadline) return null;
      await Zotero.Promise.delay(100);
    }
  }

  private async setup(
    reader: any,
    state: ReaderState,
    getRefs: () => RefItem[] | undefined,
    showPopup: LinkPopupHandler,
    onLeave?: () => void,
    showListPopup?: ListPopupHandler,
  ): Promise<void> {
    const resolved = await this.resolveView(reader, state);
    if (!resolved) {
      if (!state.cancelled) {
        ztoolkit.log("[readerLinks] PDF view not ready within 10s");
      }
      return;
    }
    if (state.cancelled) return;
    const { view, win } = resolved;
    state.view = view;
    state.win = win;

    // standalone reader windows never fire a tab-close sweep — release
    // this reader's state (and the patched view) when its window dies
    try {
      win.addEventListener("unload", () => this.detach(reader), {
        once: true,
      });
    } catch {
      // window already tearing down
    }

    // ---------------- hover: our card instead of the native preview
    if (typeof view._onSetOverlayPopup === "function") {
      const orig = view._onSetOverlayPopup;
      state.origSetOverlayPopup = orig;
      view._onSetOverlayPopup = (overlayPopup: any) => {
        try {
          if (state.cancelled) return orig(overlayPopup);
          if (overlayPopup === null || overlayPopup === undefined) {
            onLeave?.();
            return orig(overlayPopup);
          }
          if (
            getPref("hoverLink") &&
            ["internal-link", "citation", "reference"].includes(
              overlayPopup.type,
            )
          ) {
            const refs = getRefs();
            if (refs?.length) {
              const cites = overlayPopup.references;
              // citation clusters ("[6-10]"): take over ONLY when every
              // entry matches a distinct reference — anything less would
              // drop entries the native popup does list
              if (
                showListPopup &&
                Array.isArray(cites) &&
                cites.length > 1 &&
                cites.length <= MAX_CLUSTER
              ) {
                const matched = cites.map((c: any) => refForCitation(refs, c));
                if (
                  matched.every(Boolean) &&
                  new Set(matched).size === matched.length
                ) {
                  const rect = toMainWindowRect(reader, win, overlayPopup.rect);
                  if (rect) {
                    showListPopup(
                      { ...rect, y: rect.y + rect.height },
                      matched as RefItem[],
                    );
                    // suppress the native preview popup
                    return orig(null);
                  }
                }
              }
              let ref: RefItem | null = null;
              // single-entry overlays: match the printed entry text directly
              if (Array.isArray(cites) && cites.length === 1) {
                ref = refForCitation(refs, cites[0]);
              }
              if (!ref && (!Array.isArray(cites) || cites.length <= 1)) {
                const destPos = overlayDestPosition(overlayPopup);
                const destRect = destPos?.rects?.[0];
                if (Array.isArray(destRect)) {
                  ref = nearestRef(
                    refs,
                    destRect[0],
                    destRect[3],
                    typeof destPos.pageIndex === "number"
                      ? destPos.pageIndex
                      : undefined,
                  );
                }
              }
              if (ref) {
                const rect = toMainWindowRect(reader, win, overlayPopup.rect);
                if (rect) {
                  showPopup({ ...rect, y: rect.y + rect.height }, ref);
                  // suppress the native preview popup
                  return orig(null);
                }
              }
            }
          }
        } catch (e) {
          ztoolkit.log("[readerLinks] overlay hook failed", e);
        }
        return orig(overlayPopup);
      };
    }

    // ---------------- click: redirect overlay navigation into the split view
    if (typeof view.navigate === "function") {
      let pendingNav: { position: any; at: number } | null = null;
      const pointerListener = (event: any) => {
        try {
          const pos = view.pointerEventToPosition?.(event);
          const overlay = pos && view._getSelectableOverlay?.(pos);
          const destPos = overlayDestPosition(overlay);
          pendingNav = destPos ? { position: destPos, at: Date.now() } : null;
        } catch {
          pendingNav = null;
        }
      };
      try {
        win.addEventListener("pointerup", pointerListener, true);
        state.pointerListener = pointerListener;
      } catch (e) {
        ztoolkit.log("[readerLinks] pointer listener failed", e);
      }
      const origNavigate = view.navigate.bind(view);
      state.origNavigate = view.navigate;
      view.navigate = (location: any, options?: any) => {
        try {
          if (
            !state.cancelled &&
            getPref("clickLink") &&
            pendingNav &&
            Date.now() - pendingNav.at < NAV_CORRELATION_MS &&
            location?.position &&
            (location.position === pendingNav.position ||
              location.position.pageIndex === pendingNav.position.pageIndex)
          ) {
            const position = location.position;
            pendingNav = null;
            void this.jumpInSecondView(reader, position, state);
            return; // keep the primary view where it is
          }
        } catch (e) {
          ztoolkit.log("[readerLinks] navigate hook failed", e);
        }
        pendingNav = null;
        return origNavigate(location, options);
      };
    }
  }

  /**
   * Navigate to `position` in the second (split) view only, opening the
   * split first if needed (pref `clickLinkCmd`).
   */
  private async jumpInSecondView(
    reader: any,
    position: any,
    state: ReaderState,
  ): Promise<void> {
    try {
      const internal = (reader as any)._internalReader;
      if (!internal) return;
      if (!internal._secondaryView) {
        const cmd = getPref("clickLinkCmd") as string;
        if (cmd === "splitVertically") {
          internal.toggleVerticalSplit?.(true);
        } else {
          internal.toggleHorizontalSplit?.(true);
        }
        const deadline = Date.now() + READY_TIMEOUT;
        while (!internal._secondaryView?._iframeWindow) {
          if (state.cancelled || Date.now() > deadline) return;
          await Zotero.Promise.delay(100);
        }
        // let the fresh view settle before navigating
        await Zotero.Promise.delay(300);
      }
      if (state.cancelled) return;
      internal._secondaryView?.navigate?.({ position });
    } catch (e) {
      ztoolkit.log("[readerLinks] second-view jump failed", e);
    }
  }
}
