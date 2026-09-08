import { config } from "../../package.json";

/**
 * Consume the unregister state synchronously in every existing item pane.
 * Zotero removes registrations before its asynchronous, serial notification
 * reaches all readers. Registering the same IDs meanwhile can preserve a
 * reader's old section element and its callbacks from the stopped addon.
 */
export function unregisterItemPaneSections(): void {
  const manager = Zotero.ItemPaneManager as typeof Zotero.ItemPaneManager & {
    customSectionData?: {
      options?: Array<{ pluginID?: string; paneID?: string }>;
    };
  };
  const report = (error: unknown) =>
    ztoolkit.log("[item panes] lifecycle cleanup failed", error);
  try {
    // Use the returned, namespaced IDs verbatim; they are already CSS-escaped.
    for (const option of manager?.customSectionData?.options || []) {
      if (option.pluginID !== config.addonID || !option.paneID) continue;
      try {
        // Returns boolean, not the promise of the later native notification.
        manager.unregisterSection(option.paneID);
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }

  const windows = new Set<Window>();
  try {
    for (const win of Zotero.getMainWindows())
      windows.add(win as unknown as Window);
    for (const reader of (Zotero.Reader as any)?._readers || []) {
      try {
        if (reader._window) windows.add(reader._window);
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }
  for (const win of windows) {
    try {
      if (win.closed) continue;
      for (const element of win.document.querySelectorAll("item-details")) {
        try {
          const details = element as unknown as {
            initialized?: boolean;
            renderCustomSections?: () => void;
          };
          if (
            details.initialized &&
            typeof details.renderCustomSections === "function"
          ) {
            // Synchronous on supported Zotero versions. Let native cleanup
            // remove observer targets and sidenav entries as well as DOM.
            details.renderCustomSections();
          }
        } catch (error) {
          report(error);
        }
      }
    } catch (error) {
      report(error);
    }
  }
}
