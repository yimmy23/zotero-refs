import { createSearch, actionButton, setListMessage } from "./controls";
import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemCacheKey } from "../core/storage";
import type { Identifiers, RefItem } from "../core/types";
import { getRelatedByAPI } from "../sources";
import { hostIdentifiers, normalizeTitle, isHttpUrl } from "../core/text";
import { setTimeout } from "../utils/window";
import { renderRefRow, filterRows } from "./rows";
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
  const ids = hostIdentifiers(item);
  return Object.keys(ids).length ? ids : null;
}

function zoteroRelated(item: Zotero.Item): RefItem[] {
  return item.relatedItems.flatMap((key: string): RefItem[] => {
    try {
      const related = Zotero.Items.getByLibraryAndKey(item.libraryID, key);
      if (!related || related.deleted || !related.isRegularItem()) return [];
      const url = related.getField("url") as string;
      return [
        {
          identifiers: hostIdentifiers(related),
          authors: related
            .getCreators()
            .map((creator: any) =>
              [creator.firstName, creator.lastName].filter(Boolean).join(" "),
            ),
          title: related.getField("title") as string,
          text: related.getField("title") as string,
          url: isHttpUrl(url) ? url : undefined,
          type: related.itemType,
          year: related.getField("year") as string,
          libItemID: related.id,
          source: "zotero",
        },
      ];
    } catch {
      return [];
    }
  });
}

export function registerRelatedSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "related-papers",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-related-head-text"),
      icon: `chrome://${config.addonRef}/content/icons/related.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-related-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/20/related.svg`,
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
        const reload = actionButton(
          doc,
          "references-icon-refresh",
          getString("panel-refresh"),
        );
        toolbar.append(reload);
        body.append(toolbar);
        const search = createSearch(
          body as HTMLElement,
          getString("panel-search-placeholder"),
        );

        const list = doc.createElement("div");
        list.className = "references-list";
        body.append(list);
        search.addEventListener("input", () => filterRows(list, search.value));

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

        const ids = idsOf(item);
        reload.disabled = !ids;
        if (!refs.length) setListMessage(list, getString("related-empty"));
        if (!ids) return;
        const cacheKey = itemCacheKey(item);
        const paint = (recommended: RefItem[]) => {
          if (!list.isConnected) return;
          refs.splice(0, refs.length, ...zoteroRelated(item));
          list.textContent = "";
          const seen = new Set<string>();
          const keys = (ref: RefItem) =>
            [
              ref.identifiers.DOI?.toLowerCase(),
              ref.identifiers.PMID,
              ref.identifiers.s2,
              ref.identifiers.openAlex,
              normalizeTitle(ref.title || ref.text || ""),
            ].filter((key): key is string => !!key);
          refs.forEach((ref) => keys(ref).forEach((key) => seen.add(key)));
          keys({
            identifiers: hostIdentifiers(item),
            authors: [],
            title: item.getField("title") as string,
          }).forEach((key) => seen.add(key));
          for (const rec of recommended) {
            const identity = keys(rec);
            if (identity.some((key) => seen.has(key))) continue;
            identity.forEach((key) => seen.add(key));
            refs.push(rec);
          }
          refs.forEach((_, i) => renderRefRow(ctx, refs, i));
          if (search.value) filterRows(list, search.value);
          if (!refs.length) setListMessage(list, getString("related-empty"));
          update();
        };
        let loading = false;
        const load = async (useCache: boolean) => {
          if (loading || !list.isConnected) return;
          loading = true;
          reload.disabled = true;
          list.setAttribute("aria-busy", "true");
          if (!refs.length) setListMessage(list, getString("panel-loading"));
          try {
            const fetched =
              (useCache ? cache.get(cacheKey) : undefined) ??
              (await getRelatedByAPI(ids, 20));
            if (fetched) {
              if (cache.size >= 150) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
              }
              cache.set(cacheKey, fetched);
              paint(fetched);
            } else if (!refs.length && list.isConnected)
              setListMessage(list, getString("panel-load-failed"));
          } catch (error) {
            ztoolkit.log("[related] fetch failed", error);
            if (!refs.length && list.isConnected)
              setListMessage(list, getString("panel-load-failed"));
          } finally {
            loading = false;
            reload.disabled = false;
            list.setAttribute("aria-busy", "false");
          }
        };
        reload.addEventListener("click", () => {
          void load(false);
        });
        if (getPref("loadingRelated"))
          setTimeout(() => {
            void load(true);
          }, 350);
      },
    ),
  });
}

export function invalidateRelated(stateKeys?: string[]) {
  if (!stateKeys) cache.clear();
  else for (const key of stateKeys) cache.delete(key);
}
