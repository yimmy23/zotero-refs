import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { setTimeout, clearTimeout } from "../utils/window";
import { refStorage, itemStateKey } from "../core/storage";
import {
  hostIdentifiers,
  isChinese,
  isHttpUrl,
  identifiersToURL,
} from "../core/text";
import { fuseReferences } from "../core/fuse";
import type { RefItem, SourceID } from "../core/types";
import { SOURCE_NAME } from "../core/types";
import { getReferencesByAPI, sources } from "../sources";
import { parsePDFReferences } from "../pdf/parser";
import { runBatchImport } from "./batchImport";
import {
  renderRefRow,
  filterRows,
  keywordPredicate,
  referenceSearchText,
  closePopup,
} from "./rows";
import { guard, guardAsync } from "../utils/guard";
import type { RowContext } from "./rows";
import { actionButton, createSearch, setListMessage } from "./controls";

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
  item: Zotero.Item;
  refs: RefItem[];
  /** label naming what produced the shown list ("PDF + Crossref", …) */
  sourceUsed?: string;
  loading: boolean;
  importing: boolean;
  loadedOnce: boolean;
  needsPDFRefresh: boolean;
  pdfRepairAttempted: boolean;
  renders: Map<HTMLElement, (s: string) => void>;
}

const states = new Map<string, PanelState>();

/** monotonically increasing id for chunked list renders */
let renderSeq = 0;

function getState(item: Zotero.Item): PanelState {
  const stateKey = itemStateKey(item);
  let state = states.get(stateKey);
  if (!state) {
    state = {
      stateKey,
      item,
      refs: [],
      loading: false,
      importing: false,
      loadedOnce: false,
      needsPDFRefresh: false,
      pdfRepairAttempted: false,
      renders: new Map(),
    };
    // bound per-session memory: drop the oldest items' states
    if (states.size >= 150) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    states.set(stateKey, state);
  }
  state.item = item;
  return state;
}

/** does the shared section body still show this item? */
function isCurrent(body: HTMLElement, state: PanelState): boolean {
  return (
    body.isConnected &&
    body.dataset.itemKey === state.stateKey &&
    itemStateKey(state.item) === state.stateKey &&
    addon.data.alive
  );
}

/** the attachment reader open for this top-level item, if any */
function findReaderForItem(item: Zotero.Item): any {
  try {
    for (const reader of (Zotero.Reader as any)._readers || []) {
      const readerItem = (Zotero.Items.get(reader.itemID) || undefined) as
        Zotero.Item | undefined;
      if (
        readerItem &&
        ((item.id &&
          (readerItem.id === item.id || readerItem.parentID === item.id)) ||
          (readerItem.libraryID === item.libraryID &&
            (readerItem.parentItem?.key === item.key ||
              readerItem.key === item.key)))
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

async function checkPDFRepair(state: PanelState) {
  const pending = await refStorage.needsPDFRefresh(state.item, state.stateKey);
  if (itemStateKey(state.item) !== state.stateKey || !addon.data.alive) return;
  if (pending && !state.needsPDFRefresh) {
    state.refs = [];
    state.loadedOnce = false;
    state.pdfRepairAttempted = false;
    for (const [body, summary] of state.renders)
      if (isCurrent(body, state)) renderList(body, state.item, state, summary);
  }
  state.needsPDFRefresh = pending;
}

async function savePDFRepair(
  state: PanelState,
  pdf: RefItem[],
  refs: RefItem[],
) {
  if (
    await refStorage.commitPDFRepair(
      state.item,
      pdf,
      refs,
      { pdf: !!getPref("savePDFReferences"), fused: cachingEnabled() },
      state.stateKey,
    )
  ) {
    state.needsPDFRefresh = false;
    state.pdfRepairAttempted = false;
    return true;
  }
  return false;
}

async function fetchReferences(
  item: Zotero.Item,
  state: PanelState,
  options: { useCache: boolean; fromCurrentPage: boolean },
): Promise<RefItem[]> {
  const current = () =>
    itemStateKey(item) === state.stateKey && addon.data.alive;
  if (!current()) return [];
  await checkPDFRepair(state);
  if (!current()) return [];
  // fused fast path (plain click); Ctrl = re-parse from the current page,
  // which must not be answered from cache
  if (options.useCache && !options.fromCurrentPage) {
    const fused = await refStorage.get(item, "FUSED", state.stateKey);
    if (!current()) return [];
    if (fused?.length) {
      new ztoolkit.ProgressWindow(getString("progress-refs-local"), {
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
  const popupWin = new ztoolkit.ProgressWindow(
    getString("progress-refs-pending"),
    {
      closeTime: -1,
      closeOtherProgressWindows: true,
    },
  );
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
      const cached = await refStorage.get(item, "PDF", state.stateKey);
      if (!current()) return [];
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
    if (!reader || !current()) return [];
    if (state.needsPDFRefresh) state.pdfRepairAttempted = true;
    try {
      const refs = await parsePDFReferences(reader, {
        fromCurrentPage: options.fromCurrentPage,
        onProgress: (message, pct) => {
          if (current())
            popupWin.changeLine({
              idx: 0,
              text: `PDF: ${message}`,
              progress: pct,
            });
        },
      });
      if (!current()) return [];
      popupWin.changeLine({
        idx: 0,
        text: `PDF: ${refs.length} ${getString("panel-count-suffix")}`,
        type: refs.length ? "success" : "fail",
        progress: 100,
      });
      if (
        refs.length &&
        getPref("savePDFReferences") &&
        !state.needsPDFRefresh
      ) {
        void refStorage.set(item, "PDF", refs, state.stateKey);
      }
      return refs;
    } catch (e) {
      if (!current()) return [];
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
    source: string | null;
  } | null> => {
    if (options.useCache) {
      const cached = await refStorage.get(item, "API", state.stateKey);
      if (!current()) return null;
      if (cached?.length) {
        // pre-1.0.12 caches carry no source stamp — leave it unknown, so
        // positional alignment (Crossref-order only) stays off for them
        const source = (cached[0]?.source as string) ?? null;
        popupWin.changeLine({
          idx: 1,
          text: `API: ${cached.length} (${getString("panel-cached")})`,
          type: "success",
        });
        return { refs: cached, source };
      }
    }
    if (!current()) return null;
    const result = await getReferencesByAPI(item, (msg) => {
      if (current()) popupWin.changeLine({ idx: 1, text: `API: ${msg}` });
    });
    if (!current()) return null;
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
    // (freshly fetched results always carry a source)
    if (result.refs.length && getPref("saveAPIReferences")) {
      void refStorage.set(item, "API", result.refs, state.stateKey);
    }
    return result;
  })();

  const [pdfRefs, api] = await Promise.all([pdfPromise, apiPromise]);
  if (!current()) {
    popupWin.close();
    return [];
  }
  if (!pdfRefs.length && !api?.refs.length) {
    popupWin.changeHeadline(getString("progress-refs-fail"));
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
  if (!current()) {
    popupWin.close();
    return [];
  }
  tagTail(refs, tailStart);
  ztoolkit.log(
    `[section] fused pdf=${pdfRefs.length} api=${api?.refs.length ?? 0} -> ${refs.length} (id=${stats.id} title=${stats.title} volPage=${stats.volPage} pos=${stats.positional} [${stats.posMode}] unmatched=${stats.unmatched} appended=${stats.appended})`,
  );
  if (state.needsPDFRefresh && pdfRefs.length && refs.length) {
    if (!(await savePDFRepair(state, pdfRefs, refs))) {
      popupWin.changeHeadline(getString("progress-refs-fail"));
      popupWin.startCloseTimer(3000);
      return [];
    }
  } else if (refs.length && cachingEnabled() && !state.needsPDFRefresh) {
    void refStorage.set(item, "FUSED", refs, state.stateKey);
  }
  if (!current()) return [];
  const parts: string[] = [];
  if (pdfRefs.length) parts.push("PDF");
  if (api?.refs.length) {
    parts.push((api.source && SOURCE_NAME[api.source]) || api.source || "API");
  }
  state.sourceUsed = parts.join(" + ");
  popupWin.changeHeadline(getString("progress-refs-done"));
  popupWin.startCloseTimer(3000);
  return refs;
}

function copyAll(state: PanelState) {
  const texts = state.refs.map(
    (r, i) => `[${r.number || i + 1}] ${r.text || r.title || ""}`,
  );
  new ztoolkit.Clipboard().addText(texts.join("\n"), "text/unicode").copy();
  new ztoolkit.ProgressWindow(getString("progress-refs"))
    .createLine({ text: getString("panel-copy-all-done"), type: "success" })
    .show();
}

export function formatReferences(
  refs: RefItem[],
  format: "text" | "markdown" | "csv",
): string {
  let out: string;
  if (format === "text") {
    out = refs
      .map((r, i) => `[${r.number || i + 1}] ${r.text || r.title || ""}`)
      .join("\n");
  } else if (format === "markdown") {
    out = refs
      .map((r, i) => {
        const label = (r.text || r.title || "")
          .replace(/[\\[\]]/g, "\\$&")
          .replace(/\r?\n/g, " ");
        const candidate = isHttpUrl(r.url)
          ? r.url
          : identifiersToURL(r.identifiers);
        const url = isHttpUrl(candidate)
          ? candidate.replace(/[<>]/g, encodeURIComponent)
          : "";
        return url
          ? `${r.number || i + 1}. [${label}](<${url}>)`
          : `${r.number || i + 1}. ${label}`;
      })
      .join("\n");
  } else {
    const esc = (value?: string | number) => {
      let text = String(value ?? "");
      if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };
    out = [
      "number,title,authors,year,venue,doi,url,text",
      ...refs.map((r, i) =>
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
  return out;
}

function exportRefs(state: PanelState, format: "text" | "markdown" | "csv") {
  const out = formatReferences(state.refs, format);
  new ztoolkit.Clipboard().addText(out, "text/unicode").copy();
  new ztoolkit.ProgressWindow(getString("progress-refs"))
    .createLine({
      text: `${getString("panel-export-done")} (${format})`,
      type: "success",
    })
    .show();
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
      if (cachingEnabled())
        void refStorage.set(item, "FUSED", state.refs, state.stateKey);
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
  for (const live of state.renders.keys()) {
    if (!isCurrent(live, state)) {
      state.renders.delete(live);
      continue;
    }
    live.setAttribute("aria-busy", "true");
    const button = live.querySelector<HTMLButtonElement>(".references-refresh");
    if (button) button.disabled = true;
    const list = live.querySelector<HTMLElement>(".references-list");
    if (list && !state.refs.length)
      setListMessage(list, getString("panel-loading"));
  }
  try {
    const refs = await fetchReferences(item, state, options);
    if (itemStateKey(item) !== state.stateKey || !addon.data.alive) return;
    state.loadedOnce = true;
    // a failed (re)fetch must never wipe a list already on screen — the
    // failure popup has been shown; keep what the user has
    if (!refs.length) return;
    state.refs = refs;
    for (const [live, summary] of state.renders) {
      if (isCurrent(live, state)) renderList(live, item, state, summary);
      else state.renders.delete(live);
    }
  } catch (e) {
    if (itemStateKey(item) !== state.stateKey || !addon.data.alive) return;
    ztoolkit.log("[section] refresh failed", e);
    new ztoolkit.ProgressWindow(getString("progress-refs-fail"), {
      closeOtherProgressWindows: true,
    })
      .createLine({ text: String(e), type: "fail" })
      .show();
  } finally {
    state.loading = false;
    for (const live of state.renders.keys()) {
      if (!isCurrent(live, state)) {
        state.renders.delete(live);
        continue;
      }
      live.setAttribute("aria-busy", "false");
      const button = live.querySelector<HTMLButtonElement>(
        ".references-refresh",
      );
      if (button) button.disabled = false;
      const list = live.querySelector<HTMLElement>(".references-list");
      if (list && !state.refs.length)
        setListMessage(list, getString("panel-empty"));
    }
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

  const actions = doc.createElement("div");
  actions.className = "references-actions";
  const mkIconButton = (iconClass: string, label: string, tip: string) => {
    const button = actionButton(doc, iconClass, label, tip);
    actions.append(button);
    return button;
  };
  const refreshButton = mkIconButton(
    "references-icon-refresh",
    getString("panel-refresh"),
    getString("panel-refresh-tip"),
  );
  refreshButton.classList.add("references-refresh");
  refreshButton.disabled = state.loading;
  let pressTimer: number | undefined;
  let longPressed = false;
  refreshButton.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) return;
    longPressed = false;
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      longPressed = true;
      void refresh(body, item, state, setSectionSummary, {
        useCache: false,
        fromCurrentPage: event.ctrlKey || event.metaKey,
      });
    }, 1000);
  });
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = undefined;
  };
  refreshButton.addEventListener("mouseup", cancelPress);
  refreshButton.addEventListener("mouseleave", cancelPress);
  refreshButton.addEventListener("click", (event: MouseEvent) => {
    cancelPress();
    if (longPressed) {
      longPressed = false;
      return;
    }
    void refresh(body, item, state, setSectionSummary, {
      useCache: true,
      fromCurrentPage: event.ctrlKey || event.metaKey,
    });
  });

  const importButton = mkIconButton(
    "references-icon-import",
    getString("panel-import-all"),
    getString("panel-import-all-tip"),
  );
  importButton.addEventListener("click", async () => {
    if (!state.refs.length || state.importing) return;
    const keyword =
      body.querySelector<HTMLInputElement>(".references-search input")?.value ||
      "";
    // filter applied to the DATA, not to rendered rows (chunked rendering
    // may not have painted everything yet) — same predicate as filterRows
    const match = keywordPredicate(keyword);
    const targets = state.refs.filter((ref, i) =>
      match(referenceSearchText(ref, i)),
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

  const menu = doc.createElement("details");
  menu.className = "references-menu";
  const summary = doc.createElement("summary");
  summary.className = "references-button references-labeled-button";
  const copyIcon = doc.createElement("span");
  copyIcon.className = "references-icon-button references-icon-copy";
  copyIcon.setAttribute("aria-hidden", "true");
  summary.append(copyIcon, getString("panel-actions"));
  const commands = doc.createElement("div");
  commands.className = "references-menu-content";
  const command = (label: string, run: () => void) => {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "references-menu-command";
    button.textContent = label;
    button.addEventListener("click", () => {
      menu.open = false;
      summary.focus();
      run();
    });
    commands.append(button);
  };
  command(getString("panel-fetch-fresh"), () => {
    void refresh(body, item, state, setSectionSummary, {
      useCache: false,
      fromCurrentPage: false,
    });
  });
  command(getString("panel-from-page"), () => {
    void refresh(body, item, state, setSectionSummary, {
      useCache: false,
      fromCurrentPage: true,
    });
  });
  for (const format of ["text", "markdown", "csv"] as const) {
    command(getString(`panel-export-${format}`), () =>
      exportRefs(state, format),
    );
  }
  menu.append(summary, commands);
  menu.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      menu.open = false;
      summary.focus();
    }
  });
  menu.addEventListener("focusout", (event: FocusEvent) => {
    if (!menu.contains(event.relatedTarget as Node | null)) menu.open = false;
  });
  actions.append(menu);
  toolbar.append(actions);
  body.append(toolbar);
  const input = createSearch(body, getString("panel-search-placeholder"));
  input.addEventListener("input", () => {
    const list = body.querySelector<HTMLElement>(".references-list");
    if (list) filterRows(list, input.value);
  });
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
        for (const live of state.renders.keys())
          if (!isCurrent(live, state)) state.renders.delete(live);
        state.renders.set(body as HTMLElement, setSectionSummary);
        buildToolbar(body as HTMLElement, item, state, setSectionSummary);
        const list = body.ownerDocument!.createElement("div");
        list.className = "references-list";
        body.append(list);
        setListMessage(
          list,
          getString(
            state.loading
              ? "panel-loading"
              : state.loadedOnce
                ? "panel-empty"
                : "panel-ready",
          ),
        );
        await checkPDFRepair(state);
        if (!isCurrent(body as HTMLElement, state)) return;
        const repairWithReader = () =>
          state.needsPDFRefresh &&
          !state.pdfRepairAttempted &&
          !!findReaderForItem(item);
        if (state.refs.length) {
          renderList(body as HTMLElement, item, state, setSectionSummary);
          if (!repairWithReader()) return;
        }
        if (state.loadedOnce && !repairWithReader()) return;
        // cache-first initial fill: the fused list if we have it, else
        // fuse whatever raw layers are cached (offline, no network)
        const fused = await refStorage.get(item, "FUSED", state.stateKey);
        if (!isCurrent(body as HTMLElement, state)) return;
        if (fused?.length) {
          state.refs = fused;
          state.loadedOnce = true;
          state.sourceUsed = getString("panel-cached");
          renderList(body as HTMLElement, item, state, setSectionSummary);
          return;
        }
        const [cachedPDF, cachedAPI] = await Promise.all([
          refStorage.get(item, "PDF", state.stateKey),
          refStorage.get(item, "API", state.stateKey),
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
          if (cachingEnabled() && !state.needsPDFRefresh)
            void refStorage.set(item, "FUSED", refs, state.stateKey);
          renderList(body as HTMLElement, item, state, setSectionSummary);
          if (!repairWithReader()) return;
        }
        if (getPref("autoRefresh")) {
          if (state.needsPDFRefresh && state.pdfRepairAttempted) return;
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
          const scheduledRepair = state.needsPDFRefresh;
          setTimeout(
            guard("references.autoFetch", () => {
              if (!isCurrent(body as HTMLElement, state)) return;
              if (scheduledRepair && !state.needsPDFRefresh) return;
              if (state.needsPDFRefresh && state.pdfRepairAttempted) return;
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

/** drop cached panel state (called on notifier item deletes) */
export function invalidatePanelState(stateKeys?: string[]) {
  if (!stateKeys) {
    states.clear();
    return;
  }
  for (const key of states.keys())
    if (
      stateKeys.some(
        (stateKey) => key === stateKey || key.startsWith(`${stateKey}@`),
      )
    )
      states.delete(key);
}
