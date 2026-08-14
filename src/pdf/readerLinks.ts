import { config } from "../../package.json";
import type { RefItem } from "../core/types";
import { getPref } from "../utils/prefs";

/**
 * In-PDF citation link enhancement (ported from zotero-reference views.ts
 * pdfLinks / registerSplitButtons).
 *
 * - Internal link annotations ("[12]"-style citation links) get:
 *   - click → jump to the destination in a SECOND (split) view, keeping the
 *     reading position in the primary view (pref `clickLink`);
 *   - hover → popup with the matched reference entry (pref `hoverLink`).
 * - Two split-view toolbar buttons are inserted into the pdf.js toolbar.
 *
 * Anchors are discovered with one initial scan plus a MutationObserver on the
 * viewer container (pdf.js re-renders annotation layers per page), never a
 * polling interval. Processed anchors are marked with a data attribute.
 */

export interface LinkPopupHandler {
  (
    anchorRect: { x: number; y: number; width: number; height: number },
    ref: RefItem,
  ): void;
}

/** marker attribute on anchors we already processed */
const PROCESSED_ATTR = "data-references-link";
const SPLIT_BUTTONS_ID = "references-split-buttons";
/** how long to wait for the pdf.js iframe / second view to come up */
const READY_TIMEOUT = 10000;
const SCAN_DEBOUNCE = 200;

interface ReaderState {
  cancelled: boolean;
  /** pdf.js iframe window (once resolved) */
  win: any;
  observer: any;
  /** debounced re-scan timer id (on the pdf.js window) */
  debounceId: number | null;
  /** pending hover-popup timer ids (on the pdf.js window) */
  hoverTimers: Set<number>;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** reference whose stored PDF anchor (x, y) is nearest to the destination */
function nearestRef(refs: RefItem[], x: number, y: number): RefItem | null {
  let best: RefItem | null = null;
  let bestD = Infinity;
  for (const ref of refs) {
    if (typeof ref.x !== "number" || typeof ref.y !== "number") continue;
    const d = (x - ref.x) ** 2 + (y - ref.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = ref;
    }
  }
  return best;
}

export class ReaderLinks {
  private states = new Map<any, ReaderState>();

  attach(
    reader: any,
    getRefs: () => RefItem[] | undefined,
    showPopup: LinkPopupHandler,
  ): void {
    // re-attach: tear the old state down (also unmarks processed anchors so
    // the fresh scan re-binds live listeners; the old ones are inert).
    const existing = this.states.get(reader);
    if (existing) this.teardown(existing);
    const state: ReaderState = {
      cancelled: false,
      win: null,
      observer: null,
      debounceId: null,
      hoverTimers: new Set(),
    };
    this.states.set(reader, state);
    this.setup(reader, state, getRefs, showPopup).catch((e) =>
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

  // ---------------------------------------------------------------- internals

  private teardown(state: ReaderState) {
    state.cancelled = true;
    try {
      state.observer?.disconnect();
    } catch {
      // observer's window already gone
    }
    state.observer = null;
    const win = state.win;
    if (win) {
      try {
        if (state.debounceId !== null) win.clearTimeout(state.debounceId);
        state.hoverTimers.forEach((id) => win.clearTimeout(id));
        // unmark so a later attach() re-processes the anchors
        win.document
          .querySelectorAll(`[${PROCESSED_ATTR}]`)
          .forEach((el: Element) => el.removeAttribute(PROCESSED_ATTR));
      } catch {
        // dead object — the iframe took the timers/marks with it
      }
    }
    state.debounceId = null;
    state.hoverTimers.clear();
    state.win = null;
  }

  /** PDFViewerApplication of a pdf.js window, xray-tolerant */
  private pdfApp(win: any): any {
    try {
      return (
        win?.PDFViewerApplication ?? win?.wrappedJSObject?.PDFViewerApplication
      );
    } catch {
      return null;
    }
  }

  /** the split (second) view window, if any */
  private secondViewWin(win: any): any {
    try {
      return (
        win?.secondViewIframeWindow ??
        win?.wrappedJSObject?.secondViewIframeWindow ??
        null
      );
    } catch {
      return null;
    }
  }

  /** poll until the pdf.js iframe window has a loaded document (~10s) */
  private async resolvePdfWindow(
    reader: any,
    state: ReaderState,
  ): Promise<any> {
    const deadline = Date.now() + READY_TIMEOUT;
    for (;;) {
      if (state.cancelled) return null;
      try {
        const internal = (reader as any)._internalReader;
        const view =
          internal?._primaryView ??
          internal?._lastView ??
          internal?._views?.[0];
        const win = view?._iframeWindow;
        if (win && this.pdfApp(win)?.pdfDocument) return win;
      } catch {
        // reader still initializing / dead wrapper — keep polling
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
  ): Promise<void> {
    const win = await this.resolvePdfWindow(reader, state);
    if (!win) {
      if (!state.cancelled) {
        ztoolkit.log("[readerLinks] pdf.js window not ready within 10s");
      }
      return;
    }
    if (state.cancelled) return;
    state.win = win;

    this.addSplitButtons(reader, win);

    // named/explicit destinations: destName -> [pageRef, {name}, x, y, zoom]
    let dests: Record<string, any> = {};
    try {
      dests =
        (await this.pdfApp(win).pdfDocument._transport.getDestinations()) ?? {};
    } catch (e) {
      ztoolkit.log("[readerLinks] getDestinations failed", e);
    }
    if (state.cancelled) return;

    const scan = () =>
      this.processAnchors(reader, state, dests, getRefs, showPopup);
    const scheduleScan = () => {
      if (state.cancelled) return;
      try {
        if (state.debounceId !== null) win.clearTimeout(state.debounceId);
        state.debounceId = win.setTimeout(() => {
          state.debounceId = null;
          scan();
        }, SCAN_DEBOUNCE);
      } catch (e) {
        // iframe navigated away / died — stop cleanly
        ztoolkit.log("[readerLinks] debounce failed (window gone?)", e);
        this.teardown(state);
      }
    };

    scan();

    try {
      const container =
        win.document.querySelector("#viewerContainer") ?? win.document.body;
      const MO = win.MutationObserver;
      if (container && MO) {
        state.observer = new MO(scheduleScan);
        state.observer.observe(container, { childList: true, subtree: true });
      } else {
        ztoolkit.log(
          "[readerLinks] no viewer container / MutationObserver; single scan",
        );
      }
    } catch (e) {
      ztoolkit.log("[readerLinks] observer setup failed", e);
    }
  }

  /** bind click/hover behavior to not-yet-processed internal link anchors */
  private processAnchors(
    reader: any,
    state: ReaderState,
    dests: Record<string, any>,
    getRefs: () => RefItem[] | undefined,
    showPopup: LinkPopupHandler,
  ): void {
    const win = state.win;
    if (!win || state.cancelled) return;
    let anchors: any;
    try {
      anchors = win.document.querySelectorAll(
        `section.linkAnnotation > a[href^='#']:not([${PROCESSED_ATTR}])`,
      );
    } catch (e) {
      ztoolkit.log("[readerLinks] scan failed (window gone?)", e);
      this.teardown(state);
      return;
    }
    const clickEnabled = !!getPref("clickLink");
    const hoverEnabled = !!getPref("hoverLink");
    anchors.forEach((a: any) => {
      try {
        a.setAttribute(PROCESSED_ATTR, "1");
        const href: string = a.getAttribute("href") || "";
        // figure links jump to figures, not references — leave them alone
        if (href.includes("fig")) return;
        const dest = safeDecode(href.slice(1));

        if (clickEnabled) {
          // pdf.js binds the primary-view jump via the onclick property;
          // neutralize it so the click only jumps in the second view.
          a.onclick = null;
          a.style.cursor = "pointer";
          a.addEventListener(
            "click",
            (event: MouseEvent) => {
              if (state.cancelled) return;
              event.preventDefault();
              event.stopPropagation();
              this.jumpInSecondView(reader, win, dest, state).catch((e) =>
                ztoolkit.log("[readerLinks] second-view jump failed", e),
              );
            },
            true,
          );
        }

        if (hoverEnabled) {
          let hoverId: number | undefined;
          a.addEventListener("mouseenter", () => {
            if (state.cancelled) return;
            const refs = getRefs();
            if (!refs?.length) return;
            const destArr = dests[dest] ?? dests[href.slice(1)];
            if (!destArr) return;
            // destination array: [pageRef, {name}, x, y, zoom]
            const [x, y] = Array.prototype.slice.call(destArr, 2, 4);
            if (typeof x !== "number" || typeof y !== "number") return;
            const ref = nearestRef(refs, x, y);
            if (!ref) return;
            const delay = Number(getPref("popupDelay")) || 233;
            try {
              const id = win.setTimeout(() => {
                state.hoverTimers.delete(id);
                hoverId = undefined;
                if (state.cancelled) return;
                let rect: DOMRect;
                try {
                  rect = a.getBoundingClientRect();
                } catch {
                  return;
                }
                showPopup(
                  {
                    x: rect.x,
                    y: rect.y + 40,
                    width: rect.width,
                    height: rect.height,
                  },
                  ref,
                );
              }, delay);
              hoverId = id;
              state.hoverTimers.add(id);
            } catch (e) {
              ztoolkit.log("[readerLinks] hover timer failed", e);
            }
          });
          a.addEventListener("mouseleave", () => {
            if (hoverId === undefined) return;
            try {
              win.clearTimeout(hoverId);
            } catch {
              // window gone — nothing to clear
            }
            state.hoverTimers.delete(hoverId);
            hoverId = undefined;
            // the popup manages its own removal after it is shown
          });
        }
      } catch (e) {
        ztoolkit.log("[readerLinks] anchor processing failed", e);
      }
    });
  }

  /**
   * Jump to `dest` in the second (split) view only, opening the split first
   * if needed (pref `clickLinkCmd`: splitHorizontally / splitVertically).
   */
  private async jumpInSecondView(
    reader: any,
    win: any,
    dest: string,
    state: ReaderState,
  ): Promise<void> {
    try {
      if (!this.secondViewWin(win)) {
        await reader.menuCmd(getPref("clickLinkCmd") as string);
        const deadline = Date.now() + READY_TIMEOUT;
        while (!this.pdfApp(this.secondViewWin(win))?.pdfDocument) {
          if (state.cancelled || Date.now() > deadline) return;
          await Zotero.Promise.delay(100);
        }
        // give the fresh view a moment to settle before jumping
        await Zotero.Promise.delay(1000);
      }
      const second = this.secondViewWin(win);
      if (!second || state.cancelled) return;
      try {
        // strings cross the xray boundary fine — no eval needed normally
        second.wrappedJSObject?.PDFViewerApplication?.pdfViewer?.linkService?.goToDestination?.(
          dest,
        );
      } catch (e) {
        // #39 workaround: some sandboxes only accept the jump via eval
        ztoolkit.log("[readerLinks] goToDestination failed, eval fallback", e);
        second.eval(
          `PDFViewerApplication.pdfViewer.linkService.goToDestination(${JSON.stringify(
            dest,
          )})`,
        );
      }
    } catch (e) {
      ztoolkit.log("[readerLinks] second-view jump failed", e);
    }
  }

  /** two split-view buttons before #pageNumber in the pdf.js toolbar */
  private addSplitButtons(reader: any, win: any): void {
    try {
      const doc = win.document as Document;
      const toolbar = doc.querySelector("#toolbarViewerLeft");
      const anchor = toolbar?.querySelector("#pageNumber");
      if (!toolbar || !anchor) return; // toolbar layout unknown — skip
      if (doc.getElementById(SPLIT_BUTTONS_ID)) return; // never duplicate
      const baseStyles = {
        backgroundSize: "16px 16px",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        width: "16px",
      };
      const cmdButton = (
        id: string,
        icon: string,
        title: string,
        cmd: string,
        extraStyles: Record<string, string>,
      ) => ({
        tag: "button",
        namespace: "html" as const,
        id,
        classList: ["toolbarButton"],
        styles: {
          backgroundImage: `url(chrome://${config.addonRef}/content/icons/${icon})`,
          ...extraStyles,
          ...baseStyles,
        },
        attributes: { title, tabindex: "-1" },
        listeners: [
          {
            type: "click",
            listener: () => {
              try {
                reader.menuCmd(cmd);
              } catch (e) {
                ztoolkit.log(`[readerLinks] ${cmd} failed`, e);
              }
            },
          },
        ],
      });
      ztoolkit.UI.insertElementBefore(
        {
          tag: "div",
          id: SPLIT_BUTTONS_ID,
          classList: ["splitToolbarButton"],
          children: [
            cmdButton(
              "references-split-horizontally",
              "horizontally.png",
              "Split Horizontally",
              "splitHorizontally",
              { marginRight: "1px" },
            ),
            cmdButton(
              "references-split-vertically",
              "split.png",
              "Split Vertically",
              "splitVertically",
              { marginLeft: "0" },
            ),
          ],
        },
        anchor,
      );
    } catch (e) {
      ztoolkit.log("[readerLinks] split buttons failed", e);
    }
  }
}
