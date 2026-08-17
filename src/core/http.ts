import { getNumPref, getPref } from "../utils/prefs";

/**
 * HTTP layer shared by all metadata sources.
 *
 * - de-duplicates identical in-flight requests
 * - memory cache with TTL (bounded, LRU eviction)
 * - per-host concurrency limit so no API gets hammered
 * - retry with backoff on 429 / 5xx (honors Retry-After)
 * - never throws: resolves null on failure (logged)
 */

interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
  responseType?: "json" | "text";
  /** cache time-to-live in ms; 0 disables caching. Default: pref cacheTTLHours */
  ttl?: number;
  timeout?: number;
  retries?: number;
  /** include credentials (cookies) */
  credentials?: boolean;
  noCache?: boolean;
  /** max bytes of the request body Zotero.HTTP may write to debug logs (0 = none) */
  logBodyLength?: number;
}

interface CacheEntry {
  t: number;
  ttl: number;
  v: any;
  bytes: number;
}

const MAX_CACHE_ENTRIES = 500;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15000;
const HOST_LIMITS: Record<string, number> = {
  "api.crossref.org": 3,
  "api.semanticscholar.org": 2,
  "api.openalex.org": 4,
  "export.arxiv.org": 2,
  "eutils.ncbi.nlm.nih.gov": 3,
  "kns.cnki.net": 1,
  default: 4,
};

class HostGate {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private limit: number) {}

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    // LIFO: wake the most recently queued waiter first, so the newest
    // user action (e.g. the currently hovered popup) jumps the queue
    const next = this.queue.pop();
    if (next) next();
  }
}

/** cached marker for "this lookup failed recently" */
const NULL_SENTINEL = Object.freeze({ __refsNull: true });
const NULL_TTL = 10 * 60 * 1000;

class Http {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<any>>();
  private gates = new Map<string, HostGate>();

  private defaultTTL() {
    return getNumPref("cacheTTLHours", 168) * 3600 * 1000;
  }

  private gateFor(url: string) {
    let host = "default";
    try {
      host = new URL(url).host;
    } catch {
      // not a URL — use the default gate
    }
    let gate = this.gates.get(host);
    if (!gate) {
      gate = new HostGate(HOST_LIMITS[host] ?? HOST_LIMITS.default);
      this.gates.set(host, gate);
    }
    return gate;
  }

  private cacheGet(key: string) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.t > entry.ttl) {
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
      return undefined;
    }
    // LRU: refresh position
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.v;
  }

  private cacheBytes = 0;

  private cacheSet(key: string, v: any, ttl: number) {
    if (ttl <= 0) return;
    let bytes: number;
    try {
      bytes = typeof v === "string" ? v.length : JSON.stringify(v)?.length || 0;
    } catch {
      bytes = 0;
    }
    if (bytes > MAX_ENTRY_BYTES) return;
    while (
      this.cache.size >= MAX_CACHE_ENTRIES ||
      this.cacheBytes + bytes > MAX_CACHE_BYTES
    ) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheBytes -= this.cache.get(oldest)?.bytes || 0;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { t: Date.now(), ttl, v, bytes });
    this.cacheBytes += bytes;
  }

  clearCache() {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  async request<T = any>(
    method: "GET" | "POST",
    url: string,
    options: RequestOptions = {},
  ): Promise<T | null> {
    const key = `${method} ${url} ${options.body || ""}`;
    if (options.noCache) {
      return this.doRequest(method, url, options);
    }
    const cached = this.cacheGet(key);
    if (cached === NULL_SENTINEL) return null;
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.doRequest(method, url, options)
      .then((result) => {
        if (result !== null) {
          this.cacheSet(key, result, options.ttl ?? this.defaultTTL());
        } else if (options.ttl !== 0) {
          // negative cache: a 404 / failed lookup is not retried on every
          // re-hover; short TTL so a transient outage heals itself
          this.cacheSet(key, NULL_SENTINEL, NULL_TTL);
        }
        return result;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private async doRequest(
    method: "GET" | "POST",
    url: string,
    options: RequestOptions,
  ): Promise<any> {
    const gate = this.gateFor(url);
    const maxRetries = options.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      await gate.acquire();
      // every path that falls through to the delay assigns retryWait first
      let retryWait!: number;
      try {
        const xhr = await Zotero.HTTP.request(method, url, {
          headers: options.headers,
          body: options.body,
          responseType: options.responseType ?? "json",
          timeout: options.timeout ?? DEFAULT_TIMEOUT,
          successCodes: false,
          ...(options.logBodyLength !== undefined
            ? { logBodyLength: options.logBodyLength }
            : {}),
          ...(options.credentials ? { credentials: "include" as any } : {}),
        });
        const status = xhr.status;
        if (status >= 200 && status < 300) {
          return xhr.response ?? xhr.responseText;
        }
        if ((status === 429 || status >= 500) && attempt < maxRetries) {
          const retryAfter = Number(xhr.getResponseHeader?.("Retry-After"));
          retryWait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
          ztoolkit.log(`[http] ${status} ${url}, retry in ${retryWait}ms`);
        } else {
          ztoolkit.log(`[http] ${method} ${url} -> ${status}`);
          return null;
        }
      } catch (e) {
        if (attempt < maxRetries) {
          retryWait = 1000 * 2 ** attempt;
        } else {
          ztoolkit.log(`[http] ${method} ${url} failed`, e);
          return null;
        }
      } finally {
        gate.release();
      }
      await Zotero.Promise.delay(retryWait);
    }
  }

  getJSON<T = any>(url: string, options: RequestOptions = {}) {
    return this.request<T>("GET", url, { ...options, responseType: "json" });
  }

  getText(url: string, options: RequestOptions = {}) {
    return this.request<string>("GET", url, {
      ...options,
      responseType: "text",
    });
  }

  postJSON<T = any>(url: string, body: any, options: RequestOptions = {}) {
    return this.request<T>("POST", url, {
      ...options,
      responseType: options.responseType ?? "json",
      headers: { "Content-Type": "application/json", ...options.headers },
      body: JSON.stringify(body),
    });
  }

  postForm<T = any>(url: string, body: string, options: RequestOptions = {}) {
    return this.request<T>("POST", url, {
      ...options,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...options.headers,
      },
      body,
    });
  }
}

export const http = new Http();

/** polite-pool email for Crossref / OpenAlex / Unpaywall */
export function politeEmail(): string {
  const email = (getPref("email") as string)?.trim();
  return email || "zotero-refs@mailinator.com";
}
