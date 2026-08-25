import { ReaderLinks } from "./readerLinks";
import { setTimeout } from "../utils/window";

/**
 * Attaches the in-PDF citation-link click enhancement (split-view jump)
 * to every open reader.
 *
 * Hover previews are left to Zotero's native citation popup (user
 * decision, 2026-08-25) — the plugin no longer wraps
 * `_onSetOverlayPopup` or keeps its own anchored reference list here.
 */

const links = new ReaderLinks();

export function attachReader(reader: any) {
  if (!reader) return;
  links.attach(reader);
}

export async function attachAllReaders() {
  const pass = async () => {
    // a late sweep must never re-wrap after plugin shutdown
    if (!addon.data.alive) return;
    for (const reader of (Zotero.Reader as any)._readers || []) {
      try {
        await reader._initPromise;
      } catch {
        // reader init failed — attach will retry on next select
      }
      attachReader(reader);
    }
  };
  await pass();
  // session-restored readers are created after this loop runs, and their
  // tab-add notification fires before our notifier registers; selecting
  // an already-selected tab fires nothing either. attach() is idempotent
  // (the already-live guard verifies view identity + wrap), so late
  // sweeps are free — they only catch readers the first pass missed.
  setTimeout(() => void pass(), 3000);
  setTimeout(() => void pass(), 10000);
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

/** dev-only introspection of a reader's attach state (used by devEval) */
export function readerLinkState(reader: any): any {
  return (links as any).states?.get(reader);
}
