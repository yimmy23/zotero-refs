import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getWin } from "../utils/window";
import { itemCacheKey } from "../core/storage";
import type { GraphData, GraphNode } from "../core/types";
import { buildGraph } from "../graph/build";
import { GraphView } from "../graph/view";
import { identifiersToURL } from "../core/text";
import { guard, guardAsync } from "../utils/guard";

/**
 * "Citation Graph" item pane section — connected-papers-style force graph
 * built from OpenAlex data (references + citations + related works with
 * co-citation edges). Replaces the original plugin's Connected Papers
 * panel, whose private API is no longer accessible.
 */

const dataCache = new Map<string, GraphData>();
/** live GraphView per section body (the body persists across renders) */
const views = new WeakMap<HTMLElement, GraphView>();

function nodeClicked(node: GraphNode) {
  if (node.ref.libItemID) {
    const win = getWin();
    win.Zotero_Tabs.select("zotero-pane");
    win.ZoteroPane.selectItem(node.ref.libItemID);
  }
}

function nodeOpened(node: GraphNode) {
  const url = node.ref.url || identifiersToURL(node.ref.identifiers);
  if (url) Zotero.launchURL(url);
}

async function renderGraph(
  body: HTMLElement,
  item: Zotero.Item,
  setSectionSummary: (s: string) => void,
  force = false,
) {
  const doc = body.ownerDocument!;
  const container = body.querySelector<HTMLElement>(
    ".references-graph-container",
  );
  const status = body.querySelector<HTMLElement>(".references-graph-status");
  if (!container || !status) return;

  let data = force ? undefined : dataCache.get(itemCacheKey(item));
  if (!data) {
    status.textContent = getString("graph-loading");
    status.style.display = "";
    const built = await buildGraph(item, {
      maxNodes: Number(getPref("graphMaxNodes")) || 50,
      onStatus: (msg) => {
        status.textContent = msg;
      },
    });
    // the user may have switched items while OpenAlex was queried
    if (!container.isConnected) return;
    if (!built) {
      status.textContent = getString("graph-unavailable");
      setSectionSummary("—");
      return;
    }
    data = built;
    dataCache.set(itemCacheKey(item), data);
  }
  status.style.display = "none";
  // one live view per body: destroy the previous render's view (its
  // simulation, ResizeObserver and theme listener) before creating a new one
  let view = views.get(body);
  if (view && (view as any).container !== container) {
    view.destroy();
    view = undefined;
  }
  if (!view) {
    view = new GraphView(container, {
      onSelect: nodeClicked,
      onOpen: nodeOpened,
      onHover: (node) => {
        const tip = body.querySelector<HTMLElement>(".references-graph-tip");
        if (!tip) return;
        if (node) {
          tip.textContent = `${node.ref.title || ""} (${
            node.ref.year || "?"
          }) · ${node.kind}`;
          tip.style.display = "";
        } else {
          tip.style.display = "none";
        }
      },
    });
    views.set(body, view);
  }
  view.setData(data);
  setSectionSummary(`${data.nodes.length}`);
  void doc;
}

export function registerGraphSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "citation-graph",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-graph-head-text"),
      icon: `chrome://${config.addonRef}/content/icons/connectedpapers.png`,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-graph-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/connectedpapers.png`,
    },
    onItemChange: guard("graph.onItemChange", ({ item, setEnabled }) => {
      setEnabled(
        !!item?.isRegularItem?.() &&
          !!(item.getField("DOI") as string)?.trim() &&
          !!getPref("graphEnable"),
      );
      return true;
    }),
    onRender: () => {},
    onAsyncRender: guardAsync(
      "graph.onAsyncRender",
      async ({ body, item, setSectionSummary }) => {
      if (!item?.isRegularItem?.()) return;
      const doc = body.ownerDocument!;
      body.textContent = "";
      (body as HTMLElement).classList.add("references-panel");

      const toolbar = doc.createElement("div");
      toolbar.className = "references-toolbar";
      const status = doc.createElement("span");
      status.className = "references-graph-status references-count";
      toolbar.append(status);
      const spacer = doc.createElement("span");
      spacer.className = "references-spacer";
      toolbar.append(spacer);
      const rebuild = doc.createElement("button");
      rebuild.className = "references-button";
      rebuild.textContent = getString("graph-rebuild");
      rebuild.addEventListener("click", () =>
        renderGraph(body as HTMLElement, item, setSectionSummary, true),
      );
      toolbar.append(rebuild);
      body.append(toolbar);

      const container = doc.createElement("div");
      container.className = "references-graph-container";
      body.append(container);

      const tip = doc.createElement("div");
      tip.className = "references-graph-tip";
      tip.style.display = "none";
      body.append(tip);

      await renderGraph(body as HTMLElement, item, setSectionSummary);
      },
    ),
  });
}

export function invalidateGraph(stateKeys?: string[]) {
  if (!stateKeys) dataCache.clear();
  else for (const key of stateKeys) dataCache.delete(key);
}
