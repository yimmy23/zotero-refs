import { config } from "../../package.json";

/**
 * One stylesheet for all plugin UI, injected per main window.
 * Uses Zotero 7 CSS variables so light and dark themes both work.
 */
export function registerStyles(win: Window) {
  const doc = win.document;
  const id = `${config.addonRef}-styles`;
  if (doc.getElementById(id)) return;
  const style = doc.createElement("style");
  style.id = id;
  style.textContent = `
    .references-panel {
      display: flex;
      flex-direction: column;
      width: 100%;
    }
    .references-toolbar {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      gap: 4px;
      padding: 2px 0 4px 0;
      min-height: 24px;
    }
    .references-count {
      font-size: 0.95em;
      opacity: 0.75;
      cursor: default;
      user-select: none;
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .references-spacer { flex: 0 0 0; }
    .references-icon-button {
      flex: 0 0 24px;
      width: 24px;
      height: 22px;
      padding: 0;
      background-position: center;
      background-repeat: no-repeat;
      background-size: 16px 16px;
    }
    .references-icon-refresh {
      background-image: url("chrome://${config.addonRef}/content/icons/refresh.svg");
    }
    .references-icon-import {
      background-image: url("chrome://${config.addonRef}/content/icons/import.svg");
    }
    .references-icon-copy {
      background-image: url("chrome://${config.addonRef}/content/icons/copy.svg");
    }
    @media (prefers-color-scheme: dark) {
      .references-icon-refresh {
        background-image: url("chrome://${config.addonRef}/content/icons/refresh-dark.svg");
      }
      .references-icon-import {
        background-image: url("chrome://${config.addonRef}/content/icons/import-dark.svg");
      }
      .references-icon-copy {
        background-image: url("chrome://${config.addonRef}/content/icons/copy-dark.svg");
      }
    }
    .references-source-badge {
      flex: 0 0 auto;
      white-space: nowrap;
      font-size: 0.8em;
      border: 1px solid var(--fill-quinary, #ddd);
      border-radius: 4px;
      padding: 0 5px;
      opacity: 0.8;
      cursor: pointer;
      user-select: none;
    }
    .references-source-badge:hover { opacity: 1; }
    .references-button {
      font-size: 0.85em;
      padding: 1px 7px;
      border-radius: 5px;
      border: 1px solid var(--fill-quinary, #ddd);
      /* background-color, NOT the background shorthand: the shorthand
         resets background-image and wipes the .references-icon-* icons */
      background-color: transparent;
      color: inherit;
      cursor: pointer;
    }
    .references-button:hover {
      background-color: var(--fill-quinary, rgba(0,0,0,0.06));
    }
    .references-search {
      display: flex;
      align-items: center;
      border: 1px solid var(--fill-quinary, #e0e0e0);
      border-radius: 5px;
      padding: 2px 6px;
      margin: 2px 0 4px 0;
      opacity: 0.85;
    }
    .references-search:focus-within {
      opacity: 1;
      box-shadow: 0 0 0 1px var(--color-accent, #4072e5);
    }
    .references-search input {
      border: none;
      outline: none;
      background: transparent;
      color: inherit;
      width: 100%;
      font-size: 0.9em;
    }
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
      background: var(--fill-quinary, rgba(0,0,0,0.05));
    }
    .references-row .cell-icon {
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      margin-top: 1px;
    }
    .references-row-label {
      flex: 1;
      font-size: 0.92em;
      line-height: 1.35;
      word-break: break-word;
      user-select: none;
    }
    .references-row.compact .references-row-label {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .references-row-action {
      flex: 0 0 16px;
      text-align: center;
      font-weight: bold;
      font-size: 1.05em;
      cursor: pointer;
      user-select: none;
      border-radius: 4px;
    }
    .references-row-action.is-plus { color: var(--accent-green, #39bf68); }
    .references-row-action.is-minus { color: var(--accent-red, #d63b3b); }
    .references-row-action:hover {
      background: var(--fill-quarternary, rgba(0,0,0,0.1));
    }
    .references-row-edit {
      flex: 1;
      font-size: 0.9em;
      background: var(--material-background, transparent);
      color: inherit;
      border: 1px solid var(--fill-quinary, #ccc);
      border-radius: 4px;
    }
    .references-load-more {
      margin: 4px auto;
      display: block;
    }
    .references-graph-legend {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 2px 10px;
      font-size: 0.78em;
      opacity: 0.85;
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
    .references-graph-legend-hint {
      opacity: 0.7;
      white-space: nowrap;
    }
    .references-graph-container {
      width: 100%;
      height: 380px;
      overflow: hidden;
      border: 1px solid var(--fill-quinary, #e0e0e0);
      border-radius: 6px;
      position: relative;
    }
    .references-graph-tip {
      font-size: 0.85em;
      opacity: 0.8;
      padding: 3px 1px;
      min-height: 1.2em;
    }
  `;
  doc.documentElement?.appendChild(style);
}

export function unregisterStyles(win: Window) {
  win.document.getElementById(`${config.addonRef}-styles`)?.remove();
}
