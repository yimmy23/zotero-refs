import { ReaderLinks } from "./readerLinks";
import { clearTimeout, setTimeout } from "../utils/window";

/**
 * Attaches optional Alt/Option+click split-view navigation to every open
 * reader. Ordinary link and citation clicks keep Zotero's native jump.
 *
 * Hover previews are left to Zotero's native citation popup (user
 * decision, 2026-08-25) — the plugin no longer wraps
 * `_onSetOverlayPopup` or keeps its own anchored reference list here.
 */

const links = new ReaderLinks();
let active = true;
let generation = 0;
const sweepTimers = new Set<number>();

export function attachReader(reader: any) {
  if (!reader || !active || !addon.data.alive) return;
  links.attach(reader);
}

export async function attachAllReaders() {
  if (!addon.data.alive) return;
  active = true;
  const current = generation;
  const pass = async () => {
    // a late sweep must never re-wrap after plugin shutdown
    if (!active || !addon.data.alive || current !== generation) return;
    for (const reader of (Zotero.Reader as any)._readers || []) {
      try {
        await reader._initPromise;
      } catch {
        // reader init failed — attach will retry on next select
      }
      if (!active || !addon.data.alive || current !== generation) return;
      attachReader(reader);
    }
  };
  await pass();
  // session-restored readers are created after this loop runs, and their
  // tab-add notification fires before our notifier registers; selecting
  // an already-selected tab fires nothing either. attach() is idempotent
  // (the already-live guard verifies view identity + wrap), so late
  // sweeps are free — they only catch readers the first pass missed.
  if (!active || !addon.data.alive || current !== generation) return;
  for (const delay of [3000, 10000]) {
    const timer = setTimeout(() => {
      sweepTimers.delete(timer);
      void pass();
    }, delay);
    sweepTimers.add(timer);
  }
}

export function onReaderTabSelect(tabID: string) {
  if (!active || !addon.data.alive) return;
  const current = generation;
  const reader = Zotero.Reader.getByTabID(tabID);
  if (reader) {
    void (async () => {
      try {
        await (reader as any)._initPromise;
      } catch {
        // reader init failed — attach will retry on next select
      }
      if (!active || !addon.data.alive || current !== generation) return;
      attachReader(reader);
    })();
  }
}

export function detachAllReaders() {
  active = false;
  generation++;
  for (const timer of sweepTimers) clearTimeout(timer);
  sweepTimers.clear();
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
