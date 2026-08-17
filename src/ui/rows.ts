import { getNumPref, getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { getWin, setTimeout, clearTimeout } from "../utils/window";
import {
  collapseText,
  htmlToText,
  identifiersToURL,
  isChinese,
  isHttpUrl,
  refTextToInfo,
  extractIdentifiers,
} from "../core/text";
import { libraryIndex, isRelated } from "../core/libmatch";
import { addRelation, importReference, removeRelation } from "../core/importer";
import { SOURCE_BADGE, SOURCE_NAME } from "../core/types";
import type { RefItem, RefTag } from "../core/types";
import { infoCandidates } from "../sources";
import { getCNKIURL } from "../sources/cnki";
import { resolveDOIByTitle } from "../sources";
import { PopupCard } from "./popup";
import type { PopupRect } from "./popup";

/**
 * Reference row rendering + hover popup driving, shared by the
 * References / Citations / Related sections.
 */

export interface RowContext {
  hostItem: Zotero.Item;
  /** container the rows live in (used for .active bookkeeping) */
  list: HTMLElement;
  /** show the reference number prefix */
  numbered?: boolean;
  /** allow long-press editing of the raw text */
  editable?: boolean;
  /** persist edited text (References section cache) */
  onEdited?: (ref: RefItem, index: number) => void;
  /** compact style (related list) */
  compact?: boolean;
}

let currentPopup: PopupCard | undefined;

/** per-list normalized-text -> row, for O(1) duplicate suppression */
const seenByList = new WeakMap<HTMLElement, Map<string, HTMLElement>>();
let pendingSeenKey: string | undefined;

export function getCurrentPopup(): PopupCard | undefined {
  return currentPopup;
}

export function closePopup() {
  currentPopup?.clear();
  currentPopup = undefined;
}

function toTimeInfo(t?: string | number): string | undefined {
  if (!t) return undefined;
  const d = new Date(String(t));
  if (isNaN(d.getTime())) return String(t);
  const info = d.toString().split(" ");
  return `${info[1]} ${info[3]}`;
}

/** local metadata candidate for the popup (index 0) */
async function localInfo(ref: RefItem, idText?: string): Promise<RefItem> {
  const item = ref.libItemID ? Zotero.Items.get(ref.libItemID) : undefined;
  if (item) {
    return {
      identifiers: ref.identifiers,
      authors: item
        .getCreators()
        .map((c: any) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
      tags: item.getTags().map((t: any) => {
        let colored: any;
        try {
          colored =
            typeof (item as any).getColoredTags === "function"
              ? (((item as any).getColoredTags() as any[]) || []).find(
                  (ct: any) => ct.tag === t.tag,
                )
              : undefined;
        } catch {
          colored = undefined;
        }
        return colored
          ? ({ text: t.tag, color: colored.color } as RefTag)
          : t.tag;
      }),
      abstract: item.getField("abstractNote") as string,
      title: item.getField("title") as string,
      year: item.getField("year") as string,
      primaryVenue: item.getField("publicationTitle") as string,
      type: "",
      source: ref.source,
      libItemID: item.id,
    };
  }
  const info: RefItem = {
    identifiers: ref.identifiers || {},
    authors: ref.authors || [],
    type: "",
    year: ref.year,
    title: ref.title || idText || "Reference",
    tags: ref.tags || [],
    text: ref.text,
    abstract: ref.abstract || ref.text,
    primaryVenue: ref.primaryVenue,
    description: ref.description,
    source: ref.source,
  };
  const url = identifiersToURL(info.identifiers);
  if (url) info.url = url;
  return info;
}

/**
 * Show the multi-source floating card for a reference.
 * Ported from zotero-reference Views.showTipUI.
 */
export function showRefPopup(
  ref: RefItem,
  rect: PopupRect,
  position: "left" | "top center",
  idText?: string,
  actions?: { onImport?: () => void },
): PopupCard {
  const popup = new PopupCard();
  popup.onInit(rect, position);
  currentPopup = popup;

  const { according, thunks } = infoCandidates(ref);
  const coroutines: Array<Promise<RefItem | null>> = [
    localInfo(ref, idText),
    ...thunks.map((t) => t()),
  ];
  const prefKey = `${according}InfoIndex` as "DOIInfoIndex";
  const prefIndex = Number(getPref(prefKey)) || 0;

  coroutines.forEach((promise, i) => {
    promise
      .then((info) => {
        if (!info || !popup.container.isConnected) return;
        const tagDefaultColor = "#59C1BD";
        const tags: RefTag[] = (info.tags || []).map((tag) =>
          typeof tag === "object"
            ? { color: tagDefaultColor, ...tag }
            : { color: tagDefaultColor, text: tag },
        );
        if (info.source) {
          tags.push({
            text: SOURCE_NAME[info.source] || info.source,
            color: SOURCE_BADGE[info.source]?.color || "#59C1BD",
            tip: SOURCE_BADGE[info.source]?.tip,
            source: info.source,
          });
        }
        const ids = info.identifiers || {};
        if (ids.DOI) {
          tags.push({
            text: "DOI",
            color: SOURCE_BADGE.DOI.color,
            tip: ids.DOI,
            url: info.url || `https://doi.org/${ids.DOI}`,
          });
        }
        if (ids.arXiv) {
          tags.push({
            text: "arXiv",
            color: SOURCE_BADGE.arXiv.color,
            tip: ids.arXiv,
            url: `https://arxiv.org/abs/${ids.arXiv}`,
          });
        }
        if (ids.PMID) {
          tags.push({
            text: "PMID",
            color: SOURCE_BADGE.pubmed.color,
            tip: ids.PMID,
            url: `https://pubmed.ncbi.nlm.nih.gov/${ids.PMID}/`,
          });
        }
        if (ids.CNKI) {
          tags.push({
            text: "URL",
            color: SOURCE_BADGE.CNKI.color,
            tip: ids.CNKI,
            url: ids.CNKI,
          });
        }
        if (info.oaUrl) {
          tags.push({
            text: "PDF",
            color: "#00b8a9",
            tip: "Open Access PDF",
            url: info.oaUrl,
          });
        }
        if (info.retracted) {
          // remember on the row's ref so the row badge and import warning
          // pick it up even when the list source didn't know
          ref.retracted = true;
          tags.unshift({
            text: getString("retracted-badge"),
            color: "#c8102e",
            tip: getString("retracted-tip"),
          });
        }
        if (ref.libItemID) {
          tags.push({
            text: "Zotero",
            color: SOURCE_BADGE.Zotero.color,
            tip: SOURCE_BADGE.Zotero.tip,
            itemID: ref.libItemID,
          });
        } else if (actions?.onImport) {
          // hosts without a row (+) button — the graph — get the import
          // action right on the card
          tags.push({
            text: getString("popup-import"),
            color: "#39bf68",
            tip: getString("row-import-tip"),
            onClick: () => {
              popup.clear();
              actions.onImport?.();
            },
          });
        }
        // academic search-engine links, always available (title-based)
        const searchTitle = htmlToText(info.title || ref.title || "").trim();
        if (searchTitle) {
          const q = encodeURIComponent(searchTitle);
          tags.push({
            text: "Scholar",
            color: "#4285f4",
            tip: "Search title on Google Scholar",
            url: `https://scholar.google.com/scholar?q=${q}`,
          });
          if (!ids.PMID && !isChinese(searchTitle)) {
            tags.push({
              text: "PubMed",
              color: SOURCE_BADGE.pubmed.color,
              tip: "Search title on PubMed",
              url: `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`,
            });
          }
        }
        // dot tooltip: which source this page came from
        const sourceName =
          i === 0
            ? ref.libItemID
              ? "Zotero"
              : getString("popup-source-local")
            : SOURCE_NAME[info.source || ""] || info.source || "";
        popup.addTip(
          htmlToText(info.title || ""),
          tags,
          [
            info.authors?.slice(0, 3).join(" / "),
            [info.primaryVenue, toTimeInfo(info.publishDate) || info.year]
              .filter(Boolean)
              .join(" · "),
            ref.description,
          ].filter((s): s is string => !!s && s !== ""),
          htmlToText(info.abstract || ""),
          according,
          i,
          prefIndex,
          sourceName,
        );
      })
      .catch((e) => ztoolkit.log("[rows] popup source failed", e));
  });
  return popup;
}

function setActionState(action: HTMLElement, state: "+" | "-" | "") {
  action.textContent = state;
  action.title =
    state === "+"
      ? getString("row-import-tip")
      : state === "-"
        ? getString("row-unlink-tip")
        : "";
  action.setAttribute("aria-label", action.title);
  action.style.opacity = state === "" ? "0.23" : "1";
  action.classList.toggle("is-plus", state === "+");
  action.classList.toggle("is-minus", state === "-");
}

/** ctrl+click: locate in library, else open in browser */
async function locateReference(ref: RefItem, libraryID: number) {
  const win = getWin();
  if (ref.libItemID) {
    win.Zotero_Tabs.select("zotero-pane");
    win.ZoteroPane.selectItem(ref.libItemID);
    return;
  }
  const local = await libraryIndex.match(ref, libraryID);
  if (local) {
    win.Zotero_Tabs.select("zotero-pane");
    win.ZoteroPane.selectItem(local.id);
    return;
  }
  let url = (isHttpUrl(ref.url) ? ref.url : undefined) || identifiersToURL(ref.identifiers);
  if (!url) {
    const popupWin = new ztoolkit.ProgressWindow("Searching URL", {
      closeTime: -1,
    })
      .createLine({
        text: `Title: ${collapseText(ref.title || ref.text || "")}`,
        type: "default",
      })
      .show();
    try {
      if (isChinese(ref.text || ref.title || "")) {
        url = (await getCNKIURL(ref.title || ref.text || "")) || undefined;
      } else if (ref.title) {
        const DOI = await resolveDOIByTitle(ref.title);
        if (DOI) url = `https://doi.org/${DOI}`;
      }
    } finally {
      popupWin.close();
    }
  }
  if (isHttpUrl(url)) {
    Zotero.launchURL(url);
  } else {
    new ztoolkit.ProgressWindow("References")
      .createLine({ text: "No URL found", type: "fail" })
      .show();
  }
}

function copyText(text: string, show = true) {
  new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
  if (show) {
    new ztoolkit.ProgressWindow(getString("panel-copied"), {
      closeOtherProgressWindows: true,
    })
      .createLine({ text: collapseText(text, 60), type: "success" })
      .show();
  }
}

/** import one reference and create the bidirectional relation */
async function addReference(
  ctx: RowContext,
  ref: RefItem,
  action: HTMLElement,
  row: HTMLElement,
  collections?: number[],
) {
  const popupWin = new ztoolkit.ProgressWindow("Importing Reference", {
    closeTime: -1,
    closeOtherProgressWindows: true,
  })
    .createLine({
      text: collapseText(ref.title || ref.text || ""),
      type: "default",
    })
    .show();
  setActionState(action, "");
  try {
    const refItem = await importReference(
      ctx.hostItem,
      ref,
      collections,
      (msg) => popupWin.changeLine({ text: collapseText(msg, 45) }),
    );
    if (!refItem) {
      popupWin.changeHeadline("[Fail] Import");
      popupWin.changeLine({ type: "fail" });
      popupWin.startCloseTimer(3000);
      setActionState(action, "+");
      return;
    }
    ref.libItemID = refItem.id;
    if (!isRelated(ctx.hostItem, refItem)) {
      await addRelation(ctx.hostItem, refItem);
    }
    popupWin.changeHeadline("[Done] Import");
    popupWin.changeLine({
      text: collapseText(refItem.getField("title") as string),
      type: "success",
    });
    popupWin.startCloseTimer(3000);
    setActionState(action, "-");
    row.style.opacity = "1";
  } catch (e) {
    ztoolkit.log("[rows] import failed", e);
    popupWin.changeHeadline("[Fail] Import");
    popupWin.changeLine({ type: "fail" });
    popupWin.startCloseTimer(3000);
    setActionState(action, "+");
  }
}

async function unlinkReference(
  ctx: RowContext,
  ref: RefItem,
  action: HTMLElement,
) {
  const popupWin = new ztoolkit.ProgressWindow("Removing Relation", {
    closeTime: -1,
    closeOtherProgressWindows: true,
  })
    .createLine({
      text: collapseText(ref.title || ref.text || ""),
      type: "default",
    })
    .show();
  setActionState(action, "");
  try {
    const refItem = ref.libItemID ? Zotero.Items.get(ref.libItemID) : null;
    if (refItem && isRelated(ctx.hostItem, refItem)) {
      await removeRelation(ctx.hostItem, refItem);
    }
    popupWin.changeHeadline("Removed");
    popupWin.changeLine({ type: "success" });
    popupWin.startCloseTimer(2000);
    setActionState(action, "+");
  } catch (e) {
    ztoolkit.log("[rows] unlink failed", e);
    popupWin.changeLine({ type: "fail" });
    popupWin.startCloseTimer(3000);
    setActionState(action, "-");
  }
}

/** ctrl+"+": pick a target collection through a native menu */
function pickCollectionAndAdd(
  ctx: RowContext,
  ref: RefItem,
  action: HTMLElement,
  row: HTMLElement,
) {
  const win = getWin();
  const doc = win.document;
  try {
    const menuPopup = doc.createXULElement("menupopup") as any;
    doc.documentElement!.append(menuPopup);
    const collections = Zotero.Collections.getByLibrary(ctx.hostItem.libraryID);
    for (const col of collections) {
      const menuItem = (Zotero.Utilities.Internal as any).createMenuForTarget(
        col,
        menuPopup,
        null,
        async (event: any, collection: any) => {
          if (event.target.tagName === "menuitem") {
            menuPopup.remove();
            event.stopPropagation();
            await addReference(ctx, ref, action, row, [collection.id]);
          }
        },
      );
      menuPopup.append(menuItem);
    }
    menuPopup.addEventListener("popuphidden", () => menuPopup.remove());
    const rect = row.getBoundingClientRect();
    menuPopup.openPopupAtScreen(
      win.screenX + rect.left,
      win.screenY + rect.top + rect.height,
      true,
    );
  } catch (e) {
    ztoolkit.log("[rows] collection menu failed, importing directly", e);
    void addReference(ctx, ref, action, row);
  }
}

/**
 * Render one reference row (icon + text + "+"/"−" action) with the full
 * behavior set of the original plugin.
 */
export function renderRefRow(
  ctx: RowContext,
  refs: RefItem[],
  refIndex: number,
): HTMLElement {
  const doc = ctx.list.ownerDocument!;
  let ref = refs[refIndex];
  const prefixed = ctx.numbered !== false;
  let refText = prefixed
    ? `[${ref.number || refIndex + 1}] ${ref.text || ref.title || ""}`
    : ref.text || ref.title || "";
  const idText =
    (ref.identifiers &&
      Object.keys(ref.identifiers).length > 0 &&
      `${Object.keys(ref.identifiers)[0]}: ${Object.values(ref.identifiers)[0]}`) ||
    "Reference";

  // skip rows whose normalized text is already rendered (the original
  // plugin suppressed duplicates the same way)
  const normalize = (t: string) => t.replace(/[^一-龥a-zA-Z0-9]/g, "");
  const dupOf = normalize(refText);
  if (dupOf) {
    // O(1) membership on a per-list set (reset whenever the list is
    // emptied) instead of re-normalizing every rendered label per row
    let seenSet = seenByList.get(ctx.list);
    if (!seenSet || !ctx.list.childElementCount) {
      seenSet = new Map();
      seenByList.set(ctx.list, seenSet);
    }
    const dup = seenSet.get(dupOf);
    if (dup?.isConnected) return dup;
    // registered below once the row exists
    pendingSeenKey = dupOf;
  }

  let opacity = Number(getPref("notInLibraryOpacity"));
  if (!(opacity > 0 && opacity <= 1)) opacity = 1;

  const row = doc.createElement("div");
  row.className = "references-row zotero-clicky";
  if (pendingSeenKey) {
    seenByList.get(ctx.list)?.set(pendingSeenKey, row);
    pendingSeenKey = undefined;
  }
  if (ctx.compact) row.classList.add("compact");
  row.style.opacity = String(opacity);

  const icon = doc.createElement("span");
  icon.className = "icon icon-css icon-item-type cell-icon";
  icon.setAttribute("data-item-type", ref.type || "journalArticle");
  row.append(icon);

  const label = doc.createElement("div");
  label.className = "references-row-label";
  label.textContent = refText;
  label.title = getString(ctx.editable ? "row-tip" : "row-tip-readonly");
  row.append(label);
  const markRetracted = () => {
    if (!ref.retracted || row.querySelector(".references-retracted")) return;
    const flag = doc.createElement("span");
    flag.className = "references-retracted";
    flag.textContent = getString("retracted-badge");
    flag.title = getString("retracted-tip");
    label.prepend(flag, " ");
  };
  markRetracted();

  const action = doc.createElement("span");
  action.className = "references-row-action zotero-clicky";
  setActionState(action, "+");
  row.append(action);

  // resolve in-library state asynchronously (index lookup is cheap)
  void (async () => {
    const item = await libraryIndex.match(ref, ctx.hostItem.libraryID);
    if (item && row.isConnected) {
      row.style.opacity = "1";
      icon.setAttribute("data-item-type", item.itemType);
      if (isRelated(ctx.hostItem, item)) setActionState(action, "-");
    }
  })().catch((e) => ztoolkit.log("[rows] match failed", e));

  // ---------- label interactions: copy / edit / locate ----------
  let editTimer: number | undefined;
  let editing = false;

  const enterEdit = () => {
    if (!ctx.editable || editing) return;
    editing = true;
    label.style.display = "none";
    const textarea = doc.createElement("textarea");
    textarea.className = "references-row-edit";
    textarea.rows = 4;
    textarea.value = prefixed ? refText.replace(/^\[\d+\]\s+/, "") : refText;
    row.insertBefore(textarea, label);
    textarea.focus();
    const exitEdit = (commit = true) => {
      if (!editing) return;
      editing = false;
      const inputText = textarea.value.trim();
      textarea.remove();
      label.style.display = "";
      if (!commit || !inputText || inputText === ref.text) return;
      label.textContent = `[${ref.number || refIndex + 1}] ${inputText}`;
      refs[refIndex] = {
        ...ref,
        ...refTextToInfo(inputText),
        identifiers: extractIdentifiers(inputText),
        text: inputText,
        libItemID: undefined,
      };
      // re-bind the closure so hover/locate/import use the edited data
      ref = refs[refIndex];
      refText = label.textContent || inputText;
      ctx.onEdited?.(ref, refIndex);
    };
    textarea.addEventListener("blur", () => exitEdit());
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      // Escape CANCELS the edit — blur would otherwise commit it
      if (e.key === "Escape") exitEdit(false);
    });
  };

  label.addEventListener("mousedown", () => {
    if (!ctx.editable) return;
    editTimer = setTimeout(() => {
      editTimer = undefined;
      enterEdit();
    }, 500);
  });

  row.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  row.addEventListener("mouseup", (event: MouseEvent) => {
    if ((event.target as HTMLElement) === action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      clearTimeout(editTimer);
      editTimer = undefined;
      void locateReference(ref, ctx.hostItem.libraryID);
      return;
    }
    if (editing) return;
    if (editTimer !== undefined || !ctx.editable) {
      clearTimeout(editTimer);
      editTimer = undefined;
      // copy the clean citation: no list numbering, whether ours ("[3] …")
      // or the PDF's own ("3. …" / "3) …" — never "10.1109/…", which has
      // no whitespace after the dot)
      const clean = (ref.text || ref.title || "").replace(
        /^\s*(?:\[\d+\]|\d{1,3}[.)])\s+/,
        "",
      );
      copyText((idText !== "Reference" ? idText + "\n" : "") + clean);
    }
  });

  // ---------- action (+ / −) ----------
  action.addEventListener("click", async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const state = action.textContent;
    if (state === "+") {
      if (
        ref.retracted &&
        !Services.prompt.confirm(
          getWin() as any,
          getString("retracted-badge"),
          getString("retracted-import-confirm"),
        )
      ) {
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        pickCollectionAndAdd(ctx, ref, action, row);
      } else {
        await addReference(ctx, ref, action, row);
      }
    } else if (state === "-") {
      await unlinkReference(ctx, ref, action);
    }
  });

  // ---------- hover popup ----------
  let hoverTimer: number | undefined;
  row.addEventListener("mouseenter", () => {
    if (!getPref("showPopup")) return;
    row.classList.add("active");
    const delay = getNumPref("popupDelay", 233);
    hoverTimer = setTimeout(() => {
      if (!row.isConnected) return;
      const rect = row.getBoundingClientRect();
      const position =
        Zotero.Prefs.get("extensions.zotero.layout", true) === "stacked"
          ? ("top center" as const)
          : ("left" as const);
      const popup = showRefPopup(
        ref,
        {
          x: rect.x - 5,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        position,
        idText,
      );
      if (!row.classList.contains("active")) {
        popup.container.style.display = "none";
      }
    }, delay);
  });
  row.addEventListener("mouseleave", () => {
    row.classList.remove("active");
    clearTimeout(hoverTimer);
    const popup = currentPopup;
    if (!popup) return;
    const timeout = popup.removeTipAfterMillisecond;
    popup.tipTimer = setTimeout(() => {
      // another section may have opened a newer popup meanwhile — only the
      // instance this timer belongs to may be cleared, and only when no
      // reference row anywhere is being hovered
      if (
        currentPopup === popup &&
        !doc.querySelector(".references-row.active")
      ) {
        popup.clear();
      }
    }, timeout);
  });

  ctx.list.append(row);
  return row;
}

/** AND-match keyword filter over rendered rows */
export function filterRows(list: HTMLElement, keyword: string) {
  const keywords = keyword
    .split(/[ ,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const rows = Array.from(
    list.querySelectorAll(".references-row"),
  ) as HTMLElement[];
  for (const row of rows) {
    if (!keywords.length) {
      row.style.display = "";
      continue;
    }
    const label = row.querySelector(".references-row-label");
    const content = label?.textContent?.toLowerCase() || "";
    row.style.display = keywords.every((k) => content.includes(k))
      ? ""
      : "none";
  }
}
