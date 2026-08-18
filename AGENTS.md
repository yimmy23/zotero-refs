# AGENTS.md — working on zotero-refs with an AI agent

Contract for any change: `npm run build` must pass (esbuild + `tsc --noEmit`), the plugin must load in a **Zotero 7–10** main window (tested on 9.0.6 and 10.0; Zotero 10 keeps the Firefox 140 base and only removed singular-selection APIs / `Zotero.CookieSandbox` / `fulltextWord`, none of which we use) without a single uncaught exception, and the four item-pane sections (References / Cited By / Related / Citation Graph) must render for a normal journal article. Never test against the user's real Zotero profile — always the isolated dev profile (below).

## Build & dev loop

```bash
npm run build     # production xpi -> .scaffold/build/refs.xpi (also runs tsc)
npm start         # dev build + hot reload in an ISOLATED Zotero profile
```

`.env` (copy from `.env.example`) points at the Zotero binary and pins profile/data dirs under `.scaffold/`; the kill command is scoped to the dev profile path so a running production Zotero is never touched.

**Closed-loop debugging**: dev builds register a localhost eval endpoint (`POST http://127.0.0.1:23124/refs-dev/eval`, JSON `{token, code}`, token in `src/modules/devEval.ts`). `code` runs as an async function body with `Zotero` and `addon` in scope inside the dev instance — use it to select items, inspect DOM, read `Zotero.getErrors(true)` and `Zotero.Debug.get()`. It is compiled out of production builds via the `__env__` check. FTL (localization) changes are NOT hot-reloaded — restart the dev Zotero. After several hot reloads the item pane can hold zombie section instances from previous plugin versions; restart before trusting DOM-level verification.

## Architecture (src/)

- `core/types.ts` — shared contracts (`RefItem`, `Identifiers`, `MetaSource`, graph types, `SOURCE_BADGE`).
- `core/http.ts` — all network IO: per-host LIFO gates (newest hover wins), byte-budgeted LRU cache, retry with `Retry-After`.
- `core/text.ts` — pure text utils: identifier extraction, `normalizeTitle`, raw-citation parsing (`parseRefText`).
- `core/libmatch.ts` — `LibraryIndex`: O(1) in-library matching maps (DOI/arXiv/PMID/title), incremental notifier updates.
- `core/storage.ts` — per-item persistent cache (`refs-cache.json`); strips `libItemID` before persisting (deliberate).
- `core/importer.ts` — import a reference into the library + bidirectional relation.
- `sources/` — one module per metadata source (crossref, semanticscholar, openalex, arxiv, pubmed, unpaywall, cnki, readpaper) + `index.ts` registry with fallback chains.
- `pdf/parser.ts` — PDF text-layer bibliography parser (ported from zotero-reference, AGPL).
- `pdf/readerLinks.ts` — reader integration on Zotero 7+'s overlay pipeline (`_onSetOverlayPopup`, `navigate` wrap, split-view jump).
- `ui/` — `section.ts` (References panel), `citations.ts`, `related.ts`, `graphSection.ts`, `rows.ts` (shared row + hover card), `popup.ts`, `styles.ts` (single injected stylesheet).
- `graph/` — OpenAlex graph data build + d3-force SVG view.
- `hooks.ts` — lifecycle; every startup step individually guarded.

## Hard-won invariants — violate these and the plugin breaks in ways that took real debugging to find

1. **Zotero calls plugin ItemPane hooks with NO try/catch.** One exception aborts Zotero's own itemDetails render loop and wedges `_isRendering`, killing NATIVE sections too. Every hook body must stay wrapped in `guard()` / `guardAsync()` (`src/utils/guard.ts`).
2. **Fluent messages used as `data-l10n-id` on section header/sidenav must be attribute-form** (`.label` / `.tooltiptext`). A value-form message makes Fluent REPLACE the element's children, gutting Zotero's collapsible-section DOM.
3. **FTL message ids must NOT start with the addonRef prefix (`refs-`)** — the build tool skips prefixing ids that already look prefixed, silently breaking `getString`. Use `panel-*`, `menu-*`, `pref-*`, `graph-*`.
4. **Title matching must never use mid-string containment.** Two real bugs shipped from this: Crossref title search matched "Review of X" derivatives, and the library matcher matched an item titled "Small-cell lung cancer" to any ref mentioning "non-small-cell lung cancer". Current rules: API `titleSimilar` = strict normalized equality; `libmatch` fallback = shared-prefix ≥ 25 normalized chars + publication-year corroboration. Keep it strict; false negatives are cheap, false positives corrupt user data (wrong import/relation).
5. **CSS: never use the `background` shorthand on `.references-button`** (or anything carrying an icon class) — the shorthand resets `background-image` and blanks the toolbar icons. Use `background-color`.
6. **Citations paging pins the first successful source** (S2 vs OpenAlex) and dedupes across pages via a seen-set keyed by DOI/S2/OpenAlex-id/normalized title. Mixing sources across pages produces duplicates.
7. **`item.getField()` can throw `UnloadedDataException`** on items from `Zotero.Items.getAll` — always per-item try/catch in library-wide loops.
8. **Reader integration must go through the overlay pipeline** (`_onSetOverlayPopup` + `navigate` wrap). The pdf.js annotation layer is hidden in Zotero 7+ (`display:none`) and `reader.menuCmd` / `secondViewIframeWindow` no longer exist in Z9. Teardown must restore every monkey-patched original and sweep closed readers.
9. **zotero-plugin-toolkit ≥5**: no `ZoteroToolkit` main export, no `ztoolkit.Menu`. We compose `MyToolkit` from BasicTool/UITool/ProgressWindowHelper/ClipboardHelper and use the native `Zotero.MenuManager` (Z8+) with a DOM fallback for Z7.
10. **AGPL-3.0**: the PDF parser is ported from AGPL zotero-reference — the project cannot be relicensed permissively. Keep the license header intact.
11. **URLs from outside are hostile.** Anything that came from a PDF (`unsafeUrl`), a remote API, or the cache file must pass `isHttpUrl()` (core/text.ts) before it is persisted, written into an item, or handed to `Zotero.launchURL` — Zotero forwards file:/smb:/custom schemes to the OS. `storage.ts` re-sanitizes every ref on load and save.
12. **Never `await` a settle-delay or a network fetch inside `onAsyncRender`.** Zotero awaits each pane's asyncRender in sequence; schedule the fetch with `setTimeout` and return. Item-switch detection = the render's `list.isConnected` (the shared body is wiped by every render).
13. **Icons are `context-fill` / `context-stroke` SVGs** (16px header, 20px sidenav under `icons/20/`, 1px / 1.25px on the pixel grid, no dark twins). Zotero's `.btn[custom]` and `collapsible-section[custom] .head .title::before` supply `-moz-context-properties`; our own toolbar buttons set them in styles.ts.
14. **Host identifiers come from `hostIdentifiers(item)`** (DOI field/Extra, PMID/arXiv from Extra/URL) — never read `getField("DOI")` alone in a section; PubMed-imported items have no DOI field.
15. **Batch imports go through `runBatchImport`** (confirmation + click-to-stop). Never call `importAll` from a UI path directly.
16. **API titles carry HTML** (`<i>ALK</i>`, `&amp;`, newlines inside tags). Every source mapper passes title/venue/unstructured text through `cleanText()` (core/text.ts) and `storage.ts` re-cleans on load; UI code that shows a ref title must never assume it is plain.
17. **PDF parser: numbering beats geometry.** `mergeSameRef` first tries `mergeNumberedRefs` — an entry starts iff the line begins with the NEXT number in sequence (`numAtStart`: "12." "12)" "[12]" "(12)" "12 Author" and JAMA's "12 . Author"; bare numbers must be followed by a letter so wrapped volume fragments "41 , 1103" don't count). Trailing matter (licence, "Publisher's note", figure legends) is skipped until numbering resumes (Nature Methods refs 69–83). Geometry/indent merging is only the fallback for unnumbered lists. `getRefLines` walks pages backwards; after the heading page it (a) completes the heading page from committed parts (double-spaced manuscripts split every entry into a part), (b) appends later pages whose union of lines picks up the sequence, (c) ignores false headings ("References (160–200)" pointers, blocks that are not reference-like) and the "skip until bottom-right line" heuristic when the running footer leads the content stream. Regression: `scripts/parser-corpus/` (32 journals, 24/27 exact vs Crossref; KEYNOTE-189 → 31, STTT → 79, BMJ → 123, Chest manuscript → 10).
18. **CNKI credential POST must pass `logBodyLength: 0`** — Zotero's debug-log redaction is case-sensitive and misses `"Password"`.

## Releasing (auto-update depends on this exact shape)

`manifest.json` → `update_url` = `https://github.com/yimmy23/zotero-refs/releases/download/release/update.json` (a **rolling** GitHub release tagged `release` holds `update.json` / `update-beta.json`). Zotero only offers an update when the version in `update.json` is **higher** than the installed one and the `update_link` asset exists with a matching sha512 — so never re-upload a changed xpi under the same version.

1. bump `version` in `package.json` (semver) → `npm run build` (emits `refs.xpi` + `update.json` with the hash)
2. `gh release create vX.Y.Z .scaffold/build/refs.xpi --title "Refs X.Y.Z" --notes "…"`
3. `gh release upload release .scaffold/build/update.json .scaffold/build/update-beta.json --clobber`
4. verify: `curl -sL <update_url>` shows the new version; in the dev profile install the previous xpi and run `AddonManager` `findUpdates` → `updateAvailable` (see session notes for the probe).

## Testing checklist for non-trivial changes

Run in the dev instance via the eval endpoint: select a DOI-bearing item → References section fills (count line shows source), toolbar icons visible (computed `background-image` ≠ none); hover a row → card appears with source dots and identifier/search chips; `+` imports the CORRECT item and relates it bidirectionally; Cited By pages without duplicates; Graph renders nodes ≈ `graphMaxNodes` cap; `Zotero.getErrors(true)` shows nothing from the plugin. For zh-CN strings, restart (FTL) and verify no raw message ids leak into the UI.
