import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemCacheKey } from "../core/storage";
import type { Identifiers, RefItem } from "../core/types";
import { getCitationsByAPI } from "../sources";
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

async function loadMore(
  dom: PanelDOM,
  item: Zotero.Item,
  state: CitationsState,
  setSectionSummary: (s: string) => void,
) {
  if (state.loading || state.exhausted) return;
  const ids = idsOf(item);
  if (!ids) return;
  state.loading = true;
  dom.more.disabled = true;
  let failed = false;
  try {
    const pageSize = Number(getPref("citationsPageSize")) || 25;
    const page = await getCitationsByAPI(ids, state.nextOffset, pageSize);
    if (page === null) {
      // transient API failure — keep the button so the user can retry
      failed = true;
    } else if (!page.items.length) {
      state.exhausted = true;
    } else {
      state.total = page.total ?? state.total;
      state.nextOffset =
        page.nextOffset ?? state.nextOffset + page.items.length;
      if (
        page.items.length < pageSize ||
        (state.total !== undefined &&
          state.refs.length + page.items.length >= state.total)
      ) {
        state.exhausted = true;
      }
      const start = state.refs.length;
      state.refs.push(...page.items);
      // the user may have switched items while the request ran
      if (dom.list.isConnected) {
        const ctx: RowContext = {
          hostItem: item,
          list: dom.list,
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
    if (dom.list.isConnected) {
      dom.more.disabled = false;
      dom.more.style.display = state.exhausted ? "none" : "";
      dom.count.textContent = `${state.refs.length}${
        state.total ? ` / ${state.total}` : ""
      } ${getString("citations-count-suffix")}${failed ? " ⚠" : ""}`;
      setSectionSummary(
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
      icon: "chrome://zotero/skin/16/universal/cite.svg",
    },
    sidenav: {
      l10nID: getLocaleID("item-section-citations-sidenav-tooltip"),
      icon: "chrome://zotero/skin/20/universal/cite.svg",
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
      more.addEventListener("click", () =>
        loadMore(dom, item, state!, setSectionSummary),
      );

      if (!state) {
        state = {
          refs: [],
          nextOffset: 0,
          exhausted: false,
          loading: false,
        };
        states.set(stateKey, state);
      } else if (state.refs.length) {
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
        await loadMore(dom, item, state, setSectionSummary);
      }
      },
    ),
  });
}

export function invalidateCitations(stateKeys?: string[]) {
  if (!stateKeys) states.clear();
  else for (const key of stateKeys) states.delete(key);
}
