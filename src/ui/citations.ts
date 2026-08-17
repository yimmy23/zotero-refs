import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemCacheKey } from "../core/storage";
import { setTimeout } from "../utils/window";
import type { Identifiers, RefItem } from "../core/types";
import { getCitationsByAPI } from "../sources";
import type { CitationSource } from "../sources";
import { normalizeTitle } from "../core/text";
import { renderRefRow } from "./rows";
import { guard, guardAsync } from "../utils/guard";
import type { RowContext } from "./rows";

/**
 * "Cited By" item pane section (new feature): works citing the current
 * item, paged, with the same row interactions (popup / import / locate).
 *
 * The section body is shared across item switches — loadMore works only
 * against the DOM elements captured at its own render, and bails out once
 * they are detached.
 */

interface CitationsState {
  refs: RefItem[];
  total?: number;
  nextOffset: number;
  exhausted: boolean;
  loading: boolean;
  /** source that served page 1 — later pages stay on it */
  source?: CitationSource;
  /** identity keys of everything shown, for cross-page dedupe */
  seen: Set<string>;
  /**
   * DOM of the FRESHEST render of this item's section. A loadMore that
   * outlives its own render must paint into the current body, not the
   * detached one it was started from — otherwise the page it fetched is
   * committed to state but never shown.
   */
  dom?: PanelDOM;
  setSummary?: (s: string) => void;
}

/** stable identity of a citing work for dedupe */
function refKey(ref: RefItem): string {
  return (
    ref.identifiers.DOI?.toLowerCase() ||
    ref.identifiers.s2 ||
    ref.identifiers.openAlex ||
    normalizeTitle(ref.title || ref.text)
  );
}

const states = new Map<string, CitationsState>();

function idsOf(item: Zotero.Item): Identifiers | null {
  const ids: Identifiers = {};
  const DOI = (item.getField("DOI") as string)?.trim();
  if (DOI) ids.DOI = DOI;
  const url = (item.getField("url") as string) || "";
  const arxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i);
  if (arxiv) ids.arXiv = arxiv[1];
  const extra = (item.getField("extra") as string) || "";
  const pmid = extra.match(/PMID:\s*(\d+)/i);
  if (pmid) ids.PMID = pmid[1];
  return Object.keys(ids).length ? ids : null;
}

/** DOM handles of one concrete render of the section body */
interface PanelDOM {
  list: HTMLElement;
  count: HTMLElement;
  more: HTMLButtonElement;
}

async function loadMore(item: Zotero.Item, state: CitationsState) {
  if (state.loading || state.exhausted) return;
  const ids = idsOf(item);
  if (!ids) return;
  state.loading = true;
  if (state.dom) state.dom.more.disabled = true;
  let failed = false;
  try {
    const pageSize = Number(getPref("citationsPageSize")) || 25;
    const page = await getCitationsByAPI(
      ids,
      state.nextOffset,
      pageSize,
      state.source,
    );
    if (page === null) {
      // transient API failure — keep the button so the user can retry
      failed = true;
    } else if (!page.items.length) {
      state.exhausted = true;
    } else {
      state.source = page.source;
      state.total = page.total ?? state.total;
      state.nextOffset =
        page.nextOffset ?? state.nextOffset + page.items.length;
      // NOTE: a short page (< pageSize) is NOT proof of exhaustion — the
      // sources drop malformed entries inside a page. Only an empty page
      // or reaching the reported total ends paging.
      if (
        state.total !== undefined &&
        state.refs.length + page.items.length >= state.total
      ) {
        state.exhausted = true;
      }
      // drop entries already shown (retries / source quirks)
      const fresh = page.items.filter((r) => {
        const key = refKey(r);
        if (!key || state.seen.has(key)) return false;
        state.seen.add(key);
        return true;
      });
      const start = state.refs.length;
      state.refs.push(...fresh);
      // paint into the FRESHEST render of this item's section (the body
      // may have been rebuilt while the request ran); every render paints
      // exactly state.refs.length rows, so `start` always lines up
      const live = state.dom;
      if (live?.list.isConnected) {
        const ctx: RowContext = {
          hostItem: item,
          list: live.list,
          numbered: false,
          editable: false,
        };
        for (let i = start; i < state.refs.length; i++) {
          renderRefRow(ctx, state.refs, i);
        }
      }
    }
  } catch (e) {
    ztoolkit.log("[citations] load failed", e);
    failed = true;
  } finally {
    state.loading = false;
    const live = state.dom;
    if (live?.list.isConnected) {
      live.more.disabled = false;
      live.more.style.display = state.exhausted ? "none" : "";
      live.count.textContent = `${state.refs.length}${
        state.total ? ` / ${state.total}` : ""
      } ${getString("citations-count-suffix")}${failed ? " ⚠" : ""}`;
      state.setSummary?.(
        `${state.total ?? state.refs.length}${state.total ? "" : "+"}`,
      );
    }
  }
}

export function registerCitationsSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "citations",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-citations-head-text"),
      icon: `chrome://${config.addonRef}/content/icons/citations.svg`,
      darkIcon: `chrome://${config.addonRef}/content/icons/citations-dark.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-citations-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/citations.svg`,
      darkIcon: `chrome://${config.addonRef}/content/icons/citations-dark.svg`,
    },
    onItemChange: guard("citations.onItemChange", ({ item, setEnabled }) => {
      setEnabled(!!item?.isRegularItem?.() && !!idsOf(item));
      return true;
    }),
    onRender: () => {},
    onAsyncRender: guardAsync(
      "citations.onAsyncRender",
      async ({ body, item, setSectionSummary }) => {
      if (!item?.isRegularItem?.()) return;
      const stateKey = itemCacheKey(item);
      let state = states.get(stateKey);
      const doc = body.ownerDocument!;
      body.textContent = "";
      (body as HTMLElement).classList.add("references-panel");

      const toolbar = doc.createElement("div");
      toolbar.className = "references-toolbar";
      const count = doc.createElement("span");
      count.className = "references-count";
      count.textContent = `0 ${getString("citations-count-suffix")}`;
      toolbar.append(count);
      body.append(toolbar);

      const list = doc.createElement("div");
      list.className = "references-list";
      body.append(list);

      const more = doc.createElement("button");
      more.className = "references-button references-load-more";
      more.textContent = getString("citations-load-more");
      body.append(more);

      const dom: PanelDOM = { list, count, more };
      more.addEventListener("click", () => loadMore(item, state!));

      if (!state) {
        state = {
          refs: [],
          nextOffset: 0,
          exhausted: false,
          loading: false,
          seen: new Set(),
        };
        // bound per-session memory: drop the oldest items' states
        if (states.size >= 150) {
          const oldest = states.keys().next().value;
          if (oldest !== undefined) states.delete(oldest);
        }
        states.set(stateKey, state);
      }
      // every render (fresh or repeat) owns the panel from now on
      state.dom = dom;
      state.setSummary = setSectionSummary;
      if (state.refs.length) {
        // re-render existing page(s)
        const ctx: RowContext = {
          hostItem: item,
          list,
          numbered: false,
          editable: false,
        };
        for (let i = 0; i < state.refs.length; i++) {
          renderRefRow(ctx, state.refs, i);
        }
        count.textContent = `${state.refs.length}${
          state.total ? ` / ${state.total}` : ""
        } ${getString("citations-count-suffix")}`;
        setSectionSummary(
          `${state.total ?? state.refs.length}${state.total ? "" : "+"}`,
        );
        more.style.display = state.exhausted ? "none" : "";
        return;
      }
      if (getPref("loadingCitations")) {
        // settle debounce: skip if another render took over meanwhile
        await new Promise<void>((r) => setTimeout(() => r(), 350));
        if (state.dom !== dom) return;
        await loadMore(item, state);
      }
      },
    ),
  });
}

export function invalidateCitations(stateKeys?: string[]) {
  if (!stateKeys) states.clear();
  else for (const key of stateKeys) states.delete(key);
}
