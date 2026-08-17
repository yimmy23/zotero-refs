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
    .references-panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      --refs-font-secondary: calc(var(--zotero-font-size, 13px) * .923);
    }
    .references-panel > * { margin-inline-start: 12px; }

    /* ---------- toolbar ---------- */
    .references-toolbar {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      gap: 4px;
      padding: 2px 0 4px 0;
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
      font-size: var(--refs-font-secondary);
      padding: 1px 7px;
      border-radius: 5px;
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
    .references-source-seg {
      display: inline-flex;
      flex: 0 0 auto;
      border: 1px solid var(--fill-quarternary);
      border-radius: 6px;
      overflow: hidden;
      font-size: var(--refs-font-secondary);
      user-select: none;
    }
    .references-source-opt {
      padding: 0 7px;
      line-height: 18px;
      color: var(--fill-secondary);
      cursor: pointer;
    }
    .references-source-opt + .references-source-opt {
      border-inline-start: 1px solid var(--fill-quarternary);
    }
    .references-source-opt:hover { background-color: var(--fill-quinary); }
    .references-source-opt.is-on {
      background-color: var(--fill-quarternary);
      color: var(--fill-primary);
      font-weight: 600;
    }

    /* ---------- search ---------- */
    .references-search {
      display: flex;
      align-items: center;
      border: 1px solid var(--fill-quinary);
      border-radius: 5px;
      padding: 2px 6px;
      margin: 2px 0 4px 0;
    }
    .references-search:focus-within {
      box-shadow: 0 0 0 1px var(--color-accent);
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
      gap: 4px;
      padding: 2px 1px;
      border-radius: 4px;
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
      line-height: 1.3333;
      word-break: break-word;
      user-select: none;
    }
    .references-row.compact .references-row-label {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
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
      flex: 0 0 16px;
      text-align: center;
      font-weight: 600;
      font-size: 1.05em;
      line-height: 1.3;
      cursor: pointer;
      user-select: none;
      border-radius: 4px;
      color: var(--fill-tertiary);
    }
    .references-row:hover .references-row-action.is-plus { color: var(--accent-green); }
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
      width: calc(100% - 12px);
      height: 380px;
      overflow: hidden;
      border: 1px solid var(--fill-quinary);
      border-radius: 6px;
      position: relative;
    }
    .references-graph-tip {
      font-size: var(--refs-font-secondary);
      color: var(--fill-secondary);
      padding: 3px 1px;
      min-height: 1.2em;
    }
  `;
  doc.documentElement?.appendChild(style);
}

export function unregisterStyles(win: Window) {
  win.document.getElementById(`${config.addonRef}-styles`)?.remove();
}
