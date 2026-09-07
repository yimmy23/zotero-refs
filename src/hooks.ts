import { cancelAllTimers } from "./utils/window";
import { initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { config } from "../package.json";
import { libraryIndex } from "./core/libmatch";
import { refStorage } from "./core/storage";
import { registerReferencesSection, invalidatePanelState } from "./ui/section";
import { registerCitationsSection, invalidateCitations } from "./ui/citations";
import { registerRelatedSection, invalidateRelated } from "./ui/related";
import {
  registerGraphSection,
  invalidateGraph,
  removeGraphMenus,
} from "./ui/graphSection";
import { destroyAllGraphViews } from "./graph/view";
import { registerStyles, unregisterStyles } from "./ui/styles";
import { closePopup } from "./ui/rows";
import { clearPopupTranslations } from "./core/popupTranslation";
import {
  registerItemMenus,
  registerWindowMenus,
  unregisterItemMenus,
} from "./modules/menus";
import { registerDevEval, unregisterDevEval } from "./modules/devEval";
import {
  attachAllReaders,
  detachAllReaders,
  onReaderTabSelect,
  sweepReaders,
} from "./pdf/readerHook";

let notifierID: string | undefined;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  registerDevEval();

  // every startup step individually guarded: one failing registration must
  // not take the whole plugin down
  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      ztoolkit.log(`[startup] ${name} failed`, e);
      try {
        Zotero.logError(e as any);
      } catch {
        // ignore
      }
    }
  };

  step("locale", () => initLocale());
  step("prefsPane", () =>
    Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      src: rootURI + "content/preferences.xhtml",
      label: config.addonName,
      image: `chrome://${config.addonRef}/content/icons/favicon.png`,
    }),
  );
  // library index for O(1) in-library matching
  step("libraryIndex", () => libraryIndex.register());
  // item pane sections
  step("referencesSection", () => registerReferencesSection());
  step("citationsSection", () => registerCitationsSection());
  step("relatedSection", () => registerRelatedSection());
  step("graphSection", () => registerGraphSection());
  step("itemMenus", () => registerItemMenus());

  // notifier: reader tabs + item changes
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string, type: string, ids: any[], extraData: any) => {
        if (!addon?.data.alive) return;
        void addon.hooks
          .onNotify(event, type, ids, extraData)
          .catch((error: unknown) => ztoolkit.log("[notify] failed", error));
      },
    },
    ["tab", "item"],
  );

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
  registerWindowMenus(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  closePopup(win);
  destroyAllGraphViews(win);
  unregisterStyles(win);
  addon.data.dialog?.window?.close();
}

async function onShutdown(): Promise<void> {
  addon.data.alive = false;
  unregisterDevEval();
  if (notifierID) {
    Zotero.Notifier.unregisterObserver(notifierID);
    notifierID = undefined;
  }
  closePopup();
  clearPopupTranslations();
  destroyAllGraphViews();
  removeGraphMenus();
  unregisterItemMenus();
  detachAllReaders();
  libraryIndex.unregister();
  cancelAllTimers();
  await refStorage
    .flush()
    .catch((error) => ztoolkit.log("[shutdown] cache flush failed", error));
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
