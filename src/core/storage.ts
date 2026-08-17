import { config } from "../../package.json";
import { setTimeout, clearTimeout } from "../utils/window";
import { cleanText, isHttpUrl } from "./text";
import type { RefItem } from "./types";

/**
 * What one persisted reference may contain. Applied both when writing and
 * when reading the file, so a hand-edited / poisoned cache cannot inject
 * launchable URLs, wrong item bindings or arbitrary payloads into the UI.
 * abstract/description are dropped: the hover card refetches them and they
 * dominate file size otherwise.
 */
function sanitizeRef(r: any): RefItem | null {
  if (!r || typeof r !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const ids: Record<string, string> = {};
  if (r.identifiers && typeof r.identifiers === "object") {
    for (const [k, v] of Object.entries(r.identifiers)) {
      if (typeof v === "string" && v.length < 300) ids[k] = v;
    }
  }
  const out: RefItem = {
    identifiers: ids,
    authors: Array.isArray(r.authors)
      ? r.authors.filter((a: unknown) => typeof a === "string").slice(0, 50)
      : [],
    // markup left by APIs in older caches ("<i>ALK</i>") is cleaned here too
    title: cleanText(str(r.title)),
    text: cleanText(str(r.text)),
    year: str(r.year) ?? (typeof r.year === "number" ? String(r.year) : undefined),
    type: str(r.type) || "journalArticle",
    primaryVenue: cleanText(str(r.primaryVenue)),
    publishDate: str(r.publishDate),
    number: typeof r.number === "number" ? r.number : undefined,
    x: typeof r.x === "number" ? r.x : undefined,
    y: typeof r.y === "number" ? r.y : undefined,
    page: typeof r.page === "number" ? r.page : undefined,
    citationCount:
      typeof r.citationCount === "number" ? r.citationCount : undefined,
    source: str(r.source) as RefItem["source"],
    url: isHttpUrl(r.url) ? r.url : undefined,
    oaUrl: isHttpUrl(r.oaUrl) ? r.oaUrl : undefined,
    retracted: r.retracted === true ? true : undefined,
  };
  if (!out.text && !out.title) return null;
  return out;
}

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
        const items = parsed?.v === SCHEMA_VERSION ? parsed.items || {} : {};
        // never trust the file: re-validate every entry on the way in
        const clean: typeof this.cache = {};
        for (const [key, slots] of Object.entries<any>(items)) {
          if (!slots || typeof slots !== "object") continue;
          for (const [slot, entry] of Object.entries<any>(slots)) {
            if (!Array.isArray(entry?.refs)) continue;
            const refs = entry.refs
              .map(sanitizeRef)
              .filter((r: RefItem | null): r is RefItem => !!r);
            if (!refs.length) continue;
            (clean[key] ??= {})[slot] = { t: Number(entry.t) || 0, refs };
          }
        }
        this.cache = clean;
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
    const clean = refs
      .map(sanitizeRef)
      .filter((r): r is RefItem => !!r);
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
