import { setListMessage } from "./controls";
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
  hostIdentifiers,
} from "../core/text";
import { libraryIndex, isRelated } from "../core/libmatch";
import { addRelation, importReference, removeRelation } from "../core/importer";
import { itemStateKey } from "../core/storage";
import {
  CITED_CHIP_COLOR,
  REFCOUNT_CHIP_COLOR,
  SOURCE_BADGE,
  SOURCE_NAME,
} from "../core/types";
import {
  mergePopupMetadata,
  mergePopupSource,
  popupLinks,
  samePopupPaper,
  type PopupCandidate,
} from "../core/popupMetadata";
import type { RefItem, RefTag } from "../core/types";
import { infoCandidates } from "../sources";
import { cachedAbstract, fetchAbstract } from "../sources/abstract";
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

// Rows survive a hover card. Retain their already verified remote metadata so
// revisiting does not flash a raw citation or rebuild once for every cache hit.
// Weak keys let the whole snapshot go when its list is removed.
const popupMetadata = new WeakMap<
  RefItem,
  { signature: string; at: number; candidates: PopupCandidate[] }
>();

export function getCurrentPopup(): PopupCard | undefined {
  return currentPopup;
}

export function closePopup(owner?: Window) {
  if (owner && currentPopup?.container.ownerDocument?.defaultView !== owner)
    return;
  currentPopup?.clear();
  currentPopup = undefined;
}

function toTimeInfo(t?: string | number): string | undefined {
  if (!t) return undefined;
  const value = String(t).trim();
  // A year is not January of that year. Preserve partial/legacy dates rather
  // than inventing a month, or shifting a source's date across time zones.
  const match = value.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:T.*)?$/);
  if (!match) return value;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return value;
  try {
    return new Intl.DateTimeFormat((Zotero as any).locale || "en-US", {
      year: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(Number(match[1]), month - 1, 1)));
  } catch {
    return value;
  }
}

function popupSourceName(source?: string): string {
  return source === "pdf" || !source
    ? getString("popup-source-local")
    : SOURCE_NAME[source] || source;
}

/** Stored item IDs are hints, not evidence that a library record is this work. */
function localInfo(ref: RefItem): RefItem | undefined {
  if (!ref.libItemID) return undefined;
  try {
    const item = Zotero.Items.get(ref.libItemID);
    if (!item || item.deleted || !item.isRegularItem()) return undefined;
    const field = (key: string): string => {
      try {
        return String(item.getField(key as any) || "");
      } catch {
        return "";
      }
    };
    let identifiers = {};
    try {
      identifiers = hostIdentifiers(item);
    } catch {
      /* unloaded metadata */
    }
    const info: RefItem = {
      identifiers,
      authors: [],
      title: field("title"),
      year: field("year"),
      publishDate: field("date"),
      primaryVenue: field("publicationTitle"),
      abstract: field("abstractNote"),
      url: field("url"),
      source: "zotero",
      libItemID: item.id,
    };
    if (!samePopupPaper(ref, info)) return undefined;
    try {
      const authorType = Zotero.CreatorTypes.getID("author");
      info.authors = item
        .getCreators()
        .filter(
          (creator: any) =>
            creator.creatorType === "author" ||
            creator.creatorTypeID === authorType ||
            (!creator.creatorType && !creator.creatorTypeID),
        )
        .map((creator: any) =>
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
        );
    } catch {
      /* API metadata can fill unloaded creators */
    }
    try {
      const colored =
        typeof (item as any).getColoredTags === "function"
          ? (item as any).getColoredTags() || []
          : [];
      info.tags = item.getTags().map((tag: any) => {
        const color = colored.find(
          (entry: any) => entry.tag === tag.tag,
        )?.color;
        return { text: tag.tag, color };
      });
    } catch {
      /* tags are optional */
    }
    return info;
  } catch {
    return undefined;
  }
}

/** Show one continuously enriched card, with source provenance in its footer. */
export function showRefPopup(
  ref: RefItem,
  rect: PopupRect,
  position: "left" | "top center",
  idText?: string,
  actions?: { onImport?: () => void },
): PopupCard {
  closePopup();
  const popup = new PopupCard();
  popup.onInit(rect, position);
  currentPopup = popup;

  const candidates: PopupCandidate[] = [];
  const local = localInfo(ref);
  if (local) candidates.push({ info: local, kind: "library" });
  const { according, thunks } = infoCandidates(ref);
  const signature = JSON.stringify([
    ref.identifiers,
    ref.title,
    ref.text,
    ref.year,
  ]);
  const previous = popupMetadata.get(ref);
  const snapshot =
    previous?.signature === signature && Date.now() - previous.at < 600_000
      ? previous
      : { signature, at: Date.now(), candidates: [] as PopupCandidate[] };
  popupMetadata.set(ref, snapshot);
  candidates.push(...snapshot.candidates);
  const cached = cachedAbstract(ref);
  if (cached && !candidates.some((c) => c.info.source === cached.source))
    candidates.push({ info: cached, kind: "remote" });
  const translationScope = JSON.stringify([
    ref.identifiers.DOI?.toLowerCase() ||
      ref.identifiers.PMID ||
      ref.identifiers.arXiv ||
      ref.title ||
      ref.text,
    ref.year || "",
  ]);
  let renderTimer: number | undefined;
  const scheduleRender = () => {
    if (renderTimer !== undefined || currentPopup !== popup) return;
    // Coalesce independently arriving sources into one frame-sized update.
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 16);
  };
  const accept = (info: RefItem | null) => {
    if (!info || !samePopupPaper(ref, info, according === "Title")) return;
    const candidate: PopupCandidate = { info, kind: "remote" };
    const replace = (list: PopupCandidate[]) => {
      const index = list.findIndex(
        (c) => c.kind === "remote" && c.info.source === info.source,
      );
      if (index < 0) list.push(candidate);
      else {
        const old = list[index].info;
        // An abstract-only EFetch and a rich PubMed summary may finish in
        // either order. Preserve populated fields from the same verified work.
        if (samePopupPaper(old, info)) {
          list[index] = {
            kind: "remote",
            info: mergePopupSource(old, info),
          };
        } else list[index] = candidate;
      }
    };
    replace(candidates);
    replace(snapshot.candidates);
    scheduleRender();
  };
  const abstractRequests = new Set<string>();
  const render = () => {
    if (currentPopup !== popup || !popup.container.isConnected) return;
    const result = mergePopupMetadata(ref, candidates, according === "Title");
    const info = result.info;
    if (result.contentKind !== "abstract") {
      const key = JSON.stringify([
        info.identifiers.DOI,
        info.identifiers.PMID,
        info.title,
        info.year,
        info.authors[0],
      ]);
      if (!abstractRequests.has(key)) {
        abstractRequests.add(key);
        // Identifier-only fallback starts without waiting for slower providers.
        void fetchAbstract(info)
          .then(accept)
          .catch(() => {});
      }
    }
    const colors = {
      pdf: "#00b8a9",
      doi: SOURCE_BADGE.DOI.color,
      pubmed: SOURCE_BADGE.pubmed.color,
      scholar: "#4285f4",
      zotero: SOURCE_BADGE.Zotero.color,
    };
    const tags: RefTag[] = popupLinks(info).map((link) => ({
      text: getString(`popup-link-${link.kind}` as any),
      color: colors[link.kind],
      tip:
        link.kind === "pdf"
          ? getString("popup-fulltext-tip" as any)
          : link.kind === "scholar"
            ? getString("tag-scholar-tip")
            : link.url || getString("popup-link-zotero" as any),
      url: link.url,
      itemID: link.itemID,
    }));
    if (!info.libItemID && actions?.onImport) {
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
    // Metrics are explicitly labelled, use one source's value and are not
    // navigation controls. Their source stays visible in the tooltip.
    if (info.citationCount !== undefined)
      tags.push({
        text: getString("popup-cited-count" as any, {
          args: { count: info.citationCount },
        }),
        color: CITED_CHIP_COLOR,
        tip: getString("tag-cited-tip", {
          args: { source: popupSourceName(result.citationSource) },
        }),
      });
    if (info.referenceCount !== undefined)
      tags.push({
        text: getString("popup-reference-count" as any, {
          args: { count: info.referenceCount },
        }),
        color: REFCOUNT_CHIP_COLOR,
        tip: getString("tag-refcount-tip", {
          args: { source: popupSourceName(result.referenceSource) },
        }),
      });
    if (info.retracted) {
      // Import always goes through the shared retraction confirmation.
      ref.retracted = true;
      tags.push({
        text: getString("retracted-badge"),
        color: "#c8102e",
        tip: getString("retracted-tip"),
      });
    }
    tags.push(
      ...(info.tags || []).map((tag) =>
        typeof tag === "string" ? { text: tag } : tag,
      ),
    );
    popup.update(
      htmlToText(info.title || idText || getString("popup-untitled")),
      tags,
      result.content,
      {
        firstAuthors: result.firstAuthors,
        firstAuthorsByOrder: result.firstAuthorsByOrder,
        correspondingAuthors: result.correspondingAuthors,
        lastAuthors: result.lastAuthors,
        venue: [info.primaryVenue, toTimeInfo(info.publishDate) || info.year]
          .filter(Boolean)
          .join(" · "),
        note: info.description,
        translationScope,
        contentKind: result.contentKind,
        contentLabel: getString(
          result.contentKind === "abstract"
            ? "popup-abstract-label"
            : "popup-citation-label",
        ),
        abstractSource: result.abstractSource
          ? popupSourceName(result.abstractSource)
          : undefined,
        sources: result.sources.map((source) => ({
          name: popupSourceName(source.source),
          url: source.url,
        })),
      },
    );
  };
  render();
  for (const thunk of thunks) {
    Promise.resolve()
      .then(thunk)
      .then(accept)
      .catch((error) => ztoolkit.log("[rows] popup source failed", error));
  }
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
  // Revalidate the binding in the current library; an item may have been
  // edited/deleted since the row or its cache was first populated.
  const local = await libraryIndex.match(ref, libraryID);
  if (local) {
    win.Zotero_Tabs.select("zotero-pane");
    win.ZoteroPane.selectItem(local.id);
    return;
  }
  let url =
    (isHttpUrl(ref.url) ? ref.url : undefined) ||
    identifiersToURL(ref.identifiers);
  if (!url) {
    const popupWin = new ztoolkit.ProgressWindow(
      getString("progress-searching-url"),
      {
        closeTime: -1,
      },
    )
      .createLine({
        text: collapseText(ref.title || ref.text || ""),
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
    new ztoolkit.ProgressWindow(getString("progress-refs"))
      .createLine({ text: getString("progress-no-url"), type: "fail" })
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
  const identity = itemStateKey(ctx.hostItem);
  const current = () =>
    addon.data.alive &&
    !ctx.hostItem.deleted &&
    itemStateKey(ctx.hostItem) === identity;
  const popupWin = new ztoolkit.ProgressWindow(
    getString("progress-importing"),
    {
      closeTime: -1,
      closeOtherProgressWindows: true,
    },
  )
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
      (msg) => {
        if (current()) popupWin.changeLine({ text: collapseText(msg, 45) });
      },
    );
    if (!current()) {
      popupWin.close();
      return;
    }
    if (!refItem) {
      popupWin.changeHeadline(getString("progress-import-fail"));
      popupWin.changeLine({ type: "fail" });
      popupWin.startCloseTimer(3000);
      setActionState(action, "+");
      return;
    }
    if (!isRelated(ctx.hostItem, refItem)) {
      await addRelation(ctx.hostItem, refItem);
    }
    if (!current()) {
      popupWin.close();
      return;
    }
    ref.libItemID = refItem.id;
    popupWin.changeHeadline(getString("progress-import-done"));
    popupWin.changeLine({
      text: collapseText(refItem.getField("title") as string),
      type: "success",
    });
    popupWin.startCloseTimer(3000);
    setActionState(action, "-");
    row.style.setProperty("--refs-row-opacity", "1");
  } catch (e) {
    if (!current()) {
      popupWin.close();
      return;
    }
    ztoolkit.log("[rows] import failed", e);
    popupWin.changeHeadline(getString("progress-import-fail"));
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
  const popupWin = new ztoolkit.ProgressWindow(
    getString("progress-unlinking"),
    {
      closeTime: -1,
      closeOtherProgressWindows: true,
    },
  )
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
    popupWin.changeHeadline(getString("progress-unlinked"));
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
  const refText = prefixed
    ? `[${ref.number || refIndex + 1}] ${ref.text || ref.title || ""}`
    : ref.text || ref.title || "";
  const idText = () => {
    const entry = Object.entries(ref.identifiers || {}).find(
      ([, value]) => !!value,
    );
    return entry ? `${entry[0]}: ${entry[1]}` : undefined;
  };

  let opacity = Number(getPref("notInLibraryOpacity"));
  if (!(opacity > 0 && opacity <= 1)) opacity = 1;

  const row = doc.createElement("div");
  row.className = "references-row zotero-clicky";
  if (ctx.compact) row.classList.add("compact");
  row.style.setProperty("--refs-row-opacity", String(opacity));
  row.dataset.searchText = referenceSearchText(ref, refIndex);

  const icon = doc.createElement("span");
  icon.className = "icon icon-css icon-item-type cell-icon";
  icon.setAttribute("data-item-type", ref.type || "journalArticle");
  row.append(icon);

  const label = doc.createElement("div");
  label.className = "references-row-label";
  label.textContent = refText;
  label.tabIndex = 0;
  label.setAttribute("role", "button");
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
  // fused lists append online-only entries at the tail with an "API" tag;
  // ref.tags otherwise only reach the hover card, so flag the row here
  const apiTag = (ref.tags || []).find(
    (t) => typeof t === "object" && t.text === "API",
  );
  if (apiTag && typeof apiTag === "object") {
    const flag = doc.createElement("span");
    flag.className = "references-apitag";
    flag.textContent = "API";
    if (apiTag.tip) flag.title = apiTag.tip;
    label.prepend(flag, " ");
  }

  const action = doc.createElement("button");
  action.type = "button";
  action.className = "references-row-action zotero-clicky";
  setActionState(action, "+");
  row.append(action);

  // resolve in-library state asynchronously (index lookup is cheap)
  void (async () => {
    const originalRef = ref;
    const item = await libraryIndex.match(ref, ctx.hostItem.libraryID);
    if (item && row.isConnected && originalRef === ref) {
      row.style.setProperty("--refs-row-opacity", "1");
      icon.setAttribute("data-item-type", item.itemType);
      if (isRelated(ctx.hostItem, item)) setActionState(action, "-");
    }
  })().catch((e) => ztoolkit.log("[rows] match failed", e));

  // ---------- label interactions: copy / edit / locate ----------
  let editTimer: number | undefined;
  let editing = false;

  const enterEdit = () => {
    if (!ctx.editable || editing || !row.isConnected) return;
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
      // An edit describes a new citation. Retain only its printed position,
      // never the previous paper's remote metadata, links or relation state.
      const parsed = refTextToInfo(inputText);
      refs[refIndex] = {
        ...parsed,
        authors: parsed.authors || [],
        identifiers: extractIdentifiers(inputText),
        text: inputText,
        number: ref.number,
        page: ref.page,
        x: ref.x,
        y: ref.y,
      };
      ref = refs[refIndex];
      ctx.onEdited?.(ref, refIndex);
      const replacement = renderRefRow(ctx, refs, refIndex);
      row.replaceWith(replacement);
      replacement.querySelector<HTMLElement>(".references-row-label")?.focus();
      const input = ctx.list.parentElement?.querySelector<HTMLInputElement>(
        ".references-search input",
      );
      if (input) filterRows(ctx.list, input.value);
    };
    textarea.addEventListener("blur", () => exitEdit());
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      // Escape CANCELS the edit — blur would otherwise commit it
      if (e.key === "Escape") exitEdit(false);
    });
  };

  label.addEventListener("mousedown", (event: MouseEvent) => {
    if (!ctx.editable || event.button !== 0) return;
    editTimer = setTimeout(() => {
      editTimer = undefined;
      enterEdit();
    }, 500);
  });

  label.addEventListener("mouseleave", () => {
    clearTimeout(editTimer);
    editTimer = undefined;
  });
  label.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "F2" && ctx.editable) {
      event.preventDefault();
      enterEdit();
      return;
    }
    if (event.key === "Escape") {
      closePopup();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      void locateReference(ref, ctx.hostItem.libraryID);
      return;
    }
    const clean = (ref.text || ref.title || "").replace(
      /^\s*(?:\[\d+\]|\d{1,3}[.)])\s+/,
      "",
    );
    const ids = idText();
    copyText((ids ? ids + "\n" : "") + clean);
  });
  row.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  row.addEventListener("mouseup", (event: MouseEvent) => {
    if (
      event.button !== 0 ||
      editing ||
      (event.target as HTMLElement) === action
    )
      return;
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
      const ids = idText();
      copyText((ids ? ids + "\n" : "") + clean);
    }
  });

  // ---------- action (+ / −) ----------
  action.addEventListener("click", async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const state = action.textContent;
    if (state === "+") {
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
        idText(),
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
        !doc.querySelector(".references-row.active") &&
        !popup.container.contains(doc.activeElement)
      ) {
        popup.clear();
      }
    }, timeout);
  });

  setListMessage(ctx.list, "");
  ctx.list.append(row);
  return row;
}

/**
 * Shared AND-keyword predicate — the ONE definition of the filter
 * semantics, used by the rendered-row filter here and by section.ts's
 * import-all data filter (they must never drift apart).
 */
export function keywordPredicate(
  keyword: string,
): (content: string) => boolean {
  const keywords = keyword
    .split(/[ ,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (!keywords.length) return () => true;
  return (content) => {
    const c = content.toLowerCase();
    return keywords.every((k) => c.includes(k));
  };
}

/** Identical search data for row filtering and batch-import selection. */
export function referenceSearchText(ref: RefItem, index: number): string {
  return [
    ref.number || index + 1,
    ref.text,
    ref.title,
    ...(ref.authors || []),
    ref.year,
    ref.primaryVenue,
    ...Object.values(ref.identifiers || {}),
    ...(ref.tags || []).map((tag) =>
      typeof tag === "string" ? tag : tag.text,
    ),
    ref.retracted ? getString("retracted-badge") : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** AND-match keyword filter over rendered rows. */
export function filterRows(list: HTMLElement, keyword: string) {
  const match = keywordPredicate(keyword);
  const rows = Array.from(
    list.querySelectorAll(".references-row"),
  ) as HTMLElement[];
  let visible = 0;
  for (const row of rows) {
    const matches = match(row.dataset.searchText || "");
    row.hidden = !matches;
    if (matches) visible++;
  }
  const counter = list.parentElement?.querySelector<HTMLElement>(
    ".references-filter-count",
  );
  if (counter)
    counter.textContent = keyword ? `${visible} / ${rows.length}` : "";
  if (rows.length)
    setListMessage(list, visible ? "" : getString("panel-no-matches"));
}
