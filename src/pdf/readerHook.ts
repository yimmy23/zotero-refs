import { ReaderLinks } from "./readerLinks";
import { getRefsForItem } from "../ui/section";
import { getCurrentPopup, showRefPopup } from "../ui/rows";
import type { RefItem } from "../core/types";
import { setTimeout } from "../utils/window";

/**
 * Attaches the in-PDF citation link enhancement (split-view jump + hover
 * popup) to every open reader.
 */

const links = new ReaderLinks();

function refsForReader(reader: any): RefItem[] | undefined {
  try {
    const readerItem = (Zotero.Items.get(reader.itemID) || undefined) as
      Zotero.Item | undefined;
    const topItem = readerItem?.parentItem ?? readerItem;
    if (!topItem) return undefined;
    return getRefsForItem(topItem);
  } catch {
    return undefined;
  }
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
