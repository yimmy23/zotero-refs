import { config } from "../../package.json";
import { clearTimeout, setTimeout } from "../utils/window";

/** A session choice, shared by reopened cards for the same paper and source. */
export interface TranslationEntry {
  text?: string;
  visible: boolean;
  pending?: Promise<string | undefined>;
}

interface Provider {
  api: object;
  translate: (...args: any[]) => unknown;
  legacy?: any;
  service: string;
  langfrom: string;
  langto: string;
  revision: number;
}
interface RecordState {
  key: string;
  source: string;
  provider: Provider;
  entry: TranslationEntry;
  touched: number;
  epoch: number;
  running?: Promise<void>;
}

const PREF_ROOT = "extensions.zotero.ZoteroPDFTranslate.";
const MAX_SOURCE = 40_000;
const MAX_RESULT = 80_000;
const MAX_ENTRIES = 96;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 4;
const CACHE_TTL = 60 * 60 * 1000;
const TIMEOUT = 30_000;
const entries = new Map<string, RecordState>();
let states = new WeakMap<TranslationEntry, RecordState>();
const running = new Set<RecordState>();
const cancellations = new Set<() => void>();
let epoch = 0;
let revision = 0;
let prefBranch: nsIPrefBranch | undefined;
let legacyTail: Promise<unknown> = Promise.resolve();
const CONFIG_PREFS = new Set([
  "translateSource",
  "sourceLanguage",
  "targetLanguage",
  "secretObj",
  "splitChar",
  "resultRegex",
  "stripEmptyLines",
  "attachPaperContext",
  "cnkiRegex",
  "cnkiSplitSecond",
  "cnkiUseSplit",
  "niutransApikey",
  "niutransEndpoint",
  "niutransDictNo",
  "niutransMemoryNo",
  "niutransUsername",
  "niutransPassword",
]);
const prefObserver = {
  observe(_subject: unknown, topic: string, name: string) {
    if (topic !== "nsPref:changed" || !name.startsWith(PREF_ROOT)) return;
    const key = name.slice(PREF_ROOT.length);
    // Runtime cnkiToken/haiciAppId refreshes and popup size writes happen while
    // translating. They are not configuration changes. Engine settings use
    // namespaces (chatGPT.model, deeplx.endpoint, etc.); top-level settings are
    // explicit. Never read or retain secret-bearing preference values.
    if (
      !CONFIG_PREFS.has(key) &&
      (!key.includes(".") || key.startsWith("renameServices."))
    )
      return;
    revision++;
    entries.clear();
  },
};

function observePrefs(): void {
  if (prefBranch) return;
  try {
    const branch = Zotero.Prefs.rootBranch;
    branch.addObserver(PREF_ROOT, prefObserver);
    prefBranch = branch;
  } catch {
    // Older/test environments can lack observers; core settings are also
    // compared explicitly on every lookup/request.
  }
}

function pref(name: string): string {
  try {
    const value = Zotero.Prefs.get(PREF_ROOT + name, true);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function provider(): Provider | undefined {
  observePrefs();
  try {
    const Z = Zotero as any;
    const api = Z.PDFTranslate?.api;
    const legacy = Z.ZoteroPDFTranslate;
    const translate = api?.translate;
    const common = {
      service: pref("translateSource"),
      langfrom: pref("sourceLanguage") || "en-US",
      langto: pref("targetLanguage") || Zotero.locale || "en-US",
      revision,
    };
    if (typeof translate === "function") return { api, translate, ...common };
    if (typeof legacy?.translate?.getTranslation === "function")
      return {
        api: legacy.translate,
        translate: legacy.translate.getTranslation,
        legacy,
        ...common,
      };
  } catch {
    // Disabled/unloaded providers may be dead wrappers. Never log provider
    // exceptions: their task objects can contain credentials or source text.
  }
  return undefined;
}

function sameProvider(a: Provider, b?: Provider): boolean {
  return !!(
    b &&
    a.api === b.api &&
    a.translate === b.translate &&
    a.legacy === b.legacy &&
    a.service === b.service &&
    a.langfrom === b.langfrom &&
    a.langto === b.langto &&
    a.revision === b.revision
  );
}

function usableText(raw: unknown, maximum: number): string | undefined {
  if (typeof raw !== "string" || raw.length > maximum) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(raw))
    return undefined;
  return raw.replace(/\r\n?/g, "\n").trim() || undefined;
}

function trimCache(): void {
  let bytes = 0;
  const now = Date.now();
  for (const [key, state] of entries) {
    if (now - state.touched >= CACHE_TTL && !state.entry.pending) {
      entries.delete(key);
      continue;
    }
    bytes +=
      2 * (key.length + state.source.length + (state.entry.text?.length || 0));
  }
  for (const [key, state] of entries) {
    if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    // Active requests are separately capped. Keep their entry reusable on hover.
    if (state.entry.pending || state.running) continue;
    entries.delete(key);
    bytes -=
      2 * (key.length + state.source.length + (state.entry.text?.length || 0));
  }
}

function touch(state: RecordState): void {
  state.touched = Date.now();
  if (entries.get(state.key) === state) {
    entries.delete(state.key);
    entries.set(state.key, state);
  }
}

/** Read-only discovery; does not invoke a provider or start a translation. */
export function translationAvailable(): boolean {
  return !!provider();
}

/** Opening a card alone never translates. Source text stays exact in the key. */
export function openTranslation(
  source: string,
  scope: string,
): TranslationEntry | undefined {
  const selected = provider();
  const text = usableText(source, MAX_SOURCE);
  if (!selected || !text || !scope || scope.length > 4096) return undefined;
  trimCache();
  const key = JSON.stringify([scope, text]);
  const previous = entries.get(key);
  if (previous && sameProvider(previous.provider, selected)) {
    touch(previous);
    return previous.entry;
  }
  const entry: TranslationEntry = { visible: false };
  const state: RecordState = {
    key,
    source: text,
    provider: selected,
    entry,
    epoch,
    touched: Date.now(),
  };
  states.set(entry, state);
  entries.set(key, state);
  trimCache();
  return entry;
}

function current(state: RecordState): boolean {
  return state.epoch === epoch && sameProvider(state.provider, provider());
}

async function invoke(state: RecordState): Promise<string | undefined> {
  const selected = state.provider;
  try {
    if (!current(state)) return undefined;
    if (!selected.legacy) {
      // Installed Translate for Zotero 2.4.7 custom API. Explicit language and
      // caller settings avoid selected-item inference and all item-field writes.
      const task = await selected.translate.call(selected.api, state.source, {
        pluginID: config.addonID,
        service: selected.service || undefined,
        langfrom: selected.langfrom,
        langto: selected.langto,
      });
      if (typeof task === "string") return usableText(task, MAX_RESULT);
      if (!task || typeof task !== "object" || !("status" in task))
        return undefined;
      if (task.status !== "success" || !("result" in task)) return undefined;
      return usableText(task.result, MAX_RESULT);
    }
    const legacy = selected.legacy;
    const previousSource = legacy._sourceText;
    const previousResult = legacy._translatedText;
    legacy._sourceText = state.source;
    legacy._translatedText = "";
    try {
      const ok = await selected.translate.call(selected.api);
      // If the legacy plugin's own UI changed its input, this result belongs to
      // that task. Never restore our snapshot over the user's newer input.
      if (!ok || legacy._sourceText !== state.source) return undefined;
      return usableText(legacy._translatedText, MAX_RESULT);
    } finally {
      if (legacy._sourceText === state.source) {
        legacy._sourceText = previousSource;
        legacy._translatedText = previousResult;
      }
    }
  } catch {
    return undefined;
  }
}

/** Explicit user action only. Pending/completed work survives card destruction. */
export function requestTranslation(
  entry: TranslationEntry,
): Promise<string | undefined> {
  const state = states.get(entry);
  if (!state || !current(state)) return Promise.resolve(undefined);
  entry.visible = true;
  touch(state);
  if (entry.text) return Promise.resolve(entry.text);
  if (entry.pending) return entry.pending;
  // A timed-out provider cannot be cancelled by its public API. Keep physical
  // requests capped until they settle instead of launching unlimited retries.
  if (state.running || running.size >= MAX_PENDING)
    return Promise.resolve(undefined);
  let resolve!: (text: string | undefined) => void;
  const pending = new Promise<string | undefined>((done) => {
    resolve = done;
  });
  entry.pending = pending;
  let settled = false;
  let startTimer: number | undefined;
  const finish = (text?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cancellations.delete(cancel);
    if (entry.pending === pending) delete entry.pending;
    resolve(text);
    trimCache();
  };
  const cancel = () => {
    clearTimeout(startTimer);
    finish();
  };
  cancellations.add(cancel);
  running.add(state);
  // The timeout includes queued legacy work. UI state is set synchronously;
  // provider preparation starts on the next event-loop task so it can paint.
  const timer = setTimeout(() => finish(), TIMEOUT);
  startTimer = setTimeout(() => {
    startTimer = undefined;
    const run = async () => {
      if (!current(state) || settled) return;
      const text = await invoke(state);
      if (text && current(state)) {
        entry.text = text;
        touch(state);
      }
      finish(current(state) ? text : undefined);
    };
    const job = state.provider.legacy ? legacyTail.then(run) : run();
    if (state.provider.legacy) legacyTail = job.catch(() => {});
    state.running = job.finally(() => {
      running.delete(state);
      delete state.running;
      finish();
      trimCache();
    });
  }, 0);
  return pending;
}

/** Shutdown/hot reload only, not card close: release retained source/results. */
export function clearPopupTranslations(): void {
  epoch++;
  entries.clear();
  states = new WeakMap();
  for (const cancel of [...cancellations]) cancel();
  // Keep uncancellable legacy work serialized until the provider actually
  // settles. Old completions cannot populate the new session's cache.
  for (const state of running) if (!state.running) running.delete(state);
  try {
    prefBranch?.removeObserver(PREF_ROOT, prefObserver);
  } catch {
    /* shutdown */
  }
  prefBranch = undefined;
}
