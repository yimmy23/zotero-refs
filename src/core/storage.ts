import { config } from "../../package.json";
import { setTimeout, clearTimeout } from "../utils/window";
import type { RefItem } from "./types";

/** stable per-item cache key — item keys are only unique per library */
export function itemCacheKey(item: Zotero.Item): string {
  return `${item.libraryID}/${item.key}`;
}

/**
 * Bump to discard all previously persisted entries. v1 files (which had
 * no version marker) can hold DOIs backfilled from wrong library
 * title-matches — those entries must not be trusted.
 */
const SCHEMA_VERSION = 2;

/**
 * Persistent per-item reference cache, stored as one JSON file in the
 * Zotero data directory. Writes are debounced.
 *
 * File layout: { v, items: { [libraryID/itemKey]:
 *   { [slot]: { t: epochMs, refs: RefItem[] } } } } — slot is "PDF" or "API".
 */
class RefStorage {
  private cache: Record<
    string,
    Record<string, { t: number; refs: RefItem[] }>
  > = {};
  private ready: Promise<void>;
  private writeTimer?: number;
  private path = "";

  constructor() {
    this.ready = this.load();
  }

  private async load() {
    try {
      this.path = PathUtils.join(
        Zotero.DataDirectory.dir,
        `${config.addonRef}-cache.json`,
      );
      if (await IOUtils.exists(this.path)) {
        const raw = (await Zotero.File.getContentsAsync(this.path)) as string;
        const parsed = JSON.parse(raw);
        this.cache = parsed?.v === SCHEMA_VERSION ? parsed.items || {} : {};
      }
    } catch (e) {
      ztoolkit.log("[storage] load failed", e);
      this.cache = {};
    }
  }

  async get(item: Zotero.Item, slot: string): Promise<RefItem[] | undefined> {
    await this.ready;
    return this.cache[itemCacheKey(item)]?.[slot]?.refs;
  }

  async set(item: Zotero.Item, slot: string, refs: RefItem[]) {
    await this.ready;
    const itemKey = itemCacheKey(item);
    // Strip runtime-only fields before persisting. identifiers must be
    // deep-copied: the live rows keep mutating their identifiers object
    // (e.g. DOI backfill on library match) after this snapshot is taken,
    // and a shared reference would leak those mutations into the file.
    const clean = refs.map((r) => {
      const { libItemID: _drop, ...rest } = r;
      return { ...rest, identifiers: { ...rest.identifiers } } as RefItem;
    });
    (this.cache[itemKey] ??= {})[slot] = { t: Date.now(), refs: clean };
    this.evictIfNeeded();
    this.scheduleWrite();
  }

  async remove(item: Zotero.Item, slot?: string) {
    await this.ready;
    const itemKey = itemCacheKey(item);
    if (slot) {
      delete this.cache[itemKey]?.[slot];
    } else {
      delete this.cache[itemKey];
    }
    this.scheduleWrite();
  }

  async clearAll() {
    await this.ready;
    this.cache = {};
    this.scheduleWrite();
  }

  /** cap the file: keep at most this many items (LRU by slot timestamp) */
  private static MAX_ITEMS = 400;

  private evictIfNeeded() {
    const keys = Object.keys(this.cache);
    if (keys.length <= RefStorage.MAX_ITEMS) return;
    const lastUsed = (k: string) =>
      Math.max(0, ...Object.values(this.cache[k]).map((s) => s.t || 0));
    keys
      .sort((a, b) => lastUsed(a) - lastUsed(b))
      .slice(0, keys.length - RefStorage.MAX_ITEMS)
      .forEach((k) => delete this.cache[k]);
  }

  private scheduleWrite() {
    // long debounce: every flush serializes the whole cache file, so
    // batch imports must coalesce into one write
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.flush().catch((e) => ztoolkit.log("[storage] write failed", e));
    }, 1500);
  }

  async flush() {
    // never write before the initial load resolved — a flush racing the
    // load would persist an empty cache over the existing file
    await this.ready;
    if (!this.path) return;
    await Zotero.File.putContentsAsync(
      this.path,
      JSON.stringify({ v: SCHEMA_VERSION, items: this.cache }),
    );
  }
}

export const refStorage = new RefStorage();
