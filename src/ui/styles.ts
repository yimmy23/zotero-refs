import { config } from "../../package.json";

/**
 * One stylesheet for all plugin UI, injected per main window.
 *
 * Design rules (keep them, they are what makes the panes look native):
 * - Zotero CSS variables only (--fill-*, --color-*, --zotero-font-size);
 *   never hardcode greys. Light/dark then come for free.
 * - Icons are context-fill/context-stroke SVGs; the element carrying them
 *   sets `-moz-context-properties` and the fill/stroke color.
 * - Base text inherits Zotero's item-pane size (13px by default); secondary
 *   text is one notch smaller via calc(var(--zotero-font-size) * .923).
 * - Everything inside a section is inset 12px like Zotero's own lists.
 * - `.references-button` must set background-COLOR, never the `background`
 *   shorthand: the shorthand resets background-image and blanks the icons.
 */
export function registerStyles(win: Window) {
  const doc = win.document;
  const id = `${config.addonRef}-styles`;
  if (doc.getElementById(id)) return;
  const style = doc.createElement("style");
  style.id = id;
  const icons = `chrome://${config.addonRef}/content/icons`;
  style.textContent = `
    /* ---------- accent ----------
       Refs' own accent, shared with Zest: a light GitHub green. Zotero's
       --color-accent is the system selection blue, so the plugin draws its
       own surfaces from these tokens instead. --refs-accent-strong mixes
       toward the theme's text colour, so it darkens on light and lightens
       on dark and stays readable in both. */
    :root {
      --refs-accent: #40c463;
      --refs-accent-strong: color-mix(in srgb, var(--refs-accent) 72%, var(--fill-primary, #000));
      --refs-accent-wash: color-mix(in srgb, var(--refs-accent) 26%, transparent);
    }
    .references-panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      --refs-font-secondary: calc(var(--zotero-font-size, 13px) * .923);
    }
    .references-panel { box-sizing: border-box; min-width: 0; padding: 8px 10px 12px 12px; gap: 8px; }
    .references-panel > * { min-width: 0; }

    /* ---------- toolbar ---------- */
    .references-toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      padding: 0;
      min-height: 24px;
    }
    .references-count {
      font-size: var(--refs-font-secondary);
      color: var(--fill-secondary);
      cursor: default;
      user-select: none;
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .references-spacer { flex: 0 0 0; }

    .references-button {
      box-sizing: border-box;
      font-size: var(--refs-font-secondary);
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid var(--fill-quinary);
      background-color: transparent;
      color: inherit;
      cursor: pointer;
    }
    .references-button:hover { background-color: var(--fill-quinary); }
    .references-button:active { background-color: var(--fill-quarternary); }
    .references-button:disabled { opacity: .5; cursor: default; }

    .references-icon-button {
      flex: 0 0 20px;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background-position: center;
      background-repeat: no-repeat;
      background-size: 16px 16px;
      -moz-context-properties: fill, fill-opacity, stroke, stroke-opacity;
      fill: var(--fill-secondary);
      stroke: var(--fill-secondary);
    }
    .references-icon-button:hover { fill: var(--fill-primary); stroke: var(--fill-primary); }
    .references-icon-refresh { background-image: url("${icons}/refresh.svg"); }
    .references-icon-import  { background-image: url("${icons}/import.svg"); }
    .references-icon-copy    { background-image: url("${icons}/copy.svg"); }

    /* PDF | API segmented switch: selected segment = source of the next fetch */
    .references-apitag {
      display: inline-block;
      padding: 0 4px;
      border-radius: 4px;
      font-size: calc(var(--refs-font-secondary) * .9);
      font-weight: 600;
      color: var(--refs-accent-strong);
      background-color: var(--refs-accent-wash);
    }

    /* ---------- search ---------- */
    .references-search {
      display: flex;
      align-items: center;
      border: 1px solid var(--fill-quinary);
      border-radius: 8px;
      padding: 5px 9px;
      margin: 0;
      min-height: 28px;
      background-color: var(--material-background);
    }
    .references-search:focus-within {
      box-shadow: 0 0 0 1px var(--fill-secondary);
    }
    .references-search input {
      border: none;
      outline: none;
      background: transparent;
      color: inherit;
      width: 100%;
      font-size: inherit;
    }

    /* ---------- rows ---------- */
    .references-list {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      max-height: 600px;
    }
    .references-row {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      padding: 9px 6px;
      border-radius: 6px;
      border-bottom: 1px solid var(--fill-quinary);
      cursor: default;
    }
    .references-row:hover, .references-row.active {
      background-color: var(--fill-quinary);
    }
    .references-row .cell-icon {
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      margin-top: 1px;
    }
    .references-row-label {
      flex: 1;
      font-size: inherit;
      line-height: 1.55;
      word-break: break-word;
      user-select: none;
    }
    .references-row.compact .references-row-label {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .references-related-row {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) auto;
      column-gap: 7px;
      row-gap: 3px;
    }
    .references-related-reason {
      grid-column: 2 / 4;
      font-size: .85em;
      color: var(--fill-secondary);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .references-related-status {
      color: var(--fill-secondary);
      font-size: .9em;
      line-height: 1.5;
      margin: 0 2px 6px;
      overflow-wrap: anywhere;
    }
    .references-related-status:empty { display: none; }
    .references-related-panel .references-toolbar > .references-count {
      flex: 1 1 auto;
      padding-bottom: 0;
    }
    .references-retracted {
      display: inline-block;
      vertical-align: 1px;
      padding: 0 5px;
      border-radius: 4px;
      font-size: calc(var(--zotero-font-size, 13px) * .77);
      font-weight: 600;
      letter-spacing: .02em;
      color: #fff;
      background-color: #c8102e;
    }
    /* + / − affordance: quiet grey glyph, coloured only on hover (native
       rows reveal actions on hover; a permanent red minus reads as delete) */
    .references-row-action {
      flex: 0 0 26px;
      width: 26px;
      min-height: 26px;
      border: 1px solid var(--fill-quinary);
      background-color: transparent;
      padding: 0;
      font-family: inherit;
      text-align: center;
      font-weight: 600;
      font-size: 1.05em;
      line-height: 1.3;
      cursor: pointer;
      user-select: none;
      border-radius: 4px;
      color: var(--fill-tertiary);
    }
    .references-row:hover .references-row-action.is-plus { color: var(--refs-accent-strong); }
    .references-row:hover .references-row-action.is-minus { color: var(--fill-secondary); }
    .references-row-action.is-minus:hover { color: var(--accent-red); }
    .references-row-action:hover { background-color: var(--fill-quarternary); }
    .references-row-edit {
      flex: 1;
      font-size: inherit;
      background: var(--material-background);
      color: inherit;
      border: 1px solid var(--fill-quinary);
      border-radius: 4px;
    }
    .references-load-more {
      margin: 4px auto;
      display: block;
    }

    /* ---------- graph ---------- */
    .references-graph-legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 2px 10px;
      font-size: var(--refs-font-secondary);
      color: var(--fill-secondary);
      padding: 0 1px 4px 1px;
      user-select: none;
    }
    .references-graph-legend-entry {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      white-space: nowrap;
    }
    .references-graph-legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .references-graph-legend-hint { color: var(--fill-tertiary); white-space: nowrap; }
    .references-graph-container {
      box-sizing: border-box;
      width: 100%;
      height: 380px;
      overflow: hidden;
      border: 1px solid var(--fill-quinary);
      border-radius: 10px;
      position: relative;
    }
    .references-graph-tip {
      font-size: var(--refs-font-secondary);
      color: var(--fill-secondary);
      padding: 3px 1px;
      min-height: 1.2em;
    }
    .references-toolbar > .references-count { flex-basis: 100%; padding-bottom: 2px; font-variant-numeric: tabular-nums; }
    .references-actions { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; width: 100%; }
    .references-labeled-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 30px; font: inherit; font-size: var(--refs-font-secondary); white-space: nowrap; margin: 0; }
    .references-labeled-button > .references-icon-button { flex: 0 0 16px; width: 16px; height: 16px; }
    .references-refresh { color: var(--fill-primary); background-color: var(--fill-quinary); border-color: var(--fill-quinary); }
    .references-refresh .references-icon-button { fill: var(--fill-secondary); stroke: var(--fill-secondary); }
    .references-menu { position: relative; margin-inline-start: auto; }
    .references-menu > summary { cursor: pointer; list-style-position: inside; }
    .references-menu > summary::marker { font-size: .7em; }
    .references-menu-content { position: absolute; inset-inline-end: 0; top: calc(100% + 5px); z-index: 20; display: flex; flex-direction: column; min-width: 200px; padding: 5px; background-color: var(--material-background); border: 1px solid var(--fill-quarternary); border-radius: 9px; box-shadow: 0 5px 18px color-mix(in srgb, var(--fill-primary) 15%, transparent); }
    .references-menu-command { font: inherit; text-align: start; border: 0; background-color: transparent; color: inherit; padding: 8px 10px; border-radius: 5px; cursor: pointer; }
    .references-menu-command:hover { background-color: var(--fill-quinary); }
    .references-search input { min-width: 0; margin: 0; padding: 0; }
    .references-search-clear { font: inherit; border: 0; border-radius: 4px; background-color: transparent; color: var(--fill-secondary); width: 24px; height: 24px; cursor: pointer; padding: 0; }
    .references-search-clear[hidden], .references-row[hidden] { display: none; }
    .references-filter-count { font-size: var(--refs-font-secondary); color: var(--fill-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .references-empty { padding: 20px 12px; line-height: 1.6; color: var(--fill-secondary); text-align: center; border: 1px dashed var(--fill-quarternary); border-radius: 8px; }
    .references-row-label, .references-row > .cell-icon { opacity: var(--refs-row-opacity, 1); }
    .references-row:focus-within .references-row-label, .references-row:hover .references-row-label { opacity: 1; }
    .references-row:focus-within { background-color: var(--fill-quinary); }
    .references-row-label { min-width: 0; }
    .references-row-edit { box-sizing: border-box; min-width: 0; padding: 8px; line-height: 1.5; }
    .references-load-more { width: 100%; min-height: 32px; margin: 2px 0; border-style: dashed; }
    .references-panel :is(button, summary, select, textarea, [role="button"]):focus-visible,
    .references-popup-container :is(button, [tabindex]):focus-visible { outline: 2px solid var(--fill-secondary); outline-offset: 2px; }
    .references-popup-container { box-sizing: border-box; padding: 5px; border: 1px solid var(--fill-quarternary); border-radius: 12px; box-shadow: 0 8px 28px color-mix(in srgb, var(--fill-primary) 16%, transparent); max-width: calc(100vw - 24px); max-height: min(720px, calc(100vh - 24px)); overflow: hidden; }
    .references-popup-container #content-container { min-height: 0; min-width: 0; width: 100%; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; scrollbar-width: thin; border-radius: 8px; }
    .references-popup-tip { display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 12px 13px; }
    .references-popup-container .title { display: block; margin: 0; font-size: 1.16em; font-weight: 650; line-height: 1.45; overflow-wrap: anywhere; }
    .references-popup-container .descriptions { display: flex; flex-direction: column; gap: 6px; }
    .references-popup-detail { display: grid; grid-template-columns: minmax(0, 6em) minmax(0, 1fr); align-items: baseline; gap: 4px 9px; min-width: 0; }
    .references-popup-caption { font-size: .78em; line-height: 1.4; font-weight: 600; color: color-mix(in srgb, currentColor 62%, transparent); }
    .references-popup-detail-value { font-size: .93em; line-height: 1.55; overflow-wrap: anywhere; cursor: pointer; border-radius: 3px; }
    .references-popup-detail-value:hover { text-decoration: underline; text-decoration-color: var(--fill-quarternary); text-underline-offset: 3px; }
    .references-popup-container .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; }
    .references-popup-chip { font: inherit; font-size: .82em; min-height: 26px; max-width: 100%; overflow-wrap: anywhere; line-height: 1.4; }
    .references-popup-body { display: flex; flex-direction: column; gap: 7px; padding-top: 12px; border-top: 1px solid var(--fill-quinary); }
    .references-popup-body-heading { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; justify-content: space-between; }
    .references-popup-body-label { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; }
    .references-popup-inline-source { font-size: .75em; line-height: 1.4; color: color-mix(in srgb, currentColor 55%, transparent); }
    .references-popup-body-actions { display: flex; flex-wrap: wrap; gap: 4px; }
    .references-popup-text-action { appearance: none; font: inherit; font-size: .78em; line-height: 1.4; padding: 3px 6px; margin: 0; border: 1px solid var(--fill-quinary); border-radius: 5px; background-color: transparent; color: inherit; cursor: pointer; }
    .references-popup-text-action:hover, .references-popup-text-action[aria-pressed="true"] { background-color: var(--fill-quinary); }
    .references-popup-text-action:disabled { opacity: .55; cursor: progress; }
    .references-popup-container .abstract { display: block; font-size: 1em; line-height: 1.75; text-align: start; white-space: pre-wrap; overflow-wrap: anywhere; }
    .references-popup-container .abstract p { margin: 0; }
    .references-popup-container .abstract p + p { margin-top: .9em; }
    .references-abstract-heading { display: block; margin-bottom: .2em; font-size: .9em; font-weight: 600; line-height: 1.5; color: inherit; }
    .references-popup-provenance { display: flex; flex-direction: column; gap: 5px; border-top: 1px solid var(--fill-quinary); padding-top: 10px; }
    .references-popup-provenance-links { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
    .references-popup-source-link { appearance: none; font: inherit; font-size: .78em; line-height: 1.6; border: 0; padding: 0; margin: 0; background-color: transparent; color: color-mix(in srgb, currentColor 72%, transparent); overflow-wrap: anywhere; }
    button.references-popup-source-link { cursor: pointer; text-decoration: underline; text-decoration-color: var(--fill-quarternary); text-underline-offset: 3px; }
    button.references-popup-source-link:hover { color: inherit; text-decoration-color: currentColor; }
    @media (max-width: 420px) { .references-popup-tip { padding: 9px; gap: 12px; } }
    @media (prefers-reduced-motion: reduce) { .references-popup-container, .references-popup-container * { transition: none !important; } }
  `;
  doc.documentElement?.appendChild(style);
}

export function unregisterStyles(win: Window) {
  win.document.getElementById(`${config.addonRef}-styles`)?.remove();
}
