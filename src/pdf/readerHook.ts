import { ReaderLinks } from "./readerLinks";
import { parsePDFReferences } from "./parser";
import { getRefsForItem } from "../ui/section";
import { getCurrentPopup, showRefPopup } from "../ui/rows";
import { itemCacheKey, refStorage } from "../core/storage";
import { getPref } from "../utils/prefs";
import type { RefItem } from "../core/types";
import { setTimeout } from "../utils/window";

/**
 * Attaches the in-PDF citation link enhancement (split-view jump + hover
 * popup) to every open reader.
 *
 * The hover card needs PDF-parsed references (only those carry page
 * anchors). The References panel may well be showing the API list for
 * this item — the common "select in library, then open the PDF" flow
 * flips it to API — so the reader keeps its own anchored list, filled
 * from the PDF cache slot or by parsing once when the reader tab is
 * shown. That never touches the panel's state or badge.
 */

const links = new ReaderLinks();

/** itemCacheKey -> PDF-parsed refs (with anchors), independent of the panel */
const anchoredRefs = new Map<string, RefItem[]>();
const anchoring = new Map<string, Promise<void>>();

function hasAnchors(refs?: RefItem[]): refs is RefItem[] {
  return !!refs?.some(
    (r) => typeof r.x === "number" && typeof r.y === "number",
  );
}

function topItemOf(reader: any): Zotero.Item | undefined {
  try {
    const readerItem = (Zotero.Items.get(reader.itemID) || undefined) as
      Zotero.Item | undefined;
    return readerItem?.parentItem ?? readerItem;
  } catch {
    return undefined;
  }
}

function refsForReader(reader: any): RefItem[] | undefined {
  const topItem = topItemOf(reader);
  if (!topItem) return undefined;
  const live = getRefsForItem(topItem);
  if (hasAnchors(live)) return live;
  return anchoredRefs.get(itemCacheKey(topItem));
}

/** make sure anchored refs exist for this reader's item (cache, else parse) */
function ensureAnchored(reader: any) {
  if (!getPref("hoverLink")) return;
  const topItem = topItemOf(reader);
  if (!topItem?.isRegularItem?.()) return;
  const key = itemCacheKey(topItem);
  if (anchoredRefs.has(key) || anchoring.has(key)) return;
  if (hasAnchors(getRefsForItem(topItem))) return;
  const job = (async () => {
    const cached = await refStorage.get(topItem, "PDF");
    if (hasAnchors(cached)) {
      anchoredRefs.set(key, cached);
      return;
    }
    const refs = await parsePDFReferences(reader, {});
    if (hasAnchors(refs)) {
      anchoredRefs.set(key, refs);
      if (getPref("savePDFReferences"))
        void refStorage.set(topItem, "PDF", refs);
    }
  })()
    .catch((e) => ztoolkit.log("[readerHook] anchor parse failed", e))
    .finally(() => anchoring.delete(key));
  anchoring.set(key, job);
}

/** drop cached anchored refs (item deleted / cache invalidated) */
export function invalidateAnchored(stateKeys?: string[]) {
  if (!stateKeys) anchoredRefs.clear();
  else for (const key of stateKeys) anchoredRefs.delete(key);
}

export function attachReader(reader: any) {
  if (!reader) return;
  links.attach(
    reader,
    () => refsForReader(reader),
    (rect, ref) => {
      showRefPopup(ref, rect, "top center");
    },
    () => {
      // pointer left the citation link with the card showing: schedule its
      // removal; entering the card cancels this timer (popup mouseenter)
      const popup = getCurrentPopup();
      if (!popup) return;
      popup.tipTimer = setTimeout(() => {
        // a newer popup may have replaced this one while the timer ran —
        // clear() removes every card in the document, so guard identity
        if (getCurrentPopup() === popup) popup.clear();
      }, popup.removeTipAfterMillisecond);
    },
  );
}

export async function attachAllReaders() {
  for (const reader of (Zotero.Reader as any)._readers || []) {
    try {
      await reader._initPromise;
    } catch {
      // reader init failed — attach will retry on next select
    }
    attachReader(reader);
  }
}

export function onReaderTabSelect(tabID: string) {
  const reader = Zotero.Reader.getByTabID(tabID);
  if (reader) {
    void (async () => {
      try {
        await (reader as any)._initPromise;
      } catch {
        // reader init failed — attach will retry on next select
      }
      attachReader(reader);
      // parse lazily, once the tab has settled (never during startup burst)
      setTimeout(() => {
        try {
          if (Zotero.Reader.getByTabID(tabID) === reader)
            ensureAnchored(reader);
        } catch {
          // reader gone
        }
      }, 1500);
    })();
  }
}

export function detachAllReaders() {
  links.detachAll();
}

/** prune state for readers whose tabs were closed */
export function sweepReaders() {
  links.sweep();
}
