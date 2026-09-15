import { getNumPref, getPref } from "../utils/prefs";
import { clearTimeout, setTimeout } from "../utils/window";
import type { RequestFailure, SourceRequestOptions } from "./types";

/**
 * HTTP layer shared by all metadata sources.
 *
 * - de-duplicates identical in-flight requests
 * - memory cache with TTL (bounded, LRU eviction)
 * - per-host concurrency limit so no API gets hammered
 * - retry with backoff on 429 / 5xx (honors Retry-After)
 * - never throws: resolves null on failure (logged)
 */

export interface RequestOptions extends SourceRequestOptions {
  headers?: Record<string, string>;
  body?: string;
  responseType?: "json" | "text";
  /** cache time-to-live in ms; 0 disables caching. Default: pref cacheTTLHours */
  ttl?: number;
  /** Per-attempt transport timeout, bounded by the remaining total budget. */
  timeout?: number;
  /** Total queue + transport + backoff budget. Default: 30 seconds. */
  totalTimeout?: number;
  retries?: number;
  /** include credentials (cookies) */
  credentials?: boolean;
  /** Legacy alias for cachePolicy: "no-store". */
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
const DEFAULT_TOTAL_TIMEOUT = 30000;

export type HttpResult<T> =
  { ok: true; data: T } | { ok: false; error: RequestFailure };

function deadlineFailure(): RequestFailure {
  return { kind: "deadline", recoverable: true };
}

type Deadline = number | (() => number);
const deadlineAt = (deadline: Deadline) =>
  typeof deadline === "function" ? deadline() : deadline;

interface SharedRequest {
  /** Extended by each subscriber; one short-lived owner cannot expire another. */
  deadline: number;
  promise: Promise<HttpResult<any>>;
}

/** A caller may stop waiting without cancelling another caller's shared work. */
async function untilDeadline<T>(
  promise: Promise<T>,
  deadline: Deadline,
  fallback: T,
): Promise<T> {
  const remaining = deadlineAt(deadline) - Date.now();
  if (remaining <= 0) return fallback;
  if (!Number.isFinite(remaining)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        const expire = () => {
          const wait = deadlineAt(deadline) - Date.now();
          // A later subscriber may have extended the shared gate's deadline.
          if (wait > 0) timer = setTimeout(expire, wait);
          else resolve(fallback);
        };
        timer = setTimeout(expire, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const HOST_LIMITS: Record<string, number> = {
  "api.crossref.org": 3,
  "api.semanticscholar.org": 2,
  "api.openalex.org": 4,
  "export.arxiv.org": 1,
  "eutils.ncbi.nlm.nih.gov": 3,
  "kns.cnki.net": 1,
  default: 4,
};

const HOST_INTERVALS: Record<string, number> = {
  "export.arxiv.org": 3000,
  "eutils.ncbi.nlm.nih.gov": 350,
};

class HostGate {
  private active = 0;
  private queue: Array<() => void> = [];
  private nextStart = 0;
  private starting: Promise<void> = Promise.resolve();
  private deferred?: RequestFailure;
  constructor(
    private limit: number,
    private interval = 0,
  ) {}

  get cooldown(): RequestFailure | undefined {
    return this.deferred?.retryAt && this.deferred.retryAt > Date.now()
      ? this.deferred
      : undefined;
  }

  defer(error: RequestFailure) {
    if ((error.retryAt || 0) > (this.deferred?.retryAt || 0))
      this.deferred = error;
  }

  async acquire(deadline: Deadline = Infinity): Promise<boolean> {
    if (
      Date.now() >= deadlineAt(deadline) ||
      (this.cooldown?.retryAt || 0) >= deadlineAt(deadline)
    )
      return false;
    if (this.active < this.limit) this.active++;
    else {
      let wake!: () => void;
      let entered = false;
      const waiting = new Promise<boolean>((resolve) => {
        wake = () => {
          entered = true;
          resolve(true);
        };
        this.queue.push(wake);
      });
      if (!(await untilDeadline(waiting, deadline, false))) {
        const index = this.queue.indexOf(wake);
        if (index >= 0) this.queue.splice(index, 1);
        else if (entered) this.release();
        return false;
      }
    }
    // Serialize actual starts so waking overdue timers never creates a burst.
    let expired = false;
    const start = this.starting.then(async () => {
      if (expired || Date.now() >= deadlineAt(deadline)) return false;
      while (true) {
        const earliest = Math.max(this.nextStart, this.cooldown?.retryAt || 0);
        if (earliest >= deadlineAt(deadline)) return false;
        const wait = earliest - Date.now();
        if (wait <= 0) break;
        await Zotero.Promise.delay(wait);
        if (expired || Date.now() >= deadlineAt(deadline)) return false;
        if ((this.cooldown?.retryAt || 0) <= earliest) break;
      }
      this.nextStart = Date.now() + this.interval;
      return true;
    });
    this.starting = start.then(
      () => {},
      () => {},
    );
    try {
      const acquired = await untilDeadline(start, deadline, false);
      if (!acquired) {
        expired = true;
        this.release();
      }
      return acquired;
    } catch (error) {
      expired = true;
      this.release();
      throw error;
    }
  }

  release() {
    // Transfer the reserved slot to the newest waiting consumer (LIFO).
    const next = this.queue.pop();
    if (next) next();
    else this.active--;
  }
}

const NOT_FOUND_TTL = 10 * 60 * 1000;

class Http {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, SharedRequest>();
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
      gate = new HostGate(
        HOST_LIMITS[host] ?? HOST_LIMITS.default,
        HOST_INTERVALS[host] ?? 0,
      );
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
    const replaced = this.cache.get(key);
    if (replaced) {
      this.cacheBytes -= replaced.bytes;
      this.cache.delete(key);
    }
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
    const result = await this.requestResult<T>(method, url, options);
    return result.ok ? result.data : null;
  }

  async requestResult<T = any>(
    method: "GET" | "POST",
    url: string,
    options: RequestOptions = {},
  ): Promise<HttpResult<T>> {
    const deadline = Math.min(
      options.deadline ?? Infinity,
      Date.now() + Math.max(0, options.totalTimeout ?? DEFAULT_TOTAL_TIMEOUT),
    );
    // Representation and authorization context are part of request identity.
    const key = JSON.stringify([
      method,
      url,
      options.body || "",
      options.responseType ?? "json",
      !!options.credentials,
      Object.entries(options.headers || {})
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const policy = options.noCache
      ? "no-store"
      : options.cachePolicy || "default";
    const ttl = options.ttl ?? this.defaultTTL();
    if (policy === "default" && ttl > 0) {
      const cached = this.cacheGet(key);
      if (cached !== undefined) return cached;
    }
    if (Date.now() >= deadline) return { ok: false, error: deadlineFailure() };
    // no-store has its own shared work: it must neither read nor populate cache.
    const pendingKey = policy === "no-store" ? `no-store:${key}` : key;
    let pending = this.inflight.get(pendingKey);
    if (pending) {
      pending.deadline = Math.max(pending.deadline, deadline);
    } else {
      const shared: SharedRequest = {
        deadline,
        promise: undefined!,
      };
      shared.promise = this.doRequest(method, url, options, shared)
        .then((result) => {
          if (policy !== "no-store") {
            if (result.ok) this.cacheSet(key, result, ttl);
            else if (result.error.kind === "not_found") {
              this.cacheSet(key, result, Math.min(ttl, NOT_FOUND_TTL));
            }
            // Transient failures never become ordinary ten-minute null entries.
          }
          return result;
        })
        .finally(() => {
          if (this.inflight.get(pendingKey) === shared)
            this.inflight.delete(pendingKey);
        });
      this.inflight.set(pendingKey, shared);
      pending = shared;
    }
    // Each subscriber owns its wait, while the real transport retains its slot
    // until it settles. A shorter subscriber never shortens the shared work.
    return untilDeadline(pending.promise, deadline, {
      ok: false,
      error: deadlineFailure(),
    });
  }

  private async doRequest(
    method: "GET" | "POST",
    url: string,
    options: RequestOptions,
    shared: SharedRequest,
  ): Promise<HttpResult<any>> {
    const gate = this.gateFor(url);
    const deadline = () => shared.deadline;
    const maxRetries = options.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      if (!(await gate.acquire(deadline))) {
        return { ok: false, error: gate.cooldown || deadlineFailure() };
      }
      let failure: RequestFailure;
      let extendedTimeout = false;
      const transportDeadline = deadline();
      let retryWait = 1000 * 2 ** attempt;
      try {
        const remaining = deadline() - Date.now();
        if (remaining <= 0) return { ok: false, error: deadlineFailure() };
        const xhr = await Zotero.HTTP.request(method, url, {
          headers: options.headers,
          body: options.body,
          responseType: options.responseType ?? "json",
          timeout: Math.max(
            1,
            Math.min(options.timeout ?? DEFAULT_TIMEOUT, remaining),
          ),
          successCodes: false,
          ...(options.logBodyLength !== undefined
            ? { logBodyLength: options.logBodyLength }
            : {}),
          ...(options.credentials ? { credentials: "include" as any } : {}),
        });
        const status = xhr.status;
        if (Date.now() >= deadline())
          return { ok: false, error: deadlineFailure() };
        if (status >= 200 && status < 300)
          return { ok: true, data: xhr.response ?? xhr.responseText };
        failure = {
          kind:
            status === 404 || status === 410
              ? "not_found"
              : status === 429
                ? "rate_limited"
                : "unavailable",
          recoverable:
            status === 429 || status >= 500 || status === 0 || status === 408,
          status,
        };
        if (status === 429 || status >= 500) {
          const header = xhr.getResponseHeader?.("Retry-After")?.trim();
          const seconds =
            header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
          const retryAfter = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(header || "") - Date.now();
          if (Number.isFinite(retryAfter) && retryAfter >= 0) {
            retryWait = retryAfter;
            failure.retryAt = Date.now() + retryAfter;
            gate.defer(failure);
          }
        }
        ztoolkit.log(`[http] ${method} ${url} -> ${status}`);
      } catch (error) {
        // An XHR started before a longer subscriber joined still has its old
        // timeout. Continue under the extension without charging a network
        // retry/backoff for the earlier subscriber's exhausted wait budget.
        extendedTimeout =
          Date.now() >= transportDeadline &&
          deadline() > transportDeadline &&
          Date.now() < deadline();
        failure =
          Date.now() >= deadline()
            ? deadlineFailure()
            : { kind: "unavailable", recoverable: true };
        ztoolkit.log(`[http] ${method} ${url} failed`, error);
      } finally {
        gate.release();
      }
      if (extendedTimeout) {
        attempt--;
        continue;
      }
      if (!failure.recoverable || attempt >= maxRetries)
        return { ok: false, error: failure };
      // A long Retry-After is a recoverable answer, never a day-long UI promise
      // and never permission to retry earlier than the server allowed.
      if (Date.now() + retryWait >= deadline()) {
        return {
          ok: false,
          error: failure.retryAt ? failure : deadlineFailure(),
        };
      }
      await Zotero.Promise.delay(retryWait);
    }
  }

  getJSONResult<T = any>(url: string, options: RequestOptions = {}) {
    return this.requestResult<T>("GET", url, {
      ...options,
      responseType: "json",
    });
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

/** Contact email: Crossref polite pool and Unpaywall required parameter. */
export function politeEmail(): string {
  const email = (getPref("email") as string)?.trim();
  return email || "zotero-refs@mailinator.com";
}
