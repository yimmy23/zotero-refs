import { getPref } from "../utils/prefs";

/**
 * Optional Alt/Option+click split navigation, built on Zotero 7+'s reader
 * overlay pipeline (the pdf.js annotation layer is hidden by the reader's
 * CSS — Zotero renders internal links / citations through its own overlay
 * system).
 *
 * Verified against the Zotero 9.0.6 and 10.0 reader bundles:
 *   - click: PDFView pointer-up resolves `_getSelectableOverlay(position)`
 *     and calls `this.navigate({ position })` for internal links/citations.
 *   - split view: `internal.toggleHorizontalSplit(true)` /
 *     `toggleVerticalSplit(true)`; the second view is
 *     `internal._secondaryView` (a PDFView with `navigate(location)`).
 *     (`reader.menuCmd` no longer exists in Zotero 9.)
 *
 * Ordinary clicks always use Zotero's native navigation. With clickLink
 * enabled, only Alt/Option+left-click can redirect an overlay destination
 * to a split view; outline / back-button navigation stays untouched.
 *
 * Hover previews are deliberately NOT touched: reader citation popups
 * stay native (user decision, 2026-08-25) — the plugin must not wrap
 * `_onSetOverlayPopup`.
 */

const READY_TIMEOUT = 10000;
/** Max ms between an explicit split gesture and the navigate() it triggers. */
const NAV_CORRELATION_MS = 300;

interface ReaderState {
  cancelled: boolean;
  view: any;
  /** pdf.js iframe window */
  win: any;
  origNavigate?: any;
  wrappedNavigate?: any;
  pointerListener?: (event: any) => void;
  unloadListener?: () => void;
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

export class ReaderLinks {
  private states = new Map<any, ReaderState>();

  attach(reader: any): void {
    const existing = this.states.get(reader);
    if (existing && !existing.cancelled) {
      try {
        // "already live" must mean OUR wrap is on the CURRENT view: the
        // reader can swap `_primaryView` during init, leaving a stale
        // wrapped view behind (observed intermittently on Zotero 10) —
        // verify identity and the wrap marker, else tear down and redo
        const cur = (reader as any)._internalReader?._primaryView;
        if (
          existing.win?.document &&
          existing.view &&
          existing.view === cur &&
          typeof cur?.navigate === "function" &&
          cur.navigate === existing.wrappedNavigate
        ) {
          return; // already live on the current view
        }
      } catch {
        // dead window — re-attach below
      }
    }
    if (existing) this.teardown(existing);
    const state: ReaderState = { cancelled: false, view: null, win: null };
    this.states.set(reader, state);
    this.setup(reader, state).catch((e) =>
      ztoolkit.log("[readerLinks] attach failed", e),
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
      if (
        view &&
        state.origNavigate &&
        view.navigate === state.wrappedNavigate
      ) {
        view.navigate = state.origNavigate;
      }
    } catch {
      // dead object
    }
    try {
      if (state.win && state.pointerListener) {
        state.win.removeEventListener("pointerup", state.pointerListener, true);
      }
      if (state.win && state.unloadListener) {
        state.win.removeEventListener("unload", state.unloadListener);
      }
    } catch {
      // dead object
    }
    state.view = null;
    state.win = null;
    state.origNavigate = undefined;
    state.wrappedNavigate = undefined;
    state.pointerListener = undefined;
    state.unloadListener = undefined;
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

  private async setup(reader: any, state: ReaderState): Promise<void> {
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
      state.unloadListener = () => {
        if (this.states.get(reader) === state) this.detach(reader);
      };
      win.addEventListener("unload", state.unloadListener, {
        once: true,
      });
    } catch {
      // window already tearing down
    }

    // Only explicit split gestures may authorize one matching navigation.
    if (typeof view.navigate === "function") {
      let pendingNav: { destination: string; at: number } | null = null;
      const pointerListener = (event: any) => {
        pendingNav = null;
        try {
          if (
            state.cancelled ||
            !getPref("clickLink") ||
            event.button !== 0 ||
            !event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          const pos = view.pointerEventToPosition?.(event);
          const overlay = pos && view._getSelectableOverlay?.(pos);
          const destPos = overlayDestPosition(overlay);
          // Snapshot the complete destination, not just its page: other
          // navigations on that page must not inherit the split gesture.
          if (destPos) {
            const destination = JSON.stringify(destPos);
            if (destination) pendingNav = { destination, at: Date.now() };
          }
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
      state.wrappedNavigate = (location: any, options?: any) => {
        const gesture = pendingNav;
        pendingNav = null;
        try {
          if (
            !state.cancelled &&
            this.states.get(reader) === state &&
            reader._internalReader?._primaryView === view &&
            getPref("clickLink") &&
            gesture &&
            Date.now() - gesture.at < NAV_CORRELATION_MS &&
            location?.position &&
            JSON.stringify(location.position) === gesture.destination
          ) {
            const position = location.position;
            void this.jumpInSecondView(reader, position, state)
              .then((jumped) => {
                if (
                  !jumped &&
                  !state.cancelled &&
                  this.states.get(reader) === state &&
                  reader._internalReader?._primaryView === view
                ) {
                  // A split that cannot open must not swallow the click.
                  return origNavigate(location, options);
                }
              })
              .catch((e) =>
                ztoolkit.log("[readerLinks] fallback navigation failed", e),
              );
            return; // keep the primary view where it is
          }
        } catch (e) {
          ztoolkit.log("[readerLinks] navigate hook failed", e);
        }
        // Keep the original return value and synchronous call timing.
        return origNavigate(location, options);
      };
      view.navigate = state.wrappedNavigate;
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
  ): Promise<boolean> {
    try {
      const internal = (reader as any)._internalReader;
      const ownsView = () =>
        !state.cancelled &&
        this.states.get(reader) === state &&
        reader._internalReader === internal &&
        internal?._primaryView === state.view;
      if (!internal || !ownsView()) return false;
      if (!internal._secondaryView) {
        const cmd = getPref("clickLinkCmd") as string;
        if (cmd === "splitVertically") {
          if (typeof internal.toggleVerticalSplit !== "function") return false;
          await internal.toggleVerticalSplit(true);
        } else {
          if (typeof internal.toggleHorizontalSplit !== "function")
            return false;
          await internal.toggleHorizontalSplit(true);
        }
        const deadline = Date.now() + READY_TIMEOUT;
        while (!internal._secondaryView?._iframeWindow) {
          if (!ownsView() || Date.now() > deadline) return false;
          await Zotero.Promise.delay(100);
        }
        // let the fresh view settle before navigating
        await Zotero.Promise.delay(300);
      }
      if (
        !ownsView() ||
        typeof internal._secondaryView?.navigate !== "function"
      )
        return false;
      await internal._secondaryView.navigate({ position });
      return true;
    } catch (e) {
      ztoolkit.log("[readerLinks] second-view jump failed", e);
      return false;
    }
  }
}
