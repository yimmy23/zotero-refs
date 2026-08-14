import { ReaderLinks } from "./readerLinks";
import { getRefsForItem } from "../ui/section";
import { showRefPopup } from "../ui/rows";
import type { RefItem } from "../core/types";

/**
 * Attaches the in-PDF citation link enhancement (split-view jump + hover
 * popup) to every open reader.
 */

const links = new ReaderLinks();

function refsForReader(reader: any): RefItem[] | undefined {
  try {
    const readerItem = (Zotero.Items.get(reader.itemID) ||
      undefined) as Zotero.Item | undefined;
    const key = readerItem?.parentItem?.key ?? readerItem?.key;
    if (!key) return undefined;
    return getRefsForItem(key);
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
  );
}

export async function attachAllReaders() {
  for (const reader of (Zotero.Reader as any)._readers || []) {
    try {
      await reader._initPromise;
    } catch {}
    attachReader(reader);
  }
}

export function onReaderTabSelect(tabID: string) {
  const reader = Zotero.Reader.getByTabID(tabID);
  if (reader) {
    void (async () => {
      try {
        await (reader as any)._initPromise;
      } catch {}
      attachReader(reader);
    })();
  }
}

export function detachAllReaders() {
  links.detachAll();
}
