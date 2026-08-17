import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { setTimeout, clearTimeout } from "../utils/window";
import { refStorage, itemCacheKey } from "../core/storage";
import { isChinese } from "../core/text";
import type { RefItem } from "../core/types";
import { getReferencesByAPI } from "../sources";
import { parsePDFReferences } from "../pdf/parser";
import { importAll } from "../core/importer";
import { renderRefRow, filterRows, closePopup } from "./rows";
import { guard, guardAsync } from "../utils/guard";
import type { RowContext } from "./rows";

/**
 * The "References" item pane section (library + reader), the heart of the
 * plugin. Ported from zotero-reference Views.refreshReferences with the
 * original interaction set:
 *   - refresh click: fetch from the current source, toggling PDF <-> API on
 *     subsequent clicks
 *   - refresh long-press (>=1s): ignore local cache, force re-fetch
 *   - Ctrl+refresh: PDF source parses from the current page backwards
 *   - double-click on the count label: copy all references
 *   - per-row: copy / edit / locate / import(+) / unlink(−) / hover popup
 * New: import-all button, export menu, cached-state indicator, search box.
 *
 * The section body is shared and re-rendered as the user switches items, so
 * every async completion is guarded by an item stamp on the body — a slow
 * fetch for item A must never paint into item B's panel.
 */

type SourceKind = "PDF" | "API";

interface PanelState {
  stateKey: string;
  refs: RefItem[];
  /** source used for the NEXT fetch */
  source: SourceKind;
  /** cache slot the currently displayed refs were loaded from */
  loadedSlot?: SourceKind;
  sourceUsed?: string;
  loading: boolean;
  importing: boolean;
  loadedOnce: boolean;
}

const states = new Map<string, PanelState>();

/** monotonically increasing id for chunked list renders */
let renderSeq = 0;

/** pretty display names for API source ids */
const SOURCE_LABEL: Record<string, string> = {
  crossref: "Crossref",
  semanticscholar: "Semantic Scholar",
  openalex: "OpenAlex",
  cnki: "CNKI",
};

function getState(item: Zotero.Item): PanelState {
  const stateKey = itemCacheKey(item);
  let state = states.get(stateKey);
  if (!state) {
    state = {
      stateKey,
      refs: [],
      source: (getPref("prioritySource") as SourceKind) || "PDF",
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

async function fetchReferences(
  item: Zotero.Item,
  state: PanelState,
  options: { useCache: boolean; fromCurrentPage: boolean },
): Promise<RefItem[]> {
  const slot = state.source;
  if (options.useCache) {
    const cached = await refStorage.get(item, slot);
    if (cached?.length) {
      new ztoolkit.ProgressWindow(`[Local] ${slot}`, {
        closeOtherProgressWindows: true,
      })
        .createLine({
          text: `${cached.length} ${getString("panel-count-suffix")}`,
          type: "success",
        })
        .show();
      state.sourceUsed = `${slot} (cached)`;
      state.loadedSlot = slot;
      return cached;
    }
  }
  if (slot === "PDF") {
    const reader = findReaderForItem(item);
    if (!reader) {
      new ztoolkit.ProgressWindow("[Fail] PDF", {
        closeOtherProgressWindows: true,
      })
        .createLine({ text: getString("panel-need-reader"), type: "fail" })
        .show();
      return [];
    }
    const popupWin = new ztoolkit.ProgressWindow("[Pending] PDF", {
      closeTime: -1,
      closeOtherProgressWindows: true,
    });
    popupWin.createLine({
      text: getString("panel-parsing"),
      type: "default",
      progress: 1,
    });
    popupWin.show();
    let refs: RefItem[] = [];
    try {
      refs = await parsePDFReferences(reader, {
        fromCurrentPage: options.fromCurrentPage,
        onProgress: (message, pct) =>
          popupWin.changeLine({ text: message, progress: pct }),
      });
    } finally {
      if (refs.length) {
        popupWin.changeHeadline("[Done] PDF");
        popupWin.changeLine({
          text: `${refs.length} ${getString("panel-count-suffix")}`,
          type: "success",
          progress: 100,
        });
      } else {
        popupWin.changeHeadline("[Fail] PDF");
        popupWin.changeLine({
          text: `0 ${getString("panel-count-suffix")}`,
          type: "fail",
        });
      }
      popupWin.startCloseTimer(3000);
    }
    state.sourceUsed = "PDF";
    state.loadedSlot = "PDF";
    if (refs.length && getPref("savePDFReferences")) {
      void refStorage.set(item, "PDF", refs);
    }
    return refs;
  }
  // API source
  const popupWin = new ztoolkit.ProgressWindow("[Pending] API", {
    closeTime: -1,
    closeOtherProgressWindows: true,
  });
  popupWin.createLine({ text: getString("panel-requesting"), type: "default" });
  popupWin.show();
  const result = await getReferencesByAPI(item, (msg) =>
    popupWin.changeLine({ text: msg }),
  );
  if (!result) {
    popupWin.changeHeadline("[Fail] API");
    popupWin.changeLine({ text: getString("panel-api-fail"), type: "fail" });
    popupWin.startCloseTimer(3000);
    return [];
  }
  popupWin.changeHeadline("[Done] API");
  const sourceLabel = SOURCE_LABEL[result.source] || result.source;
  popupWin.changeLine({
    text: `${result.refs.length} ${getString("panel-count-suffix")} (${sourceLabel})`,
    type: "success",
  });
  popupWin.startCloseTimer(3000);
  state.sourceUsed = sourceLabel;
  state.loadedSlot = "API";
  if (result.refs.length && getPref("saveAPIReferences")) {
    void refStorage.set(item, "API", result.refs);
  }
  return result.refs;
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
      // persist into the slot the refs were LOADED from — the badge only
      // selects the next fetch and must not redirect edits
      void refStorage.set(item, state.loadedSlot ?? state.source, state.refs);
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
  const badge = body.querySelector<HTMLElement>(".references-source-badge");
  if (badge) badge.textContent = state.source;
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

  const badge = doc.createElement("span");
  badge.className = "references-source-badge";
  badge.textContent = state.source;
  badge.title = getString("panel-source-tip");
  badge.addEventListener("click", () => {
    state.source = state.source === "PDF" ? "API" : "PDF";
    badge.textContent = state.source;
  });
  toolbar.append(badge);

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
    const popupWin = new ztoolkit.ProgressWindow(getString("panel-import-all"), {
      closeTime: -1,
      closeOtherProgressWindows: true,
    })
      .createLine({
        text: `0/${targets.length}`,
        type: "default",
        progress: 0,
      })
      .show();
    try {
      const { ok, fail } = await importAll(
        item,
        targets,
        undefined,
        (done, total, msg) =>
          popupWin.changeLine({
            text: `${done}/${total} ${msg}`,
            progress: (done / total) * 100,
          }),
      );
      popupWin.changeHeadline("[Done] Import");
      popupWin.changeLine({
        text: `✓ ${ok}  ✗ ${fail}`,
        type: fail ? "fail" : "success",
        progress: 100,
      });
      popupWin.startCloseTimer(5000);
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
      darkIcon: `chrome://${config.addonRef}/content/icons/references-dark.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-references-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/references.svg`,
      darkIcon: `chrome://${config.addonRef}/content/icons/references-dark.svg`,
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
      // cache-first initial fill
      const cached = await refStorage.get(item, state.source);
      if (!isCurrent(body as HTMLElement, state)) return;
      if (cached?.length) {
        state.refs = cached;
        state.loadedOnce = true;
        state.loadedSlot = state.source;
        state.sourceUsed = `${state.source} (cached)`;
        renderList(body as HTMLElement, item, state, setSectionSummary);
        return;
      }
      if (getPref("autoRefresh")) {
        const excluded = (getPref("notAutoRefreshItemTypes") as string)
          .split(/,\s*/)
          .map((s) => s.trim());
        if (excluded.includes(item.itemType)) return;
        // without an open reader the PDF source can only fail — fall back
        // to API when it can answer, else skip silently (no popup spam
        // while browsing the library)
        if (state.source === "PDF" && !findReaderForItem(item)) {
          const hasDOI = !!(item.getField("DOI") as string)?.trim();
          const title = (item.getField("title") as string) || "";
          if (hasDOI || isChinese(title)) {
            state.source = "API";
          } else {
            return;
          }
        }
        // settle debounce: rapid item switching (arrow-key browsing) must
        // not fire a network fetch per item
        await new Promise<void>((r) => setTimeout(() => r(), 350));
        if (!isCurrent(body as HTMLElement, state)) return;
        await refresh(body as HTMLElement, item, state, setSectionSummary, {
          useCache: true,
          fromCurrentPage: false,
        });
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
