import { ReaderLinks } from "./readerLinks";
import { parsePDFReferences } from "./parser";
import { getRefsForItem } from "../ui/section";
import { getCurrentPopup, showRefPopup } from "../ui/rows";
import { itemCacheKey, refStorage } from "../core/storage";
import { importReference, addRelation } from "../core/importer";
import { isRelated } from "../core/libmatch";
import { collapseText } from "../core/text";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import type { RefItem } from "../core/types";
import { setTimeout } from "../utils/window";

/**
 * Attaches the in-PDF citation link enhancement (split-view jump + hover
 * popup) to every open reader.
 *
 * The hover card matches citation overlays by their printed entry text
 * (the Zotero 10 reader extracts the bibliography itself) and internal
 * links by our parsed page anchors. When the References panel hasn't
 * rendered for this item, the reader keeps its own list, filled from the
 * FUSED / PDF cache slots or by parsing once when the reader tab is
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

export function refsForReader(reader: any): RefItem[] | undefined {
  const topItem = topItemOf(reader);
  if (!topItem) return undefined;
  // the fused panel list serves both matching paths: citation overlays
  // match by printed text (no anchors needed), internal links by anchors
  const live = getRefsForItem(topItem);
  if (live?.length) return live;
  return anchoredRefs.get(itemCacheKey(topItem));
}

/** make sure anchored refs exist for this reader's item (cache, else parse) */
function ensureAnchored(reader: any) {
  if (!getPref("hoverLink")) return;
  const topItem = topItemOf(reader);
  if (!topItem?.isRegularItem?.()) return;
  const key = itemCacheKey(topItem);
  if (anchoredRefs.has(key) || anchoring.has(key)) return;
  if (getRefsForItem(topItem)?.length) return;
  const job = (async () => {
    // the fused slot carries anchors AND the API enrichment (DOI, counts)
    const fused = await refStorage.get(topItem, "FUSED");
    if (fused?.length) {
      anchoredRefs.set(key, fused);
      return;
    }
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

/** import the hovered reference and relate it to the reader's item */
async function importFromReader(hostItem: Zotero.Item, ref: RefItem) {
  const label = collapseText(ref.title || ref.text || "");
  const popupWin = new ztoolkit.ProgressWindow(getString("graph-menu-import"), {
    closeTime: -1,
    closeOtherProgressWindows: true,
  })
    .createLine({ text: label, type: "default", progress: 10 })
    .show();
  try {
    const refItem = await importReference(hostItem, ref, undefined, (m) =>
      popupWin.changeLine({ text: m }),
    );
    if (!refItem) {
      popupWin.changeLine({ text: `✗ ${label}`, type: "fail", progress: 100 });
      popupWin.startCloseTimer(4000);
      return;
    }
    if (!isRelated(hostItem, refItem)) await addRelation(hostItem, refItem);
    ref.libItemID = refItem.id;
    popupWin.changeLine({ text: `✓ ${label}`, type: "success", progress: 100 });
    popupWin.startCloseTimer(3000);
  } catch (e) {
    ztoolkit.log("[readerHook] import failed", e);
    popupWin.changeLine({ text: `✗ ${label}`, type: "fail", progress: 100 });
    popupWin.startCloseTimer(4000);
  }
}

export function attachReader(reader: any) {
  if (!reader) return;
  links.attach(
    reader,
    () => refsForReader(reader),
    (rect, ref) => {
      const topItem = topItemOf(reader);
      showRefPopup(
        ref,
        rect,
        "top center",
        undefined,
        topItem
          ? { onImport: () => void importFromReader(topItem, ref) }
          : undefined,
      );
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
  // the reader tab already focused at startup never fires a tab-select
  // notification — prime its reference list too (cache first, parse once)
  setTimeout(() => {
    try {
      for (const win of Zotero.getMainWindows()) {
        const tabID = (win as any).Zotero_Tabs?.selectedID;
        const reader = tabID ? Zotero.Reader.getByTabID(tabID) : null;
        if (reader) ensureAnchored(reader);
      }
    } catch (e) {
      ztoolkit.log("[readerHook] startup prime failed", e);
    }
  }, 1500);
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
