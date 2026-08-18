import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemCacheKey } from "../core/storage";
import { setTimeout } from "../utils/window";
import type { Identifiers, RefItem } from "../core/types";
import { getCitationsByAPI } from "../sources";
import type { CitationSource } from "../sources";
import { hostIdentifiers, normalizeTitle } from "../core/text";
import { filterRows, renderRefRow } from "./rows";
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
  const ids = hostIdentifiers(item);
  return Object.keys(ids).length ? ids : null;
}

/** DOM handles of one concrete render of the section body */
interface PanelDOM {
  list: HTMLElement;
  count: HTMLElement;
  more: HTMLButtonElement;
  filter?: HTMLInputElement;
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
        if (live.filter?.value) filterRows(live.list, live.filter.value);
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
    },
    sidenav: {
      l10nID: getLocaleID("item-section-citations-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/20/citations.svg`,
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

        // keyword filter over loaded rows — landmark trials have thousands
        // of citing works; 25-per-page with no filter is unusable
        const searchBox = doc.createElement("div");
        searchBox.className = "references-search";
        const input = doc.createElement("input");
        input.placeholder = getString("citations-filter-placeholder");
        searchBox.append(input);
        body.append(searchBox);

        const list = doc.createElement("div");
        list.className = "references-list";
        body.append(list);
        input.addEventListener("input", () => filterRows(list, input.value));

        const more = doc.createElement("button");
        more.className = "references-button references-load-more";
        more.textContent = getString("citations-load-more");
        body.append(more);

        const dom: PanelDOM = { list, count, more, filter: input };
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
          // settle debounce outside the awaited render (see section.ts);
          // `list` detaches whenever ANY item re-renders the shared body,
          // so this also skips items the user merely arrow-keyed past
          setTimeout(
            guard("citations.autoFetch", () => {
              if (state.dom !== dom || !list.isConnected) return;
              void loadMore(item, state);
            }),
            350,
          );
        }
      },
    ),
  });
}

export function invalidateCitations(stateKeys?: string[]) {
  if (!stateKeys) states.clear();
  else for (const key of stateKeys) states.delete(key);
}
