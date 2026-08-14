import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { refStorage } from "../core/storage";
import { importAll } from "../core/importer";
import { getReferencesByAPI } from "../sources";
import type { RefItem } from "../core/types";

/**
 * Library item context menu: batch operations on selected items.
 * Uses the Zotero 8+ `Zotero.MenuManager` API when available (the current
 * official menu architecture) and falls back to ztoolkit.Menu on Zotero 7.
 */

let registeredID: string | undefined;
let usedFallback = false;

async function refsFor(item: Zotero.Item): Promise<RefItem[] | null> {
  // cached first (either slot), then API
  for (const slot of ["API", "PDF"]) {
    const cached = await refStorage.get(item.key, slot);
    if (cached?.length) return cached;
  }
  const result = await getReferencesByAPI(item);
  if (result?.refs.length) {
    if (getPref("saveAPIReferences")) {
      void refStorage.set(item.key, "API", result.refs);
    }
    return result.refs;
  }
  return null;
}

/** batch pre-fetch references of the selected items into the cache */
async function fetchAction(items: Zotero.Item[]) {
  const targets = items.filter((i) => i.isRegularItem());
  const popupWin = new ztoolkit.ProgressWindow(getString("menu-fetch-refs", "label"), {
    closeTime: -1,
    closeOtherProgressWindows: true,
  })
    .createLine({ text: `0/${targets.length}`, type: "default", progress: 0 })
    .show();
  let ok = 0;
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    try {
      const refs = await refsFor(item);
      if (refs) ok++;
      popupWin.changeLine({
        text: `${i + 1}/${targets.length} ${refs ? "✓" : "✗"} ${(item.getField("title") as string).slice(0, 30)}`,
        progress: ((i + 1) / targets.length) * 100,
      });
    } catch (e) {
      ztoolkit.log("[menus] fetch failed", e);
    }
  }
  popupWin.changeHeadline("[Done]");
  popupWin.changeLine({
    text: `✓ ${ok}/${targets.length}`,
    type: ok ? "success" : "fail",
    progress: 100,
  });
  popupWin.startCloseTimer(3000);
}

/** import every reference of each selected item and relate bidirectionally */
async function importAction(items: Zotero.Item[]) {
  for (const item of items.filter((i) => i.isRegularItem())) {
    const refs = await refsFor(item);
    if (!refs?.length) {
      new ztoolkit.ProgressWindow(getString("menu-import-refs", "label"))
        .createLine({
          text: `✗ ${(item.getField("title") as string).slice(0, 40)}`,
          type: "fail",
        })
        .show();
      continue;
    }
    const popupWin = new ztoolkit.ProgressWindow(
      getString("menu-import-refs", "label"),
      { closeTime: -1, closeOtherProgressWindows: true },
    )
      .createLine({ text: `0/${refs.length}`, type: "default", progress: 0 })
      .show();
    const { ok, fail } = await importAll(item, refs, undefined, (done, total, msg) =>
      popupWin.changeLine({
        text: `${done}/${total} ${msg}`,
        progress: (done / total) * 100,
      }),
    );
    popupWin.changeHeadline("[Done]");
    popupWin.changeLine({
      text: `✓ ${ok}  ✗ ${fail}`,
      type: fail ? "fail" : "success",
      progress: 100,
    });
    popupWin.startCloseTimer(4000);
  }
}

/** copy all references of the first selected item */
async function copyAction(items: Zotero.Item[]) {
  const item = items.find((i) => i.isRegularItem());
  if (!item) return;
  const refs = await refsFor(item);
  if (!refs?.length) {
    new ztoolkit.ProgressWindow("References")
      .createLine({ text: getString("refs-api-fail"), type: "fail" })
      .show();
    return;
  }
  const text = refs
    .map((r, i) => `[${r.number || i + 1}] ${r.text || r.title || ""}`)
    .join("\n");
  new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
  new ztoolkit.ProgressWindow("References")
    .createLine({ text: getString("refs-copy-all-done"), type: "success" })
    .show();
}

export function registerItemMenus() {
  const mm = (Zotero as any).MenuManager;
  if (mm?.registerMenu) {
    // Zotero 8+ official menu architecture
    registeredID = mm.registerMenu({
      menuID: `${config.addonRef}-item-menu`,
      pluginID: config.addonID,
      target: "main/library/item",
      menus: [
        {
          menuType: "submenu",
          l10nID: getLocaleID("menu-references"),
          onShowing: (_ev: any, context: any) => {
            context.setVisible?.(
              !!context.items?.some((i: Zotero.Item) => i.isRegularItem()),
            );
          },
          menus: [
            {
              menuType: "menuitem",
              l10nID: getLocaleID("menu-fetch-refs"),
              onCommand: (_ev: any, context: any) =>
                void fetchAction(context.items || []),
            },
            {
              menuType: "menuitem",
              l10nID: getLocaleID("menu-import-refs"),
              onCommand: (_ev: any, context: any) =>
                void importAction(context.items || []),
            },
            {
              menuType: "menuitem",
              l10nID: getLocaleID("menu-copy-refs"),
              onCommand: (_ev: any, context: any) =>
                void copyAction(context.items || []),
            },
          ],
        },
      ],
    });
    return;
  }
  // Zotero 7: no MenuManager — build the submenu directly into the item
  // context menu of each main window.
  usedFallback = true;
  for (const win of Zotero.getMainWindows()) {
    const doc = win.document;
    if (!doc || doc.getElementById(`${config.addonRef}-item-menu-z7`)) {
      continue;
    }
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) continue;
    const menu = doc.createXULElement("menu") as any;
    menu.id = `${config.addonRef}-item-menu-z7`;
    menu.setAttribute("label", getString("menu-references", "label"));
    const popup = doc.createXULElement("menupopup");
    const entries: Array<[string, (items: Zotero.Item[]) => void]> = [
      ["menu-fetch-refs", (items) => void fetchAction(items)],
      ["menu-import-refs", (items) => void importAction(items)],
      ["menu-copy-refs", (items) => void copyAction(items)],
    ];
    for (const [key, run] of entries) {
      const mi = doc.createXULElement("menuitem") as any;
      mi.setAttribute("label", getString(key as "menu-fetch-refs", "label"));
      mi.addEventListener("command", () => {
        run(win.ZoteroPane?.getSelectedItems() || []);
      });
      popup.append(mi);
    }
    menu.append(popup);
    itemMenu.append(menu);
  }
}

export function unregisterItemMenus() {
  const mm = (Zotero as any).MenuManager;
  if (registeredID && mm?.unregisterMenu) {
    try {
      mm.unregisterMenu(registeredID);
    } catch (e) {
      ztoolkit.log("[menus] unregister failed", e);
    }
    registeredID = undefined;
  }
  if (usedFallback) {
    for (const win of Zotero.getMainWindows()) {
      win.document
        ?.getElementById(`${config.addonRef}-item-menu-z7`)
        ?.remove();
    }
    usedFallback = false;
  }
}
