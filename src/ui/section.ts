import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { setTimeout, clearTimeout } from "../utils/window";
import { refStorage, itemCacheKey } from "../core/storage";
import { hostIdentifiers, isChinese } from "../core/text";
import { fuseReferences } from "../core/fuse";
import type { RefItem, SourceID } from "../core/types";
import { SOURCE_NAME } from "../core/types";
import { getReferencesByAPI, sources } from "../sources";
import { parsePDFReferences } from "../pdf/parser";
import { runBatchImport } from "./batchImport";
import { renderRefRow, filterRows, closePopup } from "./rows";
import { guard, guardAsync } from "../utils/guard";
import type { RowContext } from "./rows";

/**
 * The "References" item pane section (library + reader), the heart of the
 * plugin.
 *
 * ONE list, two readings fused behind it (core/fuse.ts): the PDF parse is
 * the skeleton — order, numbering, raw text, in-page anchors — and the
 * API result (Crossref → S2 → OpenAlex → CNKI) fills in the metadata each
 * entry lacks, above all the DOI. Whichever side is unavailable (no open
 * reader / no identifiers / offline), the other one alone still renders.
 * The mechanism is deliberately invisible: no source switch, just the
 * contributing sources named next to the count.
 *
 * Interactions:
 *   - refresh click: refresh (cache-first)
 *   - refresh long-press (>=1s): ignore local cache, force re-fetch
 *   - Ctrl+refresh: parse the PDF from the current page backwards (theses)
 *   - double-click on the count label: copy all references
 *   - per-row: copy / edit / locate / import(+) / unlink(−) / hover popup
 * Plus: import-all button, export menu, cached-state indicator, search box.
 *
 * The section body is shared and re-rendered as the user switches items, so
 * every async completion is guarded by an item stamp on the body — a slow
 * fetch for item A must never paint into item B's panel.
 */

interface PanelState {
  stateKey: string;
  refs: RefItem[];
  /** label naming what produced the shown list ("PDF + Crossref", …) */
  sourceUsed?: string;
  loading: boolean;
  importing: boolean;
  loadedOnce: boolean;
}

const states = new Map<string, PanelState>();

/** monotonically increasing id for chunked list renders */
let renderSeq = 0;

function getState(item: Zotero.Item): PanelState {
  const stateKey = itemCacheKey(item);
  let state = states.get(stateKey);
  if (!state) {
    state = {
      stateKey,
      refs: [],
      loading: false,
      importing: false,
      loadedOnce: false,
    };
    // bound per-session memory: drop the oldest items' states
    if (states.size >= 150) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    states.set(stateKey, state);
  }
  return state;
}

/** does the shared section body still show this item? */
function isCurrent(body: HTMLElement, state: PanelState): boolean {
  return body.isConnected && body.dataset.itemKey === state.stateKey;
}

/** the attachment reader open for this top-level item, if any */
function findReaderForItem(item: Zotero.Item): any {
  try {
    for (const reader of (Zotero.Reader as any)._readers || []) {
      const readerItem = (Zotero.Items.get(reader.itemID) || undefined) as
        Zotero.Item | undefined;
      if (
        readerItem?.parentItem?.key === item.key ||
        readerItem?.key === item.key
      ) {
        return reader;
      }
    }
  } catch (e) {
    ztoolkit.log("[section] findReader failed", e);
  }
  return null;
}

/** mark the API-only tail rows so the user can tell them apart */
function tagTail(refs: RefItem[], tailStart: number) {
  for (let i = tailStart; i < refs.length; i++) {
    refs[i] = {
      ...refs[i],
      tags: [
        ...(refs[i].tags || []),
        { text: "API", color: "#2da44e", tip: getString("row-api-only-tip") },
      ],
    };
  }
}

/** may caching be used at all (either layer enabled)? */
function cachingEnabled(): boolean {
  return !!(getPref("savePDFReferences") || getPref("saveAPIReferences"));
}

async function fetchReferences(
  item: Zotero.Item,
  state: PanelState,
  options: { useCache: boolean; fromCurrentPage: boolean },
): Promise<RefItem[]> {
  // fused fast path (plain click); Ctrl = re-parse from the current page,
  // which must not be answered from cache
  if (options.useCache && !options.fromCurrentPage) {
    const fused = await refStorage.get(item, "FUSED");
    if (fused?.length) {
      new ztoolkit.ProgressWindow("[Local] References", {
        closeOtherProgressWindows: true,
      })
        .createLine({
          text: `${fused.length} ${getString("panel-count-suffix")} (${getString("panel-cached")})`,
          type: "success",
        })
        .show();
      state.sourceUsed = getString("panel-cached");
      return fused;
    }
  }
  const reader = findReaderForItem(item);
  const popupWin = new ztoolkit.ProgressWindow("[Pending] References", {
    closeTime: -1,
    closeOtherProgressWindows: true,
  });
  popupWin.createLine({
    text: `PDF: ${reader ? getString("panel-parsing") : "—"}`,
    type: "default",
    progress: reader ? 1 : 100,
  });
  popupWin.createLine({
    text: `API: ${getString("panel-requesting")}`,
    type: "default",
  });
  popupWin.show();

  const pdfPromise = (async (): Promise<RefItem[]> => {
    if (options.useCache && !options.fromCurrentPage) {
      const cached = await refStorage.get(item, "PDF");
      if (cached?.length) {
        popupWin.changeLine({
          idx: 0,
          text: `PDF: ${cached.length} (${getString("panel-cached")})`,
          type: "success",
          progress: 100,
        });
        return cached;
      }
    }
    if (!reader) return [];
    try {
      const refs = await parsePDFReferences(reader, {
        fromCurrentPage: options.fromCurrentPage,
        onProgress: (message, pct) =>
          popupWin.changeLine({
            idx: 0,
            text: `PDF: ${message}`,
            progress: pct,
          }),
      });
      popupWin.changeLine({
        idx: 0,
        text: `PDF: ${refs.length} ${getString("panel-count-suffix")}`,
        type: refs.length ? "success" : "fail",
        progress: 100,
      });
      if (refs.length && getPref("savePDFReferences")) {
        void refStorage.set(item, "PDF", refs);
      }
      return refs;
    } catch (e) {
      ztoolkit.log("[section] PDF parse failed", e);
      popupWin.changeLine({
        idx: 0,
        text: "PDF: ✗",
        type: "fail",
        progress: 100,
      });
      return [];
    }
  })();

  const apiPromise = (async (): Promise<{
    refs: RefItem[];
    source: string;
  } | null> => {
    if (options.useCache) {
      const cached = await refStorage.get(item, "API");
      if (cached?.length) {
        const source = (cached[0]?.source as string) || "crossref";
        popupWin.changeLine({
          idx: 1,
          text: `API: ${cached.length} (${getString("panel-cached")})`,
          type: "success",
        });
        return { refs: cached, source };
      }
    }
    const result = await getReferencesByAPI(item, (msg) =>
      popupWin.changeLine({ idx: 1, text: `API: ${msg}` }),
    );
    if (!result) {
      popupWin.changeLine({
        idx: 1,
        text: `API: ${getString("panel-api-fail")}`,
        type: "fail",
      });
      return null;
    }
    // stamp the producing source on every record: the cache keeps it, the
    // row badge shows it, and the fusion needs it (positional alignment is
    // trusted for Crossref order only)
    for (const r of result.refs) {
      r.source = (r.source ?? result.source) as SourceID;
    }
    popupWin.changeLine({
      idx: 1,
      text: `API: ${result.refs.length} (${SOURCE_NAME[result.source] || result.source})`,
      type: "success",
    });
    if (result.refs.length && getPref("saveAPIReferences")) {
      void refStorage.set(item, "API", result.refs);
    }
    return result;
  })();

  const [pdfRefs, api] = await Promise.all([pdfPromise, apiPromise]);
  if (!pdfRefs.length && !api?.refs.length) {
    popupWin.changeHeadline("[Fail] References");
    if (!reader) {
      popupWin.changeLine({
        idx: 0,
        text: getString("panel-no-source"),
        type: "fail",
        progress: 100,
      });
    }
    popupWin.startCloseTimer(3000);
    return [];
  }

  const { refs, tailStart, stats } = await fuseReferences(
    pdfRefs,
    api?.refs ?? [],
    api?.source ?? null,
    (doi) => sources.crossref.getInfoByDOI!(doi),
  );
  tagTail(refs, tailStart);
  ztoolkit.log(
    `[section] fused pdf=${pdfRefs.length} api=${api?.refs.length ?? 0} -> ${refs.length} (id=${stats.id} title=${stats.title} volPage=${stats.volPage} pos=${stats.positional} [${stats.posMode}] unmatched=${stats.unmatched} appended=${stats.appended})`,
  );
  const parts: string[] = [];
  if (pdfRefs.length) parts.push("PDF");
  if (api?.refs.length) parts.push(SOURCE_NAME[api.source] || api.source);
  state.sourceUsed = parts.join(" + ");
  popupWin.changeHeadline("[Done] References");
  popupWin.startCloseTimer(3000);
  if (refs.length && cachingEnabled()) {
    void refStorage.set(item, "FUSED", refs);
  }
  return refs;
}

function copyAll(state: PanelState) {
  const texts = state.refs.map(
    (r, i) => `[${r.number || i + 1}] ${r.text || r.title || ""}`,
  );
  new ztoolkit.Clipboard().addText(texts.join("\n"), "text/unicode").copy();
  new ztoolkit.ProgressWindow("References")
    .createLine({ text: getString("panel-copy-all-done"), type: "success" })
    .show();
}

function exportRefs(state: PanelState, format: "text" | "markdown" | "csv") {
  let out: string;
  if (format === "text") {
    out = state.refs
      .map((r, i) => `[${r.number || i + 1}] ${r.text || r.title || ""}`)
      .join("\n");
  } else if (format === "markdown") {
    out = state.refs
      .map((r, i) => {
        const label = r.text || r.title || "";
        const url =
          r.url ||
          (r.identifiers.DOI ? `https://doi.org/${r.identifiers.DOI}` : "");
        return url
          ? `${r.number || i + 1}. [${label}](${url})`
          : `${r.number || i + 1}. ${label}`;
      })
      .join("\n");
  } else {
    const esc = (s?: string | number) =>
      `"${String(s ?? "").replace(/"/g, '""')}"`;
    out = [
      "number,title,authors,year,venue,doi,url,text",
      ...state.refs.map((r, i) =>
        [
          r.number || i + 1,
          esc(r.title),
          esc(r.authors?.join("; ")),
          esc(r.year),
          esc(r.primaryVenue),
          esc(r.identifiers.DOI),
          esc(r.url),
          esc(r.text),
        ].join(","),
      ),
    ].join("\n");
  }
  new ztoolkit.Clipboard().addText(out, "text/unicode").copy();
  new ztoolkit.ProgressWindow("References")
    .createLine({
      text: `${getString("panel-export-done")} (${format})`,
      type: "success",
    })
    .show();
}

/** keyword AND-filter over refs (same semantics as filterRows) */
function matchesKeyword(ref: RefItem, index: number, keyword: string): boolean {
  const keywords = keyword
    .split(/[ ,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (!keywords.length) return true;
  const content = `[${ref.number || index + 1}] ${
    ref.text || ref.title || ""
  }`.toLowerCase();
  return keywords.every((k) => content.includes(k));
}

function renderList(
  body: HTMLElement,
  item: Zotero.Item,
  state: PanelState,
  setSectionSummary: (s: string) => void,
) {
  if (!isCurrent(body, state)) return;
  const list = body.querySelector<HTMLElement>(".references-list");
  const count = body.querySelector<HTMLElement>(".references-count");
  if (!list || !count) return;
  closePopup();
  list.textContent = "";
  count.textContent = `${state.refs.length} ${getString("panel-count-suffix")}${
    state.sourceUsed ? ` · ${state.sourceUsed}` : ""
  }`;
  setSectionSummary(`${state.refs.length}`);
  const ctx: RowContext = {
    hostItem: item,
    list,
    numbered: true,
    editable: true,
    onEdited: (ref, index) => {
      state.refs[index] = ref;
      // the shown (fused) list is what the user edited — persist it there
      if (cachingEnabled()) void refStorage.set(item, "FUSED", state.refs);
    },
  };
  // chunked rendering keeps the pane responsive for long bibliographies.
  // The token cancels any older chunk chain still scheduled for this same
  // list (same item re-rendered) — without it two chains interleave rows.
  const token = String(++renderSeq);
  list.dataset.renderToken = token;
  const CHUNK = 25;
  let i = 0;
  const renderChunk = () => {
    if (!list.isConnected || !isCurrent(body, state)) return;
    if (list.dataset.renderToken !== token) return;
    const end = Math.min(i + CHUNK, state.refs.length);
    for (; i < end; i++) {
      renderRefRow(ctx, state.refs, i);
    }
    // keep the active filter applied to every chunk as it lands
    const search = body.querySelector<HTMLInputElement>(
      ".references-search input",
    );
    if (search?.value) filterRows(list, search.value);
    if (i < state.refs.length) setTimeout(renderChunk, 0);
  };
  renderChunk();
}

async function refresh(
  body: HTMLElement,
  item: Zotero.Item,
  state: PanelState,
  setSectionSummary: (s: string) => void,
  options: { useCache: boolean; fromCurrentPage: boolean },
) {
  if (state.loading) return;
  state.loading = true;
  try {
    const refs = await fetchReferences(item, state, options);
    if (!refs.length && !state.refs.length) {
      state.loadedOnce = true;
      return;
    }
    state.refs = refs;
    state.loadedOnce = true;
    renderList(body, item, state, setSectionSummary);
  } catch (e) {
    ztoolkit.log("[section] refresh failed", e);
    new ztoolkit.ProgressWindow("[Fail] References", {
      closeOtherProgressWindows: true,
    })
      .createLine({ text: String(e), type: "fail" })
      .show();
  } finally {
    state.loading = false;
  }
}

function buildToolbar(
  body: HTMLElement,
  item: Zotero.Item,
  state: PanelState,
  setSectionSummary: (s: string) => void,
) {
  const doc = body.ownerDocument!;
  const toolbar = doc.createElement("div");
  toolbar.className = "references-toolbar";

  const count = doc.createElement("span");
  count.className = "references-count";
  count.textContent = `0 ${getString("panel-count-suffix")}`;
  count.title = getString("panel-copy-all-tip");
  count.addEventListener("dblclick", () => copyAll(state));
  toolbar.append(count);

  const spacer = doc.createElement("span");
  spacer.className = "references-spacer";
  toolbar.append(spacer);

  const mkIconButton = (iconClass: string, tip: string) => {
    const button = doc.createElement("button");
    button.className = `references-button references-icon-button ${iconClass}`;
    button.title = tip;
    toolbar.append(button);
    return button;
  };

  // refresh with click / long-press / ctrl semantics (ported)
  const refreshButton = mkIconButton(
    "references-icon-refresh",
    getString("panel-refresh-tip"),
  );
  let pressTimer: number | undefined;
  refreshButton.addEventListener("mousedown", (event: MouseEvent) => {
    const fromCurrentPage = event.ctrlKey || event.metaKey;
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      void refresh(body, item, state, setSectionSummary, {
        useCache: false,
        fromCurrentPage,
      });
    }, 1000);
  });
  refreshButton.addEventListener("mouseup", (event: MouseEvent) => {
    if (pressTimer === undefined) return;
    clearTimeout(pressTimer);
    pressTimer = undefined;
    // plain click refreshes the CURRENT source — switching PDF/API is the
    // badge's job; auto-toggling here silently negated the user's choice
    void refresh(body, item, state, setSectionSummary, {
      useCache: true,
      fromCurrentPage: event.ctrlKey || event.metaKey,
    });
  });
  refreshButton.addEventListener("mouseleave", () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  });

  const importButton = mkIconButton(
    "references-icon-import",
    getString("panel-import-all-tip"),
  );
  importButton.addEventListener("click", async () => {
    if (!state.refs.length || state.importing) return;
    const keyword =
      body.querySelector<HTMLInputElement>(".references-search input")?.value ||
      "";
    // filter applied to the DATA, not to rendered rows (chunked rendering
    // may not have painted everything yet)
    const targets = state.refs.filter((ref, i) =>
      matchesKeyword(ref, i, keyword),
    );
    if (!targets.length) return;
    state.importing = true;
    importButton.disabled = true;
    try {
      const result = await runBatchImport(
        item,
        targets,
        getString("panel-import-all"),
      );
      if (!result) return; // declined
    } finally {
      state.importing = false;
      importButton.disabled = false;
    }
    renderList(body, item, state, setSectionSummary);
  });

  const exportButton = mkIconButton(
    "references-icon-copy",
    getString("panel-export-tip"),
  );
  exportButton.addEventListener("click", (event: MouseEvent) => {
    if (event.shiftKey) exportRefs(state, "csv");
    else if (event.ctrlKey || event.metaKey) exportRefs(state, "markdown");
    else exportRefs(state, "text");
  });

  body.append(toolbar);

  // search box
  const searchBox = doc.createElement("div");
  searchBox.className = "references-search";
  const input = doc.createElement("input");
  input.placeholder = getString("panel-search-placeholder");
  input.addEventListener("input", () => {
    const list = body.querySelector<HTMLElement>(".references-list");
    if (list) filterRows(list, input.value);
  });
  searchBox.append(input);
  body.append(searchBox);
}

export function registerReferencesSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "references",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-references-head-text"),
      icon: `chrome://${config.addonRef}/content/icons/references.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-references-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/20/references.svg`,
    },
    onItemChange: guard("references.onItemChange", ({ item, setEnabled }) => {
      setEnabled(!!item?.isRegularItem?.());
      return true;
    }),
    onRender: () => {},
    onAsyncRender: guardAsync(
      "references.onAsyncRender",
      async ({ body, item, setSectionSummary }) => {
        if (!item?.isRegularItem?.()) return;
        const state = getState(item);
        // (re)build DOM for this item; the stamp guards all later async work
        body.textContent = "";
        (body as HTMLElement).dataset.itemKey = state.stateKey;
        (body as HTMLElement).classList.add("references-panel");
        buildToolbar(body as HTMLElement, item, state, setSectionSummary);
        const list = body.ownerDocument!.createElement("div");
        list.className = "references-list";
        body.append(list);
        if (state.refs.length) {
          renderList(body as HTMLElement, item, state, setSectionSummary);
          return;
        }
        if (state.loadedOnce) return;
        // cache-first initial fill: the fused list if we have it, else
        // fuse whatever raw layers are cached (offline, no network)
        const fused = await refStorage.get(item, "FUSED");
        if (!isCurrent(body as HTMLElement, state)) return;
        if (fused?.length) {
          state.refs = fused;
          state.loadedOnce = true;
          state.sourceUsed = getString("panel-cached");
          renderList(body as HTMLElement, item, state, setSectionSummary);
          return;
        }
        const [cachedPDF, cachedAPI] = await Promise.all([
          refStorage.get(item, "PDF"),
          refStorage.get(item, "API"),
        ]);
        if (!isCurrent(body as HTMLElement, state)) return;
        if (cachedPDF?.length || cachedAPI?.length) {
          const { refs, tailStart } = await fuseReferences(
            cachedPDF ?? [],
            cachedAPI ?? [],
            (cachedAPI?.[0]?.source as string) ?? null,
          );
          if (!isCurrent(body as HTMLElement, state)) return;
          tagTail(refs, tailStart);
          state.refs = refs;
          state.loadedOnce = true;
          state.sourceUsed = getString("panel-cached");
          if (cachingEnabled()) void refStorage.set(item, "FUSED", refs);
          renderList(body as HTMLElement, item, state, setSectionSummary);
          return;
        }
        if (getPref("autoRefresh")) {
          const excluded = (getPref("notAutoRefreshItemTypes") as string)
            .split(/,\s*/)
            .map((s) => s.trim());
          if (excluded.includes(item.itemType)) return;
          // without an open reader only the API side can answer — skip
          // silently when it cannot (no popup spam while browsing)
          if (!findReaderForItem(item)) {
            const ids = hostIdentifiers(item);
            const title = (item.getField("title") as string) || "";
            if (!ids.DOI && !ids.PMID && !ids.arXiv && !isChinese(title)) {
              return;
            }
          }
          // Settle debounce OUTSIDE the awaited render: Zotero awaits each
          // pane's asyncRender in sequence, so sleeping here would delay the
          // whole item pane. Schedule the fetch and return at once; rapid
          // arrow-key browsing then never fires a request per item.
          setTimeout(
            guard("references.autoFetch", () => {
              if (!isCurrent(body as HTMLElement, state)) return;
              void refresh(
                body as HTMLElement,
                item,
                state,
                setSectionSummary,
                {
                  useCache: true,
                  fromCurrentPage: false,
                },
              );
            }),
            350,
          );
        }
      },
    ),
  });
}

/** current parsed references of an item (used by the reader link hover) */
export function getRefsForItem(item: Zotero.Item): RefItem[] | undefined {
  const state = states.get(itemCacheKey(item));
  return state?.refs.length ? state.refs : undefined;
}

/** drop cached panel state (called on notifier item deletes) */
export function invalidatePanelState(stateKeys?: string[]) {
  if (!stateKeys) {
    states.clear();
    return;
  }
  for (const key of stateKeys) states.delete(key);
}
