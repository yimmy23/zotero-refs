import assert from "node:assert/strict";
import console from "node:console";
import path from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout, setImmediate } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// Bundle the real registry, providers and HTTP scheduler. Only transport and
// Zotero preferences/localization are synthetic; no profile or network is used.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tests = [];
const test = (name, run) => tests.push([name, run]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ok = (response) => ({ status: 200, response });
const failure = (status, retryAfter) => ({
  status,
  response: null,
  getResponseHeader: () => retryAfter,
});
const host = {
  getField: (key) =>
    ({ title: "Synthetic host article", DOI: "10.5555/host" })[key] || "",
};
const paper = (id) => ({
  citedPaper: { paperId: `paper-${id}`, title: `Paper ${id}`, authors: [] },
});

async function fixture(transport, globals = {}) {
  const compiled = await build({
    stdin: {
      contents:
        'export { http } from "./src/core/http"; export * from "./src/sources/index"; export { getWorkFull, getWorksBatch } from "./src/sources/openalex";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
    plugins: [
      {
        name: "network-fixture-locale",
        setup(bundler) {
          bundler.onResolve({ filter: /utils\/locale$/ }, () => ({
            path: "locale",
            namespace: "fixture",
          }));
          bundler.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const getString=(key)=>key;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const calls = [];
  const waits = [];
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    console,
    Components: { utils: { isDeadWrapper: () => false } },
    Zotero: {
      getMainWindow: () => ({ closed: false, setTimeout, clearTimeout }),
      Prefs: { get: () => undefined },
      Promise: {
        delay: async (ms) => {
          waits.push(ms);
        },
      },
      HTTP: {
        request: async (method, url, options) => {
          const request = { method, url: new URL(url), options };
          calls.push(request);
          return transport(request, calls.length);
        },
      },
    },
    addon: { data: {} },
    ztoolkit: { log: () => {} },
    ...globals,
  });
  vm.runInContext(
    `(function () {\n${compiled.outputFiles[0].text}\n})();`,
    context,
  );
  return { ...context.module.exports, calls, waits, context };
}

test("HTTP timers work without bare timer globals in the plugin sandbox", async () => {
  const f = await fixture(() => ok({ value: 1 }));
  assert.equal(vm.runInContext("typeof setTimeout", f.context), "undefined");
  assert.equal(vm.runInContext("typeof clearTimeout", f.context), "undefined");
  assert.equal(
    (await f.http.getJSONResult("https://example.test/timerless")).data.value,
    1,
  );
});

test("References refresh crosses registry/provider/cache and retains in-flight deduplication", async () => {
  let generation = 1;
  let unblock;
  let hold = false;
  const f = await fixture(async () => {
    if (hold)
      await new Promise((resolve) => {
        unblock = resolve;
      });
    return ok({
      message: {
        reference: [
          { DOI: "10.5555/ref", "article-title": `Generation ${generation}` },
        ],
      },
    });
  });
  assert.equal(
    (await f.getReferencesByAPI(host)).refs[0].title,
    "Generation 1",
  );
  generation = 2;
  assert.equal(
    (await f.getReferencesByAPI(host)).refs[0].title,
    "Generation 1",
  );
  assert.equal(f.calls.length, 1);
  hold = true;
  const first = f.getReferencesByAPI(host, undefined, {
    cachePolicy: "refresh",
  });
  const second = f.getReferencesByAPI(host, undefined, {
    cachePolicy: "refresh",
  });
  await flush();
  assert.equal(f.calls.length, 2, "Both refresh consumers share one transport");
  unblock();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.refs[0].title, "Generation 2");
    assert.equal(result.status, "ok");
  }
  assert.equal(
    (await f.getReferencesByAPI(host)).refs[0].title,
    "Generation 2",
  );
  assert.equal(f.calls.length, 2);
});

test("Related failure retry reaches recovered providers and explicit refresh replaces cached lists", async () => {
  let generation = 0;
  const f = await fixture(({ url }) => {
    if (!generation) return failure(503);
    if (url.hostname.includes("semanticscholar"))
      return ok({
        recommendedPapers: [
          {
            paperId: "s2-related",
            title: `S2 generation ${generation}`,
            authors: [],
          },
        ],
      });
    if (url.pathname.includes("/works/"))
      return ok({
        id: "https://openalex.org/W1",
        related_works: ["https://openalex.org/W2"],
      });
    return ok({
      results: [
        {
          id: "https://openalex.org/W2",
          title: `OA generation ${generation}`,
          authorships: [],
        },
      ],
    });
  });
  const failed = await f.getRelatedByAPI({ DOI: "10.5555/host" });
  assert.ok(failed.sources.every((source) => source.status === "unavailable"));
  assert.equal(f.calls.length, 6);
  generation = 1;
  const recovered = await f.getRelatedByAPI({ DOI: "10.5555/host" });
  assert.ok(recovered.sources.every((source) => source.status === "ready"));
  assert.equal(recovered.items.length, 2);
  assert.equal(
    f.calls.length,
    9,
    "Transient failures must not suppress a retry",
  );
  generation = 2;
  const refreshed = await f.getRelatedByAPI(
    { DOI: "10.5555/host" },
    40,
    undefined,
    () => true,
    { cachePolicy: "refresh" },
  );
  assert.ok(
    refreshed.items.every((item) => item.ref.title.endsWith("generation 2")),
  );
  assert.equal(f.calls.length, 12);
});

test("Graph work lookup and batch hydration accept refresh policy", async () => {
  let generation = 1;
  const f = await fixture(({ url }) =>
    url.pathname === "/works"
      ? ok({
          results: [
            { id: "https://openalex.org/W2", title: `Batch ${generation}` },
          ],
        })
      : ok({ id: "https://openalex.org/W1", title: `Origin ${generation}` }),
  );
  await f.getWorkFull({ openAlex: "W1" });
  await f.getWorksBatch(["W2"], false, { lean: true });
  generation = 2;
  assert.equal(
    (await f.getWorkFull({ openAlex: "W1" }, { cachePolicy: "refresh" })).ref
      .title,
    "Origin 2",
  );
  assert.equal(
    (
      await f.getWorksBatch(["W2"], false, {
        lean: true,
        cachePolicy: "refresh",
      })
    ).get("W2").ref.title,
    "Batch 2",
  );
  assert.equal(f.calls.length, 4);
});

test("no-store bypasses reads/writes while refresh replaces an existing cache entry", async () => {
  let generation = 1;
  const f = await fixture(() => ok({ generation }));
  const url = "https://example.test/work";
  assert.equal((await f.http.getJSON(url)).generation, 1);
  generation = 2;
  assert.equal(
    (await f.http.getJSON(url, { cachePolicy: "no-store" })).generation,
    2,
  );
  assert.equal((await f.http.getJSON(url)).generation, 1);
  assert.equal(
    (await f.http.getJSON(url, { cachePolicy: "refresh" })).generation,
    2,
  );
  assert.equal((await f.http.getJSON(url)).generation, 2);
  assert.equal(f.calls.length, 3);
});

test("Only not-found failures receive negative caching, and refresh can bypass them", async () => {
  let status = 404;
  const f = await fixture(() =>
    status === 200 ? ok({ recovered: true }) : failure(status),
  );
  const url = "https://example.test/work";
  assert.equal(await f.http.getJSON(url), null);
  assert.equal(await f.http.getJSON(url), null);
  assert.equal(f.calls.length, 1);
  status = 200;
  assert.equal(
    (await f.http.getJSON(url, { cachePolicy: "refresh" })).recovered,
    true,
  );
  status = 503;
  assert.equal(
    await f.http.getJSON("https://example.test/transient", { retries: 0 }),
    null,
  );
  status = 200;
  assert.equal(
    (await f.http.getJSON("https://example.test/transient")).recovered,
    true,
  );
});

test("Long numeric and date Retry-After return promptly without early retries, including refresh", async () => {
  for (const header of [
    "86400",
    new Date(Date.now() + 86400000).toUTCString(),
  ]) {
    const before = Date.now();
    const f = await fixture(() => failure(429, header));
    const result = await f.http.getJSONResult("https://example.test/limited", {
      totalTimeout: 100,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, "rate_limited");
    assert.equal(result.error.recoverable, true);
    assert.ok(result.error.retryAt >= before + 86399000);
    assert.deepEqual(
      f.waits,
      [],
      "Do not sleep until a server deadline outside this interaction",
    );
    assert.equal(f.calls.length, 1);
    const retried = await f.http.getJSONResult("https://example.test/other", {
      cachePolicy: "refresh",
      totalTimeout: 100,
    });
    assert.equal(retried.error.kind, "rate_limited");
    assert.equal(
      f.calls.length,
      1,
      "Refresh must respect the provider cooldown",
    );
  }
});

test("Retry-After within budget is honored and retry transport gets only remaining time", async () => {
  let now = 10000;
  const waits = [];
  const f = await fixture(
    (_request, count) =>
      count === 1 ? failure(503, "2") : ok({ recovered: true }),
    {
      Date: class extends Date {
        static now() {
          return now;
        }
      },
    },
  );
  // Advance only the mocked sleep; assertions inspect real transport options.
  f.context.Zotero.Promise.delay = async (ms) => {
    waits.push(ms);
    now += ms;
  };
  assert.equal(
    (
      await f.http.getJSONResult("https://example.test/work", {
        totalTimeout: 5000,
        timeout: 15000,
      })
    ).data.recovered,
    true,
  );
  assert.deepEqual(waits, [2000]);
  assert.equal(f.calls[0].options.timeout, 5000);
  assert.equal(f.calls[1].options.timeout, 3000);
});

test("Queue expiration settles and removes abandoned work without consuming host capacity", async () => {
  const releases = [];
  const f = await fixture(
    () => new Promise((resolve) => releases.push(() => resolve(ok({})))),
  );
  const active = [1, 2, 3].map((id) =>
    f.http.getJSON(`https://api.crossref.org/active-${id}`),
  );
  await flush();
  assert.equal(f.calls.length, 3);
  const expired = await f.http.getJSONResult(
    "https://api.crossref.org/expired",
    { totalTimeout: 20 },
  );
  assert.equal(expired.error.kind, "deadline");
  assert.equal(f.calls.length, 3);
  const next = f.http.getJSON("https://api.crossref.org/newest");
  releases.shift()();
  await flush();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.at(-1).url.pathname, "/newest");
  for (const release of releases.splice(0)) release();
  await Promise.all([...active, next]);
});

test("The initiating caller's total deadline also bounds a stalled transport", async () => {
  let release;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        release = () => resolve(ok({ late: true }));
      }),
  );
  const result = await f.http.getJSONResult("https://example.test/stalled", {
    totalTimeout: 20,
  });
  assert.equal(result.error.kind, "deadline");
  assert.ok(f.calls[0].options.timeout <= 20);
  release();
  await flush();
  const retry = f.http.getJSONResult("https://example.test/stalled", {
    totalTimeout: 100,
  });
  await flush();
  assert.equal(
    f.calls.length,
    2,
    "A late response must not populate the success cache",
  );
  release();
  assert.equal((await retry).ok, true);
});

test("A short-deadline shared consumer settles without cancelling another consumer", async () => {
  let release;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        release = () => resolve(ok({ value: 1 }));
      }),
  );
  const owner = f.http.getJSON("https://example.test/shared");
  await flush();
  const short = await f.http.getJSONResult("https://example.test/shared", {
    totalTimeout: 20,
  });
  assert.equal(short.error.kind, "deadline");
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await owner).value, 1);
  assert.equal((await f.http.getJSON("https://example.test/shared")).value, 1);
});

test("A short owner cannot expire a longer follower sharing the same transport", async () => {
  let release;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        release = () => resolve(ok({ value: 1 }));
      }),
  );
  const owner = f.http.getJSONResult("https://example.test/shared", {
    totalTimeout: 20,
  });
  const follower = f.http.getJSONResult("https://example.test/shared", {
    totalTimeout: 200,
  });
  assert.equal((await owner).error.kind, "deadline");
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await follower).data.value, 1);
  assert.equal((await f.http.getJSON("https://example.test/shared")).value, 1);
  assert.equal(f.calls.length, 1);
});

test("A late follower can continue after an active XHR exhausts the old owner's budget", async () => {
  const f = await fixture(({ options }, call) => {
    if (call > 1) return ok({ recovered: true });
    // Emulate Zotero honoring the timeout fixed when this XHR was started.
    return new Promise((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("transport timeout")),
        options.timeout + 1,
      ),
    );
  });
  const owner = f.http.getJSONResult("https://example.test/late-follower", {
    totalTimeout: 20,
    retries: 0,
  });
  await flush();
  assert.ok(f.calls[0].options.timeout <= 20);
  const follower = f.http.getJSONResult("https://example.test/late-follower", {
    totalTimeout: 200,
    retries: 0,
  });
  assert.equal((await owner).error.kind, "deadline");
  assert.equal((await follower).data.recovered, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.waits,
    [],
    "The old consumer budget is not a server retry/backoff",
  );
});

test("A queued shared request retains its longer subscriber after the owner expires", async () => {
  const releases = [];
  const f = await fixture(
    () =>
      new Promise((resolve) => releases.push(() => resolve(ok({ value: 1 })))),
  );
  const active = [1, 2, 3].map((id) =>
    f.http.getJSON(`https://api.crossref.org/active-${id}`),
  );
  await flush();
  const owner = f.http.getJSONResult("https://api.crossref.org/shared-queued", {
    totalTimeout: 20,
  });
  const follower = f.http.getJSONResult(
    "https://api.crossref.org/shared-queued",
    { totalTimeout: 200 },
  );
  assert.equal((await owner).error.kind, "deadline");
  assert.equal(f.calls.length, 3);
  releases.shift()();
  await flush();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.at(-1).url.pathname, "/shared-queued");
  for (const release of releases.splice(0)) release();
  assert.equal((await follower).data.value, 1);
  await Promise.all(active);
});

test("Expired callers retain active transport slots until the transports settle", async () => {
  const releases = [];
  const f = await fixture(
    () => new Promise((resolve) => releases.push(() => resolve(ok({})))),
  );
  const expired = await Promise.all(
    [1, 2, 3].map((id) =>
      f.http.getJSONResult(`https://api.crossref.org/stalled-${id}`, {
        totalTimeout: 20,
      }),
    ),
  );
  assert.ok(expired.every((result) => result.error.kind === "deadline"));
  const next = await f.http.getJSONResult("https://api.crossref.org/fourth", {
    totalTimeout: 20,
  });
  assert.equal(next.error.kind, "deadline");
  assert.equal(f.calls.length, 3);
  for (const release of releases.splice(0)) release();
  await flush();
});

test("S2 later-page failures preserve refs, cursor and error across the real registry", async () => {
  let recovered = false;
  const f = await fixture(({ url }) => {
    if (!url.hostname.includes("semanticscholar")) return failure(404);
    const offset = Number(url.searchParams.get("offset"));
    if (!offset) return ok({ data: [paper(1)], next: 1000 });
    return recovered ? ok({ data: [paper(2)] }) : failure(503);
  });
  const partial = await f.getReferencesByAPI(host);
  assert.equal(partial.status, "partial");
  assert.equal(partial.source, "semanticscholar");
  assert.equal(partial.refs.length, 1);
  assert.equal(partial.nextOffset, 1000);
  assert.equal(partial.error.kind, "unavailable");
  assert.ok(
    f.calls.some((call) => call.url.hostname.includes("openalex")),
    "A partial S2 response must still allow a complete fallback",
  );
  recovered = true;
  const completed = await f.getReferencesByAPI(host);
  assert.equal(completed.status, "ok");
  assert.equal(completed.refs.length, 2);
  assert.equal(completed.nextOffset, undefined);
});

test("S2 malformed, non-progressing and capped pages remain explicitly partial", async () => {
  const variants = [
    () => ({ data: {} }),
    () => ({ data: [], next: 2000 }),
    () => ({ data: [paper(1)], next: 2000 }),
    () => ({ data: [paper(2)], next: 1000 }),
    () => ({ data: [{ citedPaper: { paperId: "bad", authors: {} } }] }),
  ];
  for (const nextPage of variants) {
    const f = await fixture(({ url }) =>
      ok(
        Number(url.searchParams.get("offset")) === 0
          ? { data: [paper(1)], next: 1000 }
          : nextPage(),
      ),
    );
    const result = await f.sources.semanticscholar.getReferencesResult({
      s2: "origin",
    });
    assert.equal(result.status, "partial");
    assert.ok(result.items.length >= 1);
    assert.equal(result.nextOffset, 1000);
    assert.equal(result.error.recoverable, true);
  }
  const f = await fixture(({ url }) => {
    const offset = Number(url.searchParams.get("offset"));
    return ok({ data: [paper(offset)], next: offset + 1000 });
  });
  const capped = await f.sources.semanticscholar.getReferencesResult({
    s2: "origin",
  });
  assert.equal(capped.status, "partial");
  assert.equal(capped.items.length, 20);
  assert.equal(capped.nextOffset, 20000);
  assert.equal(f.calls.length, 20);
});

test("S2 completion and genuine empty pages are distinct from unavailability", async () => {
  const empty = await fixture(() => ok({ data: [] }));
  assert.equal(
    (await empty.sources.semanticscholar.getReferencesResult({ s2: "origin" }))
      .status,
    "empty",
  );
  const unavailable = await fixture(() => failure(429, "86400"));
  const result = await unavailable.sources.semanticscholar.getReferencesResult({
    s2: "origin",
  });
  assert.equal(result.status, "rate_limited");
  assert.equal(result.items.length, 0);
  assert.equal(result.nextOffset, 0);
  assert.ok(result.error.retryAt > Date.now());
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`, error);
  }
}
console.log(
  `${tests.length - failed}/${tests.length} network regressions passed`,
);
process.exitCode = failed ? 1 : 0;
