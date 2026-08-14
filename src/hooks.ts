import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { config } from "../package.json";
import { libraryIndex } from "./core/libmatch";
import { refStorage } from "./core/storage";
import { registerReferencesSection, invalidatePanelState } from "./ui/section";
import { registerCitationsSection, invalidateCitations } from "./ui/citations";
import { registerRelatedSection, invalidateRelated } from "./ui/related";
import { registerGraphSection, invalidateGraph } from "./ui/graphSection";
import { registerStyles, unregisterStyles } from "./ui/styles";
import { closePopup } from "./ui/rows";
import { registerItemMenus, unregisterItemMenus } from "./modules/menus";
import {
  attachAllReaders,
  detachAllReaders,
  onReaderTabSelect,
  sweepReaders,
} from "./pdf/readerHook";

let notifierID: string | undefined;
let pluginsObserverAdded = false;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  // preference pane
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });

  // library index for O(1) in-library matching
  libraryIndex.register();

  // item pane sections
  registerReferencesSection();
  registerCitationsSection();
  registerRelatedSection();
  registerGraphSection();
  registerItemMenus();

  // notifier: reader tabs + item changes
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, type: string, ids: any[], extraData: any) => {
        if (!addon?.data.alive) return;
        addon.hooks.onNotify(event, type, ids, extraData);
      },
    },
    ["tab", "item"],
  );
  if (!pluginsObserverAdded) {
    pluginsObserverAdded = true;
    Zotero.Plugins.addObserver({
      shutdown: ({ id }: { id: string }) => {
        if (id === config.addonID && notifierID) {
          Zotero.Notifier.unregisterObserver(notifierID);
          notifierID = undefined;
        }
      },
    });
  }

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // readers already open at startup
  void attachAllReaders();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-addon.ftl`);
  registerStyles(win as unknown as Window);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  closePopup();
  unregisterStyles(win);
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  closePopup();
  unregisterItemMenus();
  detachAllReaders();
  libraryIndex.unregister();
  void refStorage.flush();
  for (const win of Zotero.getMainWindows()) {
    unregisterStyles(win as unknown as Window);
  }
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (type === "tab" && (event === "add" || event === "select")) {
    for (const id of ids) {
      const data = extraData?.[id];
      if (data?.type === "reader" || event === "select") {
        onReaderTabSelect(String(id));
      }
    }
  }
  if (type === "tab" && event === "close") {
    sweepReaders();
  }
  if (type === "item" && (event === "delete" || event === "trash")) {
    // dropped items: clear cached panel state (keys unknown -> clear all)
    invalidatePanelState();
    invalidateCitations();
    invalidateRelated();
    invalidateGraph();
  }
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
};
