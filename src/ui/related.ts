import { createSearch, actionButton, setListMessage } from "./controls";
import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { itemStateKey } from "../core/storage";
import type { Identifiers, RefItem } from "../core/types";
import { SOURCE_NAME } from "../core/types";
import { cloneRelatedRef, sameRelatedPaper } from "../core/related";
import type { RelatedResult } from "../core/related";
import { getRelatedByAPI } from "../sources";
import { hostIdentifiers, isHttpUrl } from "../core/text";
import { setTimeout, clearTimeout } from "../utils/window";
import { renderRefRow, filterRows } from "./rows";
import { guard, guardAsync } from "../utils/guard";
import type { RowContext } from "./rows";

/**
 * "Related Papers" item pane section — recommendations for the current
 * item (the original plugin's 推荐关联, now in its own section instead of
 * hacking the native Related box). Manual links remain first; remote
 * recommendations retain their source-list evidence, not a probability.
 */

const cache = new Map<string, { result: RelatedResult; time: number }>();
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_LIMIT = 40;
const RESULT_LIMIT = 20;
const views = new WeakMap<
  HTMLElement,
  {
    dispose(): void;
    sync(): void;
  }
>();

function isOpen(body: HTMLElement): boolean {
  const section = body.closest("collapsible-section") as
    (Element & { open?: boolean }) | null;
  const doc = body.ownerDocument;
  return section?.open !== false && !!doc && !doc.hidden;
}

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
    onItemChange: guard(
      "related.onItemChange",
      ({ body, item, setEnabled }) => {
        views.get(body)?.dispose();
        setEnabled(!!item?.isRegularItem?.());
        return true;
      },
    ),
    onToggle: guard("related.onToggle", ({ body }) => views.get(body)?.sync()),
    onDestroy: guard("related.onDestroy", ({ body }) =>
      views.get(body)?.dispose(),
    ),
    onRender: () => {},
    onAsyncRender: guardAsync(
      "related.onAsyncRender",
      async ({ body, item, setSectionSummary }) => {
        if (!item?.isRegularItem?.()) return;
        const doc = body.ownerDocument!;
        views.get(body)?.dispose();
        body.textContent = "";
        (body as HTMLElement).classList.add("references-panel");
        (body as HTMLElement).classList.add("references-related-panel");

        const toolbar = doc.createElement("div");
        toolbar.className = "references-toolbar";
        const count = doc.createElement("span");
        count.className = "references-count";
        toolbar.append(count);
        const reload = actionButton(
          doc,
          "references-icon-refresh",
          getString("related-refresh"),
          getString("related-refresh-tip"),
        );
        toolbar.append(reload);
        body.append(toolbar);
        const search = createSearch(
          body as HTMLElement,
          getString("related-search-placeholder"),
        );
        const status = doc.createElement("div");
        status.className = "references-related-status";
        status.setAttribute("role", "status");
        status.title = getString("related-ranking-tip");
        body.append(status);

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
        const refs: RefItem[] = [];

        const update = () => {
          count.textContent = `${refs.length} ${getString(
            "related-count-suffix",
          )}`;
          setSectionSummary(`${refs.length}`);
        };
        const ids = idsOf(item);
        reload.disabled = !ids;
        const cacheKey = itemStateKey(item);
        let timer: number | undefined;
        let request = 0;
        let loading = false;
        let requested = !!getPref("loadingRelated");
        let disposed = false;
        let last: RelatedResult | undefined;
        const view = {
          dispose() {
            disposed = true;
            request++;
            clearTimeout(timer);
            doc.removeEventListener("visibilitychange", onVisibility);
            views.delete(body);
          },
          sync() {
            if (disposed) return;
            clearTimeout(timer);
            timer = undefined;
            if (!isOpen(body)) {
              request++;
              loading = false;
              reload.disabled = !ids;
              list.setAttribute("aria-busy", "false");
            } else {
              paint(last);
              if (requested && !loading && !last?.complete)
                timer = setTimeout(() => void load(true), 350);
            }
          },
        };
        const onVisibility = () => view.sync();
        doc.addEventListener("visibilitychange", onVisibility);
        views.set(body, view);
        const current = () =>
          !disposed &&
          isOpen(body) &&
          list.isConnected &&
          itemStateKey(item) === cacheKey &&
          addon.data.alive;
        const paint = (result?: RelatedResult) => {
          if (!current()) return;
          last = result;
          refs.splice(0, refs.length, ...zoteroRelated(item));
          list.textContent = "";
          const seed: RefItem = {
            identifiers: hostIdentifiers(item),
            authors: [],
            title: item.getField("title") as string,
          };
          const reasons = refs.map(() => ({
            text: getString("related-manual"),
            title: getString("related-manual-tip"),
          }));
          // The fusion layer already deduplicates recommendations and retains
          // ambiguous ID bridges deliberately. Exclude only host/manual links.
          const excluded = [seed, ...refs];
          let recommended = 0;
          for (const candidate of result?.items || []) {
            if (recommended >= RESULT_LIMIT) break;
            if (excluded.some((ref) => sameRelatedPaper(ref, candidate.ref)))
              continue;
            // Rows enrich local bindings and can be imported. Never hand them
            // the cached provider object or overwrite the paper's description.
            refs.push(cloneRelatedRef(candidate.ref));
            reasons.push({
              text: candidate.evidence
                .map(({ source, rank }) =>
                  getString("related-source-rank", {
                    args: { source: SOURCE_NAME[source], rank },
                  }),
                )
                .join(" · "),
              title: getString("related-ranking-tip"),
            });
            recommended++;
          }
          refs.forEach((_, i) => {
            const row = renderRefRow(ctx, refs, i);
            row.classList.add("references-related-row");
            const reason = doc.createElement("div");
            reason.className = "references-related-reason";
            reason.textContent = reasons[i].text;
            reason.title = reasons[i].title;
            row.append(reason);
          });
          if (result) {
            const available = result.sources.filter(
              (source) => source.status === "ready",
            );
            const unavailable = result.sources.some(
              (source) => source.status === "unavailable",
            );
            status.textContent = getString(
              !result.complete
                ? "related-loading-more"
                : unavailable
                  ? available.length
                    ? "related-partial"
                    : "panel-load-failed"
                  : "related-ranking",
              {
                args: {
                  sources: available
                    .map(({ source }) => SOURCE_NAME[source])
                    .join(" + "),
                },
              },
            );
          } else
            status.textContent = ids ? "" : getString("related-no-identifier");
          if (search.value) filterRows(list, search.value);
          if (!refs.length) {
            const unavailable =
              result?.sources.filter(({ status }) => status === "unavailable")
                .length || 0;
            const emptyMessage = !result
              ? "related-empty"
              : !result.complete
                ? "panel-loading"
                : unavailable === result.sources.length
                  ? "panel-load-failed"
                  : unavailable
                    ? "related-partial-empty"
                    : "related-empty-result";
            setListMessage(list, getString(emptyMessage));
            if (emptyMessage === "panel-load-failed") status.textContent = "";
          }
          update();
        };
        const load = async (useCache: boolean) => {
          if (!ids || loading || !current()) return;
          const generation = ++request;
          const owns = () => current() && generation === request;
          loading = true;
          reload.disabled = true;
          list.setAttribute("aria-busy", "true");
          if (!refs.length) setListMessage(list, getString("panel-loading"));
          try {
            const saved = useCache ? cache.get(cacheKey) : undefined;
            const fresh = saved && Date.now() - saved.time < CACHE_TTL;
            const fetched = fresh
              ? saved.result
              : await getRelatedByAPI(
                  ids,
                  40,
                  (partial) => {
                    if (owns()) paint(partial);
                  },
                  owns,
                );
            if (!owns()) return;
            if (
              fetched.complete &&
              fetched.sources.every(({ status }) => status === "ready")
            ) {
              cache.delete(cacheKey);
              if (cache.size >= CACHE_LIMIT) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
              }
              cache.set(cacheKey, {
                result: fetched,
                time: fresh ? saved.time : Date.now(),
              });
            }
            paint(fetched);
          } catch (error) {
            ztoolkit.log("[related] fetch failed", error);
            if (owns()) status.textContent = getString("panel-load-failed");
          } finally {
            if (generation === request) {
              loading = false;
              if (!disposed) {
                reload.disabled = false;
                list.setAttribute("aria-busy", "false");
              }
            }
          }
        };
        reload.addEventListener("click", () => {
          requested = true;
          void load(false);
        });
        view.sync();
      },
    ),
  });
}

export function invalidateRelated(stateKeys?: string[]) {
  if (!stateKeys) cache.clear();
  else
    for (const key of cache.keys())
      if (
        stateKeys.some(
          (stateKey) => key === stateKey || key.startsWith(`${stateKey}@`),
        )
      )
        cache.delete(key);
}
