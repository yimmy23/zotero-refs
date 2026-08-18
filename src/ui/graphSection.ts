import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { getNumPref, getPref } from "../utils/prefs";
import { clearTimeout, getWin, setTimeout } from "../utils/window";
import { itemCacheKey } from "../core/storage";
import type { GraphData, GraphNode, Identifiers, RefItem } from "../core/types";
import { buildGraph } from "../graph/build";
import { GraphView } from "../graph/view";
import type { GraphHandlers } from "../graph/view";
import {
  cleanText,
  collapseText,
  hostIdentifiers,
  identifiersToURL,
  isHttpUrl,
} from "../core/text";
import { addRelation, importReference } from "../core/importer";
import { isRelated } from "../core/libmatch";
import { getCurrentPopup, showRefPopup } from "./rows";
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

/** what the graph is currently centred on, per section body */
interface GraphCenter {
  ids: Identifiers;
  /** cache key suffix ("" = the item itself) */
  key: string;
  /** short label for the "back to this item" affordance */
  label: string;
}
const centers = new WeakMap<HTMLElement, GraphCenter>();

function nodeClicked(node: GraphNode) {
  if (node.ref.libItemID) {
    const win = getWin();
    win.Zotero_Tabs.select("zotero-pane");
    win.ZoteroPane.selectItem(node.ref.libItemID);
  }
}

function nodeOpened(node: GraphNode) {
  const url =
    (isHttpUrl(node.ref.url) ? node.ref.url : undefined) ||
    identifiersToURL(node.ref.identifiers);
  if (isHttpUrl(url)) Zotero.launchURL(url);
}

/** import a graph node into the library, relate it to the host item */
async function importNode(
  hostItem: Zotero.Item,
  node: GraphNode,
  view: GraphView | undefined,
) {
  const label = collapseText(node.ref.title || node.ref.text || "");
  const popupWin = new ztoolkit.ProgressWindow(getString("graph-menu-import"), {
    closeTime: -1,
    closeOtherProgressWindows: true,
  })
    .createLine({ text: label, type: "default", progress: 10 })
    .show();
  try {
    const refItem = await importReference(hostItem, node.ref, undefined, (m) =>
      popupWin.changeLine({ text: m }),
    );
    if (!refItem) {
      popupWin.changeLine({ text: `✗ ${label}`, type: "fail", progress: 100 });
      popupWin.startCloseTimer(4000);
      return;
    }
    if (!isRelated(hostItem, refItem)) await addRelation(hostItem, refItem);
    node.ref.libItemID = refItem.id;
    node.inLibrary = true;
    view?.setInLibrary(node.id, true);
    popupWin.changeLine({ text: `✓ ${label}`, type: "success", progress: 100 });
    popupWin.startCloseTimer(3000);
  } catch (e) {
    ztoolkit.log("[graph] import failed", e);
    popupWin.changeLine({ text: `✗ ${label}`, type: "fail", progress: 100 });
    popupWin.startCloseTimer(4000);
  }
}

/** plain-text citation of a node for the clipboard */
function citationText(ref: RefItem): string {
  const authors = ref.authors || [];
  const who =
    authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "");
  const doi = ref.identifiers.DOI
    ? ` https://doi.org/${ref.identifiers.DOI}`
    : "";
  return (
    [
      who,
      ref.year ? `(${ref.year}).` : "",
      ref.title ? `${ref.title}.` : "",
      ref.primaryVenue ? `${ref.primaryVenue}.` : "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim() + doi
  );
}

/**
 * Right-click menu on a node: import / locate / open (DOI · PubMed ·
 * Scholar) / copy / re-centre the graph on this work. One XUL menupopup is
 * kept per main window and rebuilt on every open.
 */
function showNodeMenu(
  body: HTMLElement,
  item: Zotero.Item,
  setSectionSummary: (s: string) => void,
  node: GraphNode,
  screenX: number,
  screenY: number,
) {
  const win = getWin();
  const doc = win.document;
  const id = `${config.addonRef}-graph-node-menu`;
  let popup = doc.getElementById(id) as any;
  if (!popup) {
    popup = doc.createXULElement("menupopup");
    popup.id = id;
    (doc.querySelector("popupset") || doc.documentElement!).appendChild(popup);
  }
  while (popup.firstChild) popup.removeChild(popup.firstChild);
  const add = (label: string, run: () => void, disabled = false) => {
    const mi = doc.createXULElement("menuitem") as any;
    mi.setAttribute("label", label);
    if (disabled) mi.setAttribute("disabled", "true");
    mi.addEventListener("command", () => guard("graph.menu", run)());
    popup.appendChild(mi);
    return mi;
  };
  const sep = () => popup.appendChild(doc.createXULElement("menuseparator"));

  const ref = node.ref;
  const title = ref.title || ref.text || "";
  const q = encodeURIComponent(title);
  const view = views.get(body);

  if (ref.libItemID) {
    add(getString("graph-menu-locate"), () => nodeClicked(node));
  } else {
    add(
      getString("graph-menu-import"),
      () => void importNode(item, node, view),
    );
  }
  sep();
  if (ref.identifiers.DOI) {
    add(getString("graph-menu-open-doi"), () =>
      Zotero.launchURL(`https://doi.org/${ref.identifiers.DOI}`),
    );
  }
  add(getString("graph-menu-pubmed"), () =>
    Zotero.launchURL(
      ref.identifiers.PMID
        ? `https://pubmed.ncbi.nlm.nih.gov/${ref.identifiers.PMID}/`
        : `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`,
    ),
  );
  add(getString("graph-menu-scholar"), () =>
    Zotero.launchURL(`https://scholar.google.com/scholar?q=${q}`),
  );
  sep();
  add(getString("graph-menu-copy"), () => {
    new ztoolkit.Clipboard().addText(citationText(ref), "text/unicode").copy();
    new ztoolkit.ProgressWindow(getString("panel-copied"), {
      closeOtherProgressWindows: true,
    })
      .createLine({ text: collapseText(title, 60), type: "success" })
      .show();
  });
  const canCenter =
    node.kind !== "origin" &&
    !!(ref.identifiers.openAlex || ref.identifiers.DOI || ref.identifiers.PMID);
  add(
    getString("graph-menu-recenter"),
    () => {
      centers.set(body, {
        ids: {
          openAlex: ref.identifiers.openAlex,
          DOI: ref.identifiers.DOI,
          PMID: ref.identifiers.PMID,
        },
        key:
          ref.identifiers.openAlex ||
          ref.identifiers.DOI ||
          ref.identifiers.PMID ||
          "",
        label: nodeShortLabel(node),
      });
      void renderGraph(body, item, setSectionSummary);
    },
    !canCenter,
  );
  popup.openPopupAtScreen(screenX, screenY, true);
}

function nodeShortLabel(node: GraphNode): string {
  const author = (node.ref.authors?.[0] || "").trim().split(/\s+/).pop() || "";
  return (
    [author, node.ref.year].filter(Boolean).join(" ") ||
    collapseText(node.ref.title || "", 20)
  );
}

/** hover: tip line + (after the usual delay) the multi-source card */
function makeHoverHandler(
  body: HTMLElement,
  item: Zotero.Item,
): GraphHandlers["onHover"] {
  let hoverTimer: number | undefined;
  return (node, rect) => {
    const tip = body.querySelector<HTMLElement>(".references-graph-tip");
    // never toggle display: a layout jump under the canvas while the
    // pointer is over it re-fires enter/leave and looks like flicker
    if (tip) {
      tip.textContent = node
        ? `${cleanText(node.ref.title) || ""} (${node.ref.year || "?"}) · ${getString(
            `graph-legend-${node.kind}` as "graph-legend-origin",
          )}`
        : "\u00a0";
    }
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
    if (!node) {
      // leaving the node: let the card linger like the reader hover does —
      // moving into the card cancels this timer (popup mouseenter)
      const popup = getCurrentPopup();
      if (popup) {
        popup.tipTimer = setTimeout(() => {
          if (getCurrentPopup() === popup) popup.clear();
        }, popup.removeTipAfterMillisecond);
      }
      return;
    }
    if (!getPref("showPopup") || !rect) return;
    hoverTimer = setTimeout(
      () => {
        hoverTimer = undefined;
        const view = views.get(body);
        showRefPopup(node.ref, rect, "left", undefined, {
          onImport: () => void importNode(item, node, view),
        });
      },
      getNumPref("graphPopupDelay", 550),
    );
  };
}

async function renderGraph(
  body: HTMLElement,
  item: Zotero.Item,
  setSectionSummary: (s: string) => void,
  force = false,
) {
  const container = body.querySelector<HTMLElement>(
    ".references-graph-container",
  );
  const status = body.querySelector<HTMLElement>(".references-graph-status");
  const home = body.querySelector<HTMLElement>(".references-graph-home");
  if (!container || !status) return;

  const center = centers.get(body) ?? {
    ids: hostIdentifiers(item),
    key: "",
    label: "",
  };
  const cacheKey = itemCacheKey(item) + (center.key ? `#${center.key}` : "");
  if (home) {
    home.style.display = center.key ? "" : "none";
    home.textContent = center.key ? `↩ ${getString("graph-back-home")}` : "";
    home.title = center.key
      ? `${getString("graph-centered-on")} ${center.label}`
      : "";
  }

  let data = force ? undefined : dataCache.get(cacheKey);
  if (!data) {
    status.textContent = getString("graph-loading");
    status.style.display = "";
    const built = await buildGraph(
      { ids: center.ids, libraryID: item.libraryID },
      {
        maxNodes: Number(getPref("graphMaxNodes")) || 50,
        onStatus: (msg) => {
          status.textContent = msg;
        },
      },
    );
    // the user may have switched items while OpenAlex was queried
    if (!container.isConnected) return;
    if (!built) {
      status.textContent = getString("graph-unavailable");
      setSectionSummary("—");
      return;
    }
    data = built;
    if (dataCache.size >= 100) {
      const oldest = dataCache.keys().next().value;
      if (oldest !== undefined) dataCache.delete(oldest);
    }
    dataCache.set(cacheKey, data);
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
      onHover: makeHoverHandler(body, item),
      onContext: (node, sx, sy) =>
        showNodeMenu(body, item, setSectionSummary, node, sx, sy),
    });
    views.set(body, view);
  }
  view.setData(data);
  setSectionSummary(`${data.nodes.length}`);
}

export function registerGraphSection() {
  Zotero.ItemPaneManager.registerSection({
    paneID: "citation-graph",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-graph-head-text"),
      icon: `chrome://${config.addonRef}/content/icons/graph.svg`,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-graph-sidenav-tooltip"),
      icon: `chrome://${config.addonRef}/content/icons/20/graph.svg`,
    },
    onItemChange: guard("graph.onItemChange", ({ item, setEnabled }) => {
      if (!item?.isRegularItem?.() || !getPref("graphEnable")) {
        setEnabled(false);
        return true;
      }
      const ids = hostIdentifiers(item);
      setEnabled(!!(ids.DOI || ids.PMID));
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
        // a fresh render always starts centred on the item itself
        centers.delete(body as HTMLElement);
        const home = doc.createElement("button");
        home.className = "references-button references-graph-home";
        home.style.display = "none";
        home.addEventListener("click", () => {
          centers.delete(body as HTMLElement);
          void renderGraph(body as HTMLElement, item, setSectionSummary);
        });
        toolbar.append(home);
        const rebuild = doc.createElement("button");
        rebuild.className =
          "references-button references-icon-button references-icon-refresh";
        rebuild.title = getString("graph-rebuild");
        rebuild.addEventListener("click", () =>
          renderGraph(body as HTMLElement, item, setSectionSummary, true),
        );
        toolbar.append(rebuild);
        body.append(toolbar);

        // legend: node color semantics + the solid-means-in-library rule
        const legend = doc.createElement("div");
        legend.className = "references-graph-legend";
        const legendEntries: Array<[string, string]> = [
          ["#e8710a", getString("graph-legend-origin")],
          ["#4a90d9", getString("graph-legend-reference")],
          ["#35999a", getString("graph-legend-citation")],
          ["#9b7fd4", getString("graph-legend-related")],
        ];
        for (const [color, label] of legendEntries) {
          const entry = doc.createElement("span");
          entry.className = "references-graph-legend-entry";
          const dot = doc.createElement("span");
          dot.className = "references-graph-legend-dot";
          dot.style.backgroundColor = color;
          entry.append(dot, label);
          legend.append(entry);
        }
        const hint = doc.createElement("span");
        hint.className = "references-graph-legend-hint";
        hint.textContent = getString("graph-legend-hint");
        legend.append(hint);
        body.append(legend);

        const container = doc.createElement("div");
        container.className = "references-graph-container";
        body.append(container);

        const tip = doc.createElement("div");
        tip.className = "references-graph-tip";
        tip.textContent = "\u00a0";
        body.append(tip);

        if (dataCache.has(itemCacheKey(item))) {
          await renderGraph(body as HTMLElement, item, setSectionSummary);
          return;
        }
        // settle debounce OUTSIDE the awaited render — the OpenAlex build is
        // the most expensive auto-fetch, so never fire it per arrow-key step
        // and never hold up Zotero's item-pane render loop for it
        setTimeout(
          guard("graph.autoBuild", () => {
            if (!container.isConnected) return;
            void renderGraph(body as HTMLElement, item, setSectionSummary);
          }),
          350,
        );
      },
    ),
  });
}

/** remove the per-window node context menu (plugin shutdown / window unload) */
export function removeGraphMenus() {
  for (const win of Zotero.getMainWindows()) {
    try {
      win.document
        .getElementById(`${config.addonRef}-graph-node-menu`)
        ?.remove();
    } catch {
      // window already gone
    }
  }
}

export function invalidateGraph(stateKeys?: string[]) {
  if (!stateKeys) dataCache.clear();
  else for (const key of stateKeys) dataCache.delete(key);
}
