import type { TagElementProps } from "zotero-plugin-toolkit";
import type { RefTag } from "../core/types";
import { getPref, setPref } from "../utils/prefs";
import { clearTimeout, getDoc, getWin, setTimeout } from "../utils/window";

/**
 * Floating reference-detail card shown next to a hovered reference.
 * Ported from zotero-reference's TipUI (modules/tip.ts).
 *
 * One PopupCard shows one reference; each metadata source that answers
 * calls addTip() once, adding a switchable "page" plus a dot in the
 * option row at the top of the card.
 */

export interface PopupRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Option-dot row geometry / colors (ported constants). */
const OPTION = {
  size: 8,
  color: {
    active: "#FF597B",
    default: "#F9B5D0",
  },
};

/** Chip color used when a RefTag carries no color of its own. */
const TAG_DEFAULT_COLOR = "#59C1BD";

/** Relative luminance (0..1) of a #rgb / #rrggbb color; null if unparseable. */
function hexLuminance(hex: string): number | null {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export class PopupCard {
  container!: HTMLDivElement;
  removeTipAfterMillisecond: number;
  tipTimer?: number;

  private refRect!: PopupRect;
  private position: "left" | "top center" = "left";
  /** opacity fade in/out duration, ms */
  private fadeMs: number;
  /** timestamp of the last handled zoom event (wheel/DOMMouseScroll dedupe) */
  private lastZoomStamp = -1;

  constructor() {
    this.fadeMs = Number(getPref("popupFadeMs")) || 100;
    this.removeTipAfterMillisecond = Number(getPref("popupRemoveDelay")) || 500;
  }

  onInit(refRect: PopupRect, position: "left" | "top center") {
    this.refRect = refRect;
    this.position = position;
    // remove any card left over from an earlier hover first
    this.clear();
    this.buildContainer();
  }

  /** Fade out and remove every popup card in the document. */
  clear() {
    const doc = getDoc();
    doc
      .querySelectorAll(".references-popup-container")
      .forEach((e: Element) => {
        const el = e as HTMLElement;
        el.style.opacity = "0";
        setTimeout(() => {
          el.remove();
        }, this.fadeMs);
      });
  }

  /**
   * Background/text colors for the card. A non-empty user pref wins;
   * otherwise follow the window theme. Text color is chosen so the card
   * stays readable in both light and dark themes (custom backgrounds are
   * judged by their luminance).
   */
  private resolveColors(): { background: string; color: string } {
    const custom = (getPref("popupBackgroundColor") || "").trim();
    const dark =
      getWin().matchMedia("(prefers-color-scheme: dark)")?.matches ?? false;
    if (!custom) {
      return dark
        ? { background: "#2d2d2d", color: "#e0e0e0" }
        : { background: "#ffffff", color: "inherit" };
    }
    const lum = hexLuminance(custom);
    let color: string;
    if (lum === null) {
      color = dark ? "#e0e0e0" : "inherit";
    } else {
      color = lum < 0.5 ? "#e0e0e0" : "#1a1a1a";
    }
    return { background: custom, color };
  }

  /** the light-mode default title blue is unreadable on the dark card */
  private resolveTitleColor(): string {
    const pref = String(getPref("popupTitleColor") || "").trim();
    const dark =
      getWin().matchMedia("(prefers-color-scheme: dark)")?.matches ?? false;
    if (dark && (!pref || pref.toLowerCase() === "#2270d9")) return "#7fb0ff";
    return pref;
  }

  private buildContainer() {
    const doc = getDoc();
    const { background, color } = this.resolveColors();
    this.container = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["references-popup-container"],
      styles: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        position: "fixed",
        zIndex: "999",
        padding: "1em",
        backgroundColor: background,
        color,
        opacity: "0",
        transition: `opacity ${this.fadeMs / 1000}s linear`,
        userSelect: "text",
        boxShadow: "0 4px 24px rgb(0 0 0 / 20%)",
        borderRadius: "8px",
      },
      listeners: [
        { type: "wheel", listener: this.handleWheel },
        { type: "DOMMouseScroll", listener: this.handleLegacyScroll },
        {
          type: "mouseenter",
          listener: () => {
            clearTimeout(this.tipTimer);
          },
        },
        {
          type: "mouseleave",
          listener: () => {
            this.tipTimer = setTimeout(() => {
              this.container.remove();
            }, this.removeTipAfterMillisecond);
          },
        },
      ],
      children: [
        {
          tag: "div",
          id: "option-container",
          styles: {
            width: "100%",
            height: `${OPTION.size}px`,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: ".25em",
            marginTop: ".25em",
          },
        },
        {
          tag: "div",
          id: "content-container",
          styles: { width: "100%" },
        },
      ],
    });
    doc.documentElement!.appendChild(this.container);
  }

  /**
   * Add one source's view of the reference to the card.
   * @param title card title
   * @param tags clickable chips (source badge, DOI, Zotero, colored tags…)
   * @param descriptions secondary rows (authors, venue · year, …)
   * @param content body text, usually the abstract
   * @param according which identifier drove the lookup (DOI/arXiv/PMID/Title)
   * @param index position of this source in the candidate list
   * @param prefIndex the user's remembered preferred source index
   * @param sourceName display name of the source, shown as the dot's tooltip
   */
  addTip(
    title: string,
    tags: RefTag[],
    descriptions: string[],
    content: string,
    according: string,
    index: number,
    prefIndex?: number,
    sourceName?: string,
  ) {
    const doc = getDoc();
    const optionContainer = this.container.querySelector("#option-container")!;
    const isSelect =
      (prefIndex !== undefined && index === prefIndex) ||
      optionContainer.childNodes.length === 0;
    if (isSelect) this.reset();

    const children: TagElementProps[] = [
      {
        tag: "span",
        classList: ["title"],
        styles: {
          display: "block",
          fontWeight: "bold",
          marginBottom: ".25em",
          fontSize: "1.2em",
          color: this.resolveTitleColor(),
        },
        properties: { innerText: title },
        listeners: [{ type: "click", listener: this.translateNode }],
      },
    ];
    if (tags && tags.length > 0) {
      children.push({
        tag: "div",
        classList: ["tags"],
        styles: { width: "100%" },
        children: tags.map((tag) => this.tagChipProps(tag)),
      });
    }
    if (descriptions && descriptions.length > 0) {
      children.push({
        tag: "div",
        classList: ["descriptions"],
        styles: { marginBottom: "0.25em" },
        children: descriptions.map((text) => ({
          tag: "span",
          styles: {
            display: "block",
            lineHeight: "1.5em",
            opacity: "0.5",
            cursor: "pointer",
            userSelect: "none",
          },
          properties: { innerText: text },
          listeners: [{ type: "click", listener: () => this.copyText(text) }],
        })),
      });
    }
    children.push({
      tag: "span",
      classList: ["abstract"],
      properties: { innerText: content },
      styles: {
        display: "block",
        lineHeight: "1.5em",
        textAlign: "justify",
        opacity: "0.8",
        maxHeight: "300px",
        overflowY: "auto",
        marginTop: ".25em",
      },
      listeners: [{ type: "click", listener: this.translateNode }],
    });

    const contentNode = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["references-popup-tip"],
      styles: {
        padding: "0px",
        width: "100%",
        display: isSelect ? "" : "none",
      },
      children,
    });

    const optionNode = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      id: `option-${index}`,
      attributes: sourceName
        ? { title: sourceName, "aria-label": sourceName }
        : {},
      styles: {
        width: `${OPTION.size}px`,
        height: `${OPTION.size}px`,
        borderRadius: "50%",
        backgroundColor: isSelect ? OPTION.color.active : OPTION.color.default,
        marginLeft: `${OPTION.size * 0.5}px`,
        marginRight: `${OPTION.size * 0.5}px`,
        cursor: "pointer",
        transition: "background-color 0.23s linear",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            this.reset();
            optionNode.style.backgroundColor = OPTION.color.active;
            contentNode.style.display = "";
            // dynamic pref key like "DOIInfoIndex" / "TitleInfoIndex"
            setPref(`${according}InfoIndex` as any, index as any);
            this.place();
          },
        },
      ],
    });

    // keep the dots ordered by source index even when sources resolve
    // out of order (ported insert logic)
    const optionNodes = [
      ...optionContainer.querySelectorAll("[id^=option-]"),
    ] as HTMLElement[];
    if (optionNodes.length === 0) {
      optionContainer.appendChild(optionNode);
    } else {
      const getIndex = (node: HTMLElement) => Number(node.id.split("-")[1]);
      for (let i = 0; i < optionNodes.length; i++) {
        if (index > getIndex(optionNodes[i])) {
          if (i + 1 < optionNodes.length) {
            if (index < getIndex(optionNodes[i + 1])) {
              optionContainer.insertBefore(optionNode, optionNodes[i + 1]);
              break;
            }
          } else {
            optionContainer.appendChild(optionNode);
            break;
          }
        } else {
          optionContainer.insertBefore(optionNode, optionNodes[i]);
          break;
        }
      }
    }
    this.container
      .querySelector("#content-container")!
      .appendChild(contentNode);
    this.place();
  }

  /** Element props for one clickable tag chip. */
  private tagChipProps(tag: RefTag): TagElementProps {
    return {
      tag: "span",
      properties: { innerText: String(tag.text) },
      styles: {
        backgroundColor: tag.color || TAG_DEFAULT_COLOR,
        borderRadius: "10px",
        margin: "0.5em 1em 0.5em 0px",
        display: "inline-block",
        padding: "0 8px",
        color: "white",
        cursor: "pointer",
        userSelect: "none",
      },
      listeners: [
        {
          type: "click",
          listener: () => {
            if (tag.url) {
              new ztoolkit.ProgressWindow("Launching URL")
                .createLine({ text: tag.url, type: "default" })
                .show();
              Zotero.launchURL(tag.url);
            } else if (tag.itemID) {
              this.clear();
              Zotero.ProgressWindowSet.closeAll();
              const win = getWin();
              win.Zotero_Tabs.select("zotero-pane");
              win.ZoteroPane.selectItem(tag.itemID);
            } else {
              this.copyText(String(tag.text));
            }
          },
        },
        {
          type: "mouseenter",
          listener: () => {
            if (!tag.tip) return;
            Zotero.ProgressWindowSet.closeAll();
            new ztoolkit.ProgressWindow("Reference", { closeTime: -1 })
              .createLine({ text: tag.tip, type: "default" })
              .show();
          },
        },
        {
          type: "mouseleave",
          listener: () => {
            if (!tag.tip) return;
            Zotero.ProgressWindowSet.closeAll();
          },
        },
      ],
    };
  }

  /** Hide all content pages and de-highlight all dots. */
  private reset() {
    this.container
      .querySelector("#content-container")!
      .childNodes.forEach((e) => {
        (e as HTMLElement).style.display = "none";
      });
    this.container
      .querySelector("#option-container")!
      .childNodes.forEach((e) => {
        (e as HTMLElement).style.backgroundColor = OPTION.color.default;
      });
  }

  /**
   * Position the card next to the reference rect ("left" of it, or
   * "top center" above it), then clamp so it never leaves the window.
   */
  private place() {
    const doc = getDoc();
    const setStyles = (styles: Record<string, string>) => {
      for (const k of Object.keys(styles)) {
        (this.container.style as any)[k] = styles[k];
      }
      return this.container.getBoundingClientRect();
    };
    const winRect = doc.documentElement!.getBoundingClientRect();
    const maxWidth = winRect.width;
    const maxHeight = winRect.height;
    const refRect = this.refRect;

    let styles: Record<string, string> = {};
    if (this.position === "left") {
      styles = {
        right: `${maxWidth - refRect.x}px`,
        bottom: "",
        top: `${refRect.y}px`,
        width: `${refRect.x * 0.7}px`,
      };
    } else if (this.position === "top center") {
      const width = maxWidth * 0.7;
      styles = {
        width: `${width}px`,
        left: `${refRect.x + refRect.width / 2 - width / 2}px`,
        bottom: `${maxHeight - refRect.y}px`,
        top: "",
      };
      this.container.style.flexDirection = "column-reverse";
    }
    const rect = setStyles(styles);
    // overflow clamping (checked against the initially placed rect,
    // exactly as the original did)
    if (rect.bottom > maxHeight) {
      setStyles({ top: "", bottom: "0px" });
      this.container.style.flexDirection = "column-reverse";
    }
    if (rect.top < 0) {
      setStyles({ bottom: "", top: "0px" });
    }
    if (rect.left < 30) {
      setStyles({ right: "", left: "30px" });
    }
    if (maxWidth - rect.right < 30) {
      setStyles({ left: "", right: "30px" });
    }
    this.container.style.opacity = "1";
  }

  /* ------------------------------ zoom ------------------------------ */

  private handleWheel = (ev: Event) => {
    const e = ev as WheelEvent;
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!this.dedupeZoom(e)) return;
    this.zoom(e.deltaY);
  };

  /** Legacy Gecko scroll event; delta lives in `detail`. */
  private handleLegacyScroll = (ev: Event) => {
    const e = ev as any;
    if (!e.ctrlKey) return;
    e.preventDefault?.();
    if (!this.dedupeZoom(ev)) return;
    this.zoom(e.detail);
  };

  /**
   * Gecko can fire both "wheel" and legacy "DOMMouseScroll" for one
   * physical tick; both share a timestamp, so dedupe on it to keep
   * one tick = one zoom step.
   */
  private dedupeZoom(ev: Event): boolean {
    if (ev.timeStamp === this.lastZoomStamp) return false;
    this.lastZoomStamp = ev.timeStamp;
    return true;
  }

  /** Ctrl+wheel zoom, scale clamped to [1, 1.7] in 0.05 steps. */
  private zoom(delta: number) {
    const match = this.container.style.transform.match(/scale\((.+)\)/);
    let scale = match ? parseFloat(match[1]) : 1;
    const minScale = 1;
    const maxScale = 1.7;
    const step = 0.05;
    // a bottom-clamped card must grow upward, not off-screen
    if (this.container.style.bottom === "0px") {
      this.container.style.transformOrigin = "center bottom";
    } else {
      this.container.style.transformOrigin = "center center";
    }
    if (delta > 0) {
      scale -= step;
      this.container.style.transform = `scale(${
        scale < minScale ? minScale : scale
      })`;
    } else {
      scale += step;
      this.container.style.transform = `scale(${
        scale > maxScale ? maxScale : scale
      })`;
    }
  }

  /* --------------------------- translation --------------------------- */

  /**
   * Translate via the PDF Translate plugin if present: new API
   * (Zotero.PDFTranslate.api.translate) first, legacy ZoteroPDFTranslate
   * flow as fallback. Resolves undefined when unavailable or failed.
   */
  private async translate(text: string): Promise<string | undefined> {
    const Z = Zotero as any;
    try {
      if (Z.PDFTranslate?.api?.translate) {
        const res = await Z.PDFTranslate.api.translate(text);
        if (typeof res === "string") return res;
        return res?.result as string | undefined;
      }
      if (Z.ZoteroPDFTranslate) {
        Z.ZoteroPDFTranslate._sourceText = text;
        const ok = await Z.ZoteroPDFTranslate.translate.getTranslation();
        if (!ok) {
          Z.ZoteroPDFTranslate.view.showProgressWindow(
            "Translate Failed",
            ok,
            "fail",
          );
          return undefined;
        }
        return Z.ZoteroPDFTranslate._translatedText as string;
      }
    } catch (e) {
      ztoolkit.log("[popup] translate failed", e);
    }
    return undefined;
  }

  /**
   * ctrl (cmd on mac) + click toggles a node between its original and
   * translated text; both are cached in dataset attributes.
   */
  private translateNode = async (event: Event) => {
    const e = event as MouseEvent;
    const modified = Zotero.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey;
    if (!modified || !getPref("ctrlClickTranslate")) return;
    // currentTarget is nulled once dispatch ends — capture before awaiting
    const node = e.currentTarget as HTMLElement;
    if (!node) return;
    let sourceText = node.dataset.sourceText;
    let translatedText = node.dataset.translatedText;
    if (!sourceText) {
      sourceText = node.innerText;
      node.dataset.sourceText = sourceText;
    }
    if (!translatedText) {
      translatedText = await this.translate(sourceText);
      if (!translatedText) return;
      node.dataset.translatedText = translatedText;
    }
    if (node.innerText === sourceText) {
      node.innerText = translatedText;
    } else if (node.innerText === translatedText) {
      node.innerText = sourceText;
    }
  };

  /* ----------------------------- helpers ----------------------------- */

  private copyText(text: string) {
    new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
    new ztoolkit.ProgressWindow("Copy")
      .createLine({ text, type: "success" })
      .show();
  }
}
