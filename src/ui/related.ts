import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemCacheKey } from "../core/storage";
import type { Identifiers, RefItem } from "../core/types";
import { getRelatedByAPI } from "../sources";
import { renderRefRow } from "./rows";
import { guard, guardAsync } from "../utils/guard";
import type { RowContext } from "./rows";

/**
 * "Related Papers" item pane section — recommendations for the current
 * item (the original plugin's 推荐关联, now in its own section instead of
 * hacking the native Related box; the dead readcube API is replaced by
 * Semantic Scholar recommendations with OpenAlex fallback).
 * Zotero's own related items are listed first.
 */

const cache = new Map<string, RefItem[]>();

function idsOf(item: Zotero.Item): Identifiers | null {
  const ids: Identifiers = {};
  const DOI = (item.getField("DOI") as string)?.trim();
  if (DOI) ids.DOI = DOI;
  const url = (item.getField("url") as string) || "";
  const arxiv = url.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i);
  if (arxiv) ids.arXiv = arxiv[1];
  return Object.keys(ids).length ? ids : null;
}

function zoteroRelated(item: Zotero.Item): RefItem[] {
  return item.relatedItems
    .map((key: string) => {
      try {
        return Zotero.Items.getByLibraryAndKey(item.libraryID, key);
      } catch {
        return undefined;
      }
    })
    .filter((i): i is Zotero.Item => !!i)
    .map((related) => ({
      identifiers: { DOI: related.getField("DOI") as string },
      authors: [],
      title: related.getField("title") as string,
      text: related.getField("title") as string,
      url: related.getField("url") as string,
      type: related.itemType,
      year: related.getField("year") as string,
      libItemID: related.id,
      source: "zotero" as const,
    }));
}

export function registerRelatedSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "related-papers",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-related-head-text"),
      icon: "chrome://zotero/skin/16/universal/link.svg",
    },
    sidenav: {
      l10nID: getLocaleID("item-section-related-sidenav-tooltip"),
      icon: "chrome://zotero/skin/20/universal/magic-wand.svg",
    },
    onItemChange: guard("related.onItemChange", ({ item, setEnabled }) => {
      setEnabled(!!item?.isRegularItem?.());
      return true;
    }),
    onRender: () => {},
    onAsyncRender: guardAsync(
      "related.onAsyncRender",
      async ({ body, item, setSectionSummary }) => {
      if (!item?.isRegularItem?.()) return;
      const doc = body.ownerDocument!;
      body.textContent = "";
      (body as HTMLElement).classList.add("references-panel");

      const toolbar = doc.createElement("div");
      toolbar.className = "references-toolbar";
      const count = doc.createElement("span");
      count.className = "references-count";
      toolbar.append(count);
      body.append(toolbar);

      const list = doc.createElement("div");
      list.className = "references-list";
      body.append(list);

      const ctx: RowContext = {
        hostItem: item,
        list,
        numbered: false,
        editable: false,
        compact: true,
      };
      const refs: RefItem[] = [...zoteroRelated(item)];
      refs.forEach((_, i) => renderRefRow(ctx, refs, i));

      const update = () => {
        count.textContent = `${refs.length} ${getString(
          "related-count-suffix",
        )}`;
        setSectionSummary(`${refs.length}`);
      };
      update();

      if (!getPref("loadingRelated")) return;
      const ids = idsOf(item);
      if (!ids) return;
      const cacheKey = itemCacheKey(item);
      let recommended = cache.get(cacheKey);
      if (!recommended) {
        // cache only real results — a transient API failure must stay
        // retryable on the next render
        const fetched = await getRelatedByAPI(ids, 20);
        recommended = fetched || [];
        if (fetched) cache.set(cacheKey, fetched);
      }
      if (!list.isConnected) return;
      const start = refs.length;
      // skip recommendations that duplicate existing related items
      const seen = new Set(refs.map((r) => (r.title || "").toLowerCase()));
      for (const rec of recommended) {
        if (seen.has((rec.title || "").toLowerCase())) continue;
        refs.push(rec);
      }
      for (let i = start; i < refs.length; i++) {
        renderRefRow(ctx, refs, i);
      }
      update();
      },
    ),
  });
}

export function invalidateRelated(stateKeys?: string[]) {
  if (!stateKeys) cache.clear();
  else for (const key of stateKeys) cache.delete(key);
}
