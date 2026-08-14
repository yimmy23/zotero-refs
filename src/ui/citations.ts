import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import type { Identifiers, RefItem } from "../core/types";
import { getCitationsByAPI } from "../sources";
import { renderRefRow } from "./rows";
import type { RowContext } from "./rows";

/**
 * "Cited By" item pane section (new feature): works citing the current
 * item, paged, with the same row interactions (popup / import / locate).
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

async function loadMore(
  body: HTMLElement,
  item: Zotero.Item,
  state: CitationsState,
  setSectionSummary: (s: string) => void,
) {
  if (state.loading || state.exhausted) return;
  const ids = idsOf(item);
  if (!ids) return;
  state.loading = true;
  const button = body.querySelector<HTMLButtonElement>(
    ".references-load-more",
  );
  if (button) button.disabled = true;
  try {
    const pageSize = Number(getPref("citationsPageSize")) || 25;
    const page = await getCitationsByAPI(ids, state.nextOffset, pageSize);
    if (!page || !page.items.length) {
      state.exhausted = true;
    } else {
      const list = body.querySelector<HTMLElement>(".references-list");
      if (!list) return;
      const ctx: RowContext = {
        hostItem: item,
        list,
        numbered: false,
        editable: false,
      };
      const start = state.refs.length;
      state.refs.push(...page.items);
      for (let i = start; i < state.refs.length; i++) {
        renderRefRow(ctx, state.refs, i);
      }
      state.total = page.total ?? state.total;
      state.nextOffset =
        page.nextOffset ?? state.nextOffset + page.items.length;
      if (
        page.items.length < pageSize ||
        (state.total !== undefined && state.refs.length >= state.total)
      ) {
        state.exhausted = true;
      }
    }
  } catch (e) {
    ztoolkit.log("[citations] load failed", e);
  } finally {
    state.loading = false;
    if (button) {
      button.disabled = false;
      button.style.display = state.exhausted ? "none" : "";
    }
    const count = body.querySelector<HTMLElement>(".references-count");
    if (count) {
      count.textContent = `${state.refs.length}${
        state.total ? ` / ${state.total}` : ""
      } ${getString("citations-count-suffix")}`;
    }
    setSectionSummary(
      `${state.total ?? state.refs.length}${state.total ? "" : "+"}`,
    );
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
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(!!item?.isRegularItem?.() && !!idsOf(item));
      return true;
    },
    onRender: () => {},
    onAsyncRender: async ({ body, item, setSectionSummary }) => {
      if (!item?.isRegularItem?.()) return;
      let state = states.get(item.key);
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
      more.addEventListener("click", () =>
        loadMore(body as HTMLElement, item, state!, setSectionSummary),
      );
      body.append(more);

      if (!state) {
        state = {
          refs: [],
          nextOffset: 0,
          exhausted: false,
          loading: false,
        };
        states.set(item.key, state);
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
        more.style.display = state.exhausted ? "none" : "";
        return;
      }
      if (getPref("loadingCitations")) {
        await loadMore(body as HTMLElement, item, state, setSectionSummary);
      }
    },
  });
}

export function invalidateCitations(itemKeys?: string[]) {
  if (!itemKeys) states.clear();
  else for (const key of itemKeys) states.delete(key);
}
