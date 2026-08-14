import { config } from "../../package.json";
import { setTimeout, clearTimeout } from "../utils/window";
import type { RefItem } from "./types";

/** stable per-item cache key — item keys are only unique per library */
export function itemCacheKey(item: Zotero.Item): string {
  return `${item.libraryID}/${item.key}`;
}

/**
 * Persistent per-item reference cache, stored as one JSON file in the
 * Zotero data directory. Writes are debounced.
 *
 * Layout: { [libraryID/itemKey]: { [slot]: { t: epochMs, refs: RefItem[] } } }
 * slot is "PDF" or "API".
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
        this.cache = JSON.parse(raw);
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
    // strip runtime-only fields before persisting
    const clean = refs.map((r) => {
      const { libItemID: _drop, ...rest } = r;
      return rest as RefItem;
    });
    (this.cache[itemKey] ??= {})[slot] = { t: Date.now(), refs: clean };
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

  private scheduleWrite() {
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.flush().catch((e) => ztoolkit.log("[storage] write failed", e));
    }, 500);
  }

  async flush() {
    // never write before the initial load resolved — a flush racing the
    // load would persist an empty cache over the existing file
    await this.ready;
    if (!this.path) return;
    await Zotero.File.putContentsAsync(this.path, JSON.stringify(this.cache));
  }
}

export const refStorage = new RefStorage();
