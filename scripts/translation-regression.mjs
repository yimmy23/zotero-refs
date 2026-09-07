import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/core/popupTranslation.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "test-timers",
      setup(build) {
        build.onResolve({ filter: /utils\/window$/ }, () => ({
          path: "timers",
          namespace: "test",
        }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents:
            "export const setTimeout = (fn,ms) => globalThis.timerFixture.set(fn,ms); export const clearTimeout = id => globalThis.timerFixture.clear(id);",
        }));
      },
    },
  ],
});
const {
  openTranslation,
  requestTranslation,
  translationAvailable,
  clearPopupTranslations,
} = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const ticks = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let timers = new Map();
let sequence = 0;
globalThis.timerFixture = {
  set(fn, ms) {
    const id = ++sequence;
    timers.set(id, { fn, ms });
    return id;
  },
  clear(id) {
    timers.delete(id);
  },
};
const advance = async (ms) => {
  for (const [id, timer] of [...timers])
    if (timer.ms <= ms && timers.delete(id)) timer.fn();
  await ticks();
};
let prefs;
let observers;
const root = "extensions.zotero.ZoteroPDFTranslate.";
function fixture(translate) {
  clearPopupTranslations();
  timers.clear();
  prefs = new Map([
    [root + "translateSource", "engine-a"],
    [root + "sourceLanguage", "en-US"],
    [root + "targetLanguage", "zh-CN"],
  ]);
  observers = new Set();
  globalThis.Zotero = {
    locale: "fr-FR",
    Prefs: {
      get: (key) => prefs.get(key),
      rootBranch: {
        addObserver(prefix, observer) {
          assert.equal(prefix, root);
          observers.add(observer);
        },
        removeObserver(prefix, observer) {
          assert.equal(prefix, root);
          observers.delete(observer);
        },
      },
    },
    ...(translate ? { PDFTranslate: { api: { translate } } } : {}),
  };
}

// Modern custom tasks are the installed plugin's real API contract. These tests
// exercise the shared service, not a second implementation of its cache logic.
test("open is opt-in; explicit API settings and cached session choice survive reopen", async () => {
  let calls = 0,
    received;
  fixture(async (source, options) => {
    calls++;
    received = [source, options];
    return { status: "success", result: "背景：译文。" };
  });
  assert.equal(translationAvailable(), true);
  const entry = openTranslation("Background: Source.", "paper-a:abstract");
  assert.equal(entry.visible, false);
  assert.equal(calls, 0);
  const pending = requestTranslation(entry);
  assert.equal(entry.visible, true);
  assert.equal(entry.pending, pending);
  assert.equal(
    calls,
    0,
    "provider preparation yields so the busy state can paint",
  );
  await advance(0);
  assert.equal(await pending, "背景：译文。");
  assert.equal(received[0], "Background: Source.");
  assert.match(received[1].pluginID, /refs/);
  assert.deepEqual(
    { ...received[1], pluginID: undefined },
    {
      pluginID: undefined,
      service: "engine-a",
      langfrom: "en-US",
      langto: "zh-CN",
    },
  );
  assert.equal("itemID" in received[1], false);
  const reopened = openTranslation("Background: Source.", "paper-a:abstract");
  assert.equal(reopened, entry);
  assert.equal(reopened.visible, true);
  assert.equal(reopened.text, "背景：译文。");
  await requestTranslation(reopened);
  assert.equal(calls, 1);
  reopened.visible = false;
  assert.equal(
    openTranslation("Background: Source.", "paper-a:abstract").visible,
    false,
  );
});

test("multiple cards attach one pending task and retain its late result after close", async () => {
  const wait = deferred();
  let calls = 0;
  fixture(() => {
    calls++;
    return wait.promise;
  });
  const entry = openTranslation("Long abstract", "paper-a:abstract");
  const pending = requestTranslation(entry);
  const reopened = openTranslation("Long abstract", "paper-a:abstract");
  assert.equal(reopened, entry);
  assert.equal(requestTranslation(reopened), pending);
  await advance(0);
  assert.equal(calls, 1);
  wait.resolve({ status: "success", result: "长摘要" });
  assert.equal(await pending, "长摘要");
  assert.equal(
    openTranslation("Long abstract", "paper-a:abstract").text,
    "长摘要",
  );
});

test("paper scope, full source, language, provider function and engine changes invalidate choices", async () => {
  const translate = async () => ({ status: "success", result: "译文" });
  fixture(translate);
  const first = openTranslation("Full source: A", "paper-a:abstract");
  let pending = requestTranslation(first);
  await advance(0);
  await pending;
  assert.notEqual(openTranslation("Full source: B", "paper-a:abstract"), first);
  assert.equal(
    openTranslation("Full source: A", "paper-b:abstract").visible,
    false,
  );
  prefs.set(root + "targetLanguage", "de-DE");
  const german = openTranslation("Full source: A", "paper-a:abstract");
  assert.notEqual(german, first);
  assert.equal(german.visible, false);
  assert.equal(
    await requestTranslation(first),
    undefined,
    "stale provider entries cannot request",
  );
  prefs.set(root + "translateSource", "engine-b");
  const engineB = openTranslation("Full source: A", "paper-a:abstract");
  assert.notEqual(engineB, german);
  globalThis.Zotero.PDFTranslate.api.translate = async () => "replacement";
  assert.notEqual(
    openTranslation("Full source: A", "paper-a:abstract"),
    engineB,
  );
});

test("any provider configuration change clears retained choices without reading its secrets", async () => {
  fixture(async () => ({ status: "success", result: "译文" }));
  const first = openTranslation("Source", "paper-a:abstract");
  const pending = requestTranslation(first);
  await advance(0);
  await pending;
  const get = globalThis.Zotero.Prefs.get;
  globalThis.Zotero.Prefs.get = (key) => {
    assert.ok(!/secret|password|prompt/i.test(key));
    return get(key);
  };
  for (const observer of observers)
    observer.observe(null, "nsPref:changed", root + "chatGPT.model");
  const changed = openTranslation("Source", "paper-a:abstract");
  assert.notEqual(changed, first);
  assert.equal(changed.visible, false);
});

test("provider token refresh and presentation preferences do not invalidate a running translation", async () => {
  const wait = deferred();
  fixture(() => wait.promise);
  const entry = openTranslation("Source", "paper:a");
  const pending = requestTranslation(entry);
  await advance(0);
  for (const key of [
    "cnkiToken",
    "haiciAppId",
    "popupWidth",
    "popupHeight",
    "fontSize",
    "renameServices.customgpt1",
  ])
    for (const observer of observers)
      observer.observe(null, "nsPref:changed", root + key);
  wait.resolve({ status: "success", result: "译文" });
  assert.equal(await pending, "译文");
  assert.equal(openTranslation("Source", "paper:a"), entry);
});

test("a provider switch during a request discards its stale completion", async () => {
  const wait = deferred();
  fixture(() => wait.promise);
  const entry = openTranslation("Source", "paper:a");
  const pending = requestTranslation(entry);
  await advance(0);
  prefs.set(root + "translateSource", "engine-b");
  wait.resolve({ status: "success", result: "old provider result" });
  assert.equal(await pending, undefined);
  assert.equal(entry.text, undefined);
  assert.equal(openTranslation("Source", "paper:a").visible, false);
});

test("shutdown before scheduled provider preparation cancels all work", async () => {
  let calls = 0;
  fixture(async () => {
    calls++;
    return "translated";
  });
  const pending = requestTranslation(openTranslation("Source", "paper:a"));
  clearPopupTranslations();
  assert.equal(await pending, undefined);
  await advance(0);
  assert.equal(calls, 0);
  assert.equal(timers.size, 0);
});

test("provider errors and invalid outputs clear pending and remain retryable", async () => {
  const results = [
    new Error("secret-bearing exception"),
    { status: "fail", result: "provider diagnostic" },
    { status: "success", result: 12 },
    { result: "missing status" },
    { status: "success", result: "\0invalid" },
    { status: "success", result: "ok" },
  ];
  fixture(async () => {
    const result = results.shift();
    if (result instanceof Error) throw result;
    return result;
  });
  const entry = openTranslation("Source", "paper-a:abstract");
  for (let i = 0; i < 5; i++) {
    const pending = requestTranslation(entry);
    await advance(0);
    assert.equal(await pending, undefined);
    assert.equal(entry.pending, undefined);
    assert.equal(entry.text, undefined);
  }
  const retry = requestTranslation(entry);
  await advance(0);
  assert.equal(await retry, "ok");
});

test("timed-out tasks release UI busy state and never create duplicate physical requests", async () => {
  const wait = deferred();
  let calls = 0;
  fixture(() => {
    calls++;
    return wait.promise;
  });
  const entry = openTranslation("Source", "paper-a:abstract");
  const pending = requestTranslation(entry);
  await advance(0);
  await advance(30_000);
  assert.equal(await pending, undefined);
  assert.equal(entry.pending, undefined);
  assert.equal(await requestTranslation(entry), undefined);
  assert.equal(calls, 1);
  wait.resolve({ status: "success", result: "Late result" });
  await ticks();
  assert.equal(
    openTranslation("Source", "paper-a:abstract").text,
    "Late result",
  );
  assert.equal(await requestTranslation(entry), "Late result");
});

test("physical concurrency stays bounded when uncancellable providers time out", async () => {
  const waits = Array.from({ length: 4 }, deferred);
  let calls = 0;
  fixture(() => waits[calls++].promise);
  const pending = [];
  for (let i = 0; i < 4; i++)
    pending.push(
      requestTranslation(openTranslation("Source " + i, "paper:" + i)),
    );
  await advance(0);
  const fifth = openTranslation("Source fifth", "paper:5");
  assert.equal(await requestTranslation(fifth), undefined);
  await advance(30_000);
  assert.deepEqual(await Promise.all(pending), [
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  assert.equal(await requestTranslation(fifth), undefined);
  assert.equal(calls, 4);
  waits.forEach((wait) => wait.resolve({ status: "fail", result: "" }));
  await ticks();
});

test("legacy requests serialize global input and restore provider state", async () => {
  fixture();
  const waitA = deferred(),
    waitB = deferred();
  const observed = [];
  const legacy = {
    _sourceText: "user source",
    _translatedText: "user result",
    translate: {
      async getTranslation() {
        const input = legacy._sourceText;
        observed.push(input);
        await (input === "Source A" ? waitA.promise : waitB.promise);
        assert.equal(
          legacy._sourceText,
          input,
          "another Refs task cannot replace legacy input",
        );
        legacy._translatedText = input + " translated";
        return true;
      },
    },
  };
  globalThis.Zotero.ZoteroPDFTranslate = legacy;
  const a = requestTranslation(openTranslation("Source A", "paper:a"));
  const b = requestTranslation(openTranslation("Source B", "paper:b"));
  await advance(0);
  assert.deepEqual(observed, ["Source A"]);
  waitA.resolve();
  assert.equal(await a, "Source A translated");
  await ticks();
  assert.deepEqual(observed, ["Source A", "Source B"]);
  waitB.resolve();
  assert.equal(await b, "Source B translated");
  await ticks();
  assert.equal(legacy._sourceText, "user source");
  assert.equal(legacy._translatedText, "user result");
});

test("legacy UI input changes discard cross-paper results without clobbering user input", async () => {
  fixture();
  const wait = deferred();
  const legacy = {
    _sourceText: "user",
    _translatedText: "old",
    translate: {
      async getTranslation() {
        await wait.promise;
        return true;
      },
    },
  };
  globalThis.Zotero.ZoteroPDFTranslate = legacy;
  const entry = openTranslation("Source A", "paper:a");
  const pending = requestTranslation(entry);
  await advance(0);
  legacy._sourceText = "new user selection";
  legacy._translatedText = "new user result";
  wait.resolve();
  assert.equal(await pending, undefined);
  assert.equal(legacy._sourceText, "new user selection");
  assert.equal(legacy._translatedText, "new user result");
});

test("legacy timeout holds its lock until completion and skips expired queued work", async () => {
  fixture();
  const wait = deferred();
  let calls = 0;
  const legacy = {
    _sourceText: "user",
    _translatedText: "old",
    translate: {
      async getTranslation() {
        calls++;
        await wait.promise;
        legacy._translatedText = "translated";
        return true;
      },
    },
  };
  globalThis.Zotero.ZoteroPDFTranslate = legacy;
  const a = requestTranslation(openTranslation("Source A", "paper:a"));
  const b = requestTranslation(openTranslation("Source B", "paper:b"));
  await advance(0);
  await advance(30_000);
  assert.equal(await a, undefined);
  assert.equal(await b, undefined);
  assert.equal(calls, 1);
  wait.resolve();
  await ticks();
  assert.equal(calls, 1);
  assert.equal(legacy._sourceText, "user");
});

test("cache has entry, byte and TTL limits, and shutdown invalidates outstanding work", async () => {
  fixture(async () => ({ status: "success", result: "译文" }));
  const first = openTranslation("Source", "paper:first");
  for (let i = 0; i < 100; i++) openTranslation("Source", "paper:" + i);
  assert.notEqual(
    openTranslation("Source", "paper:first"),
    first,
    "oldest entries are evicted",
  );
  const large = openTranslation("x".repeat(40_000), "large:first");
  for (let i = 0; i < 30; i++)
    openTranslation("x".repeat(40_000), "large:" + i);
  assert.notEqual(
    openTranslation("x".repeat(40_000), "large:first"),
    large,
    "byte cap applies before count cap",
  );
  const aged = openTranslation("Aged", "paper:aged");
  const now = Date.now;
  Date.now = () => now() + 60 * 60 * 1000 + 1;
  try {
    assert.notEqual(openTranslation("Aged", "paper:aged"), aged);
  } finally {
    Date.now = now;
  }
  const wait = deferred();
  globalThis.Zotero.PDFTranslate.api.translate = () => wait.promise;
  const old = openTranslation("Pending", "paper:pending");
  const pending = requestTranslation(old);
  await advance(0);
  clearPopupTranslations();
  assert.equal(await pending, undefined);
  assert.equal(observers.size, 0);
  wait.resolve({ status: "success", result: "must not reappear" });
  await ticks();
  assert.equal(old.text, undefined);
  assert.equal(openTranslation("Pending", "paper:pending").visible, false);
});

test("unavailable providers and invalid sources never trigger translation", () => {
  fixture();
  assert.equal(translationAvailable(), false);
  assert.equal(openTranslation("Source", "paper:a"), undefined);
  globalThis.Zotero.PDFTranslate = { api: { translate: async () => "ok" } };
  for (const text of ["", " ", "x".repeat(40_001), "bad\0source"])
    assert.equal(openTranslation(text, "paper:a"), undefined);
  clearPopupTranslations();
});
