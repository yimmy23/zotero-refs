import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemCacheKey } from "../core/storage";
import type { Identifiers, RefItem } from "../core/types";
import { getRelatedByAPI } from "../sources";
import { hostIdentifiers } from "../core/text";
import { setTimeout } from "../utils/window";
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
  const ids = hostIdentifiers(item);
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
        const paint = (recommended: RefItem[]) => {
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
        };
        const cached = cache.get(cacheKey);
        if (cached) {
          paint(cached);
          return;
        }
        // settle debounce outside the awaited render (see section.ts)
        setTimeout(
          guard("related.autoFetch", () => {
            if (!list.isConnected) return;
            void (async () => {
              // cache only real results — a transient API failure must stay
              // retryable on the next render
              const fetched = await getRelatedByAPI(ids, 20);
              if (fetched) {
                if (cache.size >= 150) {
                  const oldest = cache.keys().next().value;
                  if (oldest !== undefined) cache.delete(oldest);
                }
                cache.set(cacheKey, fetched);
              }
              paint(fetched || []);
            })().catch((e) => ztoolkit.log("[related] fetch failed", e));
          }),
          350,
        );
      },
    ),
  });
}

export function invalidateRelated(stateKeys?: string[]) {
  if (!stateKeys) cache.clear();
  else for (const key of stateKeys) cache.delete(key);
}
