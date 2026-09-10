import { isHttpUrl } from "../core/text";
import { formatCitationText, isEnglishGBCitation } from "./citationText";
import { abstractParagraphs } from "../core/abstractText";
import {
  openTranslation,
  requestTranslation,
  translationAvailable,
  type TranslationEntry,
} from "../core/popupTranslation";
import type { TagElementProps } from "zotero-plugin-toolkit";
import type { RefTag } from "../core/types";
import { getNumPref, getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { clearTimeout, getDoc, getWin, setTimeout } from "../utils/window";

/**
 * Floating reference-detail card shown next to a hovered reference.
 * Ported from zotero-reference's TipUI (modules/tip.ts).
 *
 * One PopupCard shows a single merged reference. Incoming metadata updates
 * the same bounded reading area; sources remain traceable links, not pages.
 */

export interface PopupRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopupDetails {
  firstAuthors?: string[];
  firstAuthorsByOrder?: boolean;
  correspondingAuthors?: string[];
  lastAuthors?: string[];
  venue?: string;
  note?: string;
  /** Localized label: an abstract and a raw citation must remain distinct. */
  contentLabel?: string;
  contentKind?: "abstract" | "citation";
  translationScope?: string;
  abstractSource?: string;
  sources?: Array<{ name: string; url?: string }>;
}

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
  private ownerWindow?: Window;
  private translationScope = "";
  private translationEntries = new WeakMap<HTMLElement, TranslationEntry>();
  private onResize = () => {
    if (this.container?.isConnected) this.place();
  };

  constructor() {
    this.fadeMs = getNumPref("popupFadeMs", 100);
    this.removeTipAfterMillisecond = getNumPref("popupRemoveDelay", 500);
  }

  onInit(refRect: PopupRect, position: "left" | "top center") {
    this.refRect = refRect;
    this.position = position;
    // remove any card left over from an earlier hover first
    this.clear();
    this.buildContainer();
  }

  /** Dispose only this card; stale async work must not close a newer one. */
  clear() {
    clearTimeout(this.tipTimer);
    this.ownerWindow?.removeEventListener("resize", this.onResize);
    this.ownerWindow = undefined;
    this.container?.remove();
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
      return {
        background: "var(--material-background, Canvas)",
        color: "var(--fill-primary, CanvasText)",
      };
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
    this.ownerWindow = doc.defaultView || undefined;
    const { background, color } = this.resolveColors();
    this.container = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["references-popup-container"],
      styles: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-start",
        position: "fixed",
        zIndex: "999",
        backgroundColor: background,
        color,
        opacity: "0",
        transition: `opacity ${this.fadeMs / 1000}s linear`,
        userSelect: "text",
      },
      attributes: {
        role: "dialog",
        "aria-label": getString("popup-detail-label"),
      },
      listeners: [
        {
          type: "keydown",
          listener: (event: Event) => {
            if ((event as KeyboardEvent).key === "Escape") this.clear();
          },
        },
        { type: "focusin", listener: () => clearTimeout(this.tipTimer) },
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
            if (this.container.contains(doc.activeElement)) return;
            this.tipTimer = setTimeout(() => {
              this.clear();
            }, this.removeTipAfterMillisecond);
          },
        },
      ],
      children: [
        {
          tag: "div",
          id: "content-container",
          attributes: { tabindex: "0" },
        },
      ],
    });
    doc.documentElement!.appendChild(this.container);
    this.ownerWindow?.addEventListener("resize", this.onResize);
  }

  /** Update the unified card while preserving its reading position. */
  update(
    title: string,
    tags: RefTag[],
    content: string,
    details: PopupDetails,
  ) {
    if (!this.container?.isConnected) return;
    const doc = this.container.ownerDocument!;
    const readingArea = this.container.querySelector(
      "#content-container",
    ) as HTMLElement;
    const scrollTop = readingArea.scrollTop;
    const activeControl = this.container.contains(doc.activeElement)
      ? (doc.activeElement as HTMLElement)?.dataset.popupControl
      : undefined;
    this.translationScope = details.translationScope || title;

    const children: TagElementProps[] = [
      {
        tag: "span",
        classList: ["title"],
        styles: {
          color: this.resolveTitleColor(),
        },
        properties: { innerText: title },
        listeners: [{ type: "click", listener: this.translateNode }],
      },
    ];
    if (details) {
      const metadata: TagElementProps[] = [];
      const firstAuthors = details.firstAuthors?.filter(Boolean) || [];
      const correspondingAuthors =
        details.correspondingAuthors?.filter(Boolean) || [];
      const lastAuthors = details.lastAuthors?.filter(Boolean) || [];
      if (firstAuthors.length)
        metadata.push(
          this.detailProps(
            details.firstAuthorsByOrder
              ? getString("popup-first-listed-author-label")
              : firstAuthors.length > 1
                ? getString("popup-cofirst-authors-label")
                : getString("popup-first-authors-label"),
            this.authorNames(firstAuthors),
          ),
        );
      if (correspondingAuthors.length)
        metadata.push(
          this.detailProps(
            correspondingAuthors.length > 1
              ? getString("popup-cocorresponding-authors-label")
              : getString("popup-corresponding-authors-label"),
            this.authorNames(correspondingAuthors),
          ),
        );
      if (lastAuthors.length)
        metadata.push(
          this.detailProps(
            getString("popup-last-listed-author-label"),
            this.authorNames(lastAuthors),
          ),
        );
      if (details.venue)
        metadata.push(
          this.detailProps(getString("popup-publication-label"), details.venue),
        );
      if (details.note)
        metadata.push(
          this.detailProps(getString("popup-notes-label"), details.note),
        );
      if (metadata.length)
        children.push({
          tag: "div",
          classList: ["descriptions"],
          children: metadata,
        });
    }
    if (tags && tags.length > 0) {
      children.push({
        tag: "div",
        classList: ["tags"],
        children: tags.map((tag) => this.tagChipProps(tag)),
      });
    }
    if (content.trim()) {
      const actions: TagElementProps[] = [
        {
          tag: "button",
          classList: ["references-popup-text-action"],
          attributes: {
            type: "button",
            title: getString("popup-copy-tip"),
            "data-popup-control": "copy-content",
          },
          properties: { textContent: getString("popup-copy") },
          listeners: [
            {
              type: "click",
              listener: (event: Event) => {
                const button = event.currentTarget as HTMLButtonElement;
                const body = button
                  .closest(".references-popup-body")
                  ?.querySelector(".abstract") as HTMLElement | null;
                this.copyText(body ? this.readableText(body) : content);
              },
            },
          ],
        },
      ];
      if (getPref("ctrlClickTranslate") && translationAvailable()) {
        actions.push({
          tag: "button",
          classList: ["references-popup-text-action"],
          attributes: {
            type: "button",
            "aria-pressed": "false",
            "data-popup-control": "translate-content",
          },
          properties: { textContent: getString("popup-translate") },
          listeners: [
            {
              type: "click",
              listener: async (event: Event) => {
                const button = event.currentTarget as HTMLButtonElement;
                const node = button
                  .closest(".references-popup-body")!
                  .querySelector(".abstract") as HTMLElement;
                await this.toggleTranslation(node);
              },
            },
          ],
        });
      }
      children.push({
        tag: "section",
        classList: ["references-popup-body"],
        children: [
          {
            tag: "div",
            classList: ["references-popup-body-heading"],
            children: [
              {
                tag: "span",
                classList: ["references-popup-body-label"],
                children: [
                  {
                    tag: "span",
                    classList: ["references-popup-caption"],
                    properties: {
                      textContent:
                        details.contentLabel ||
                        getString("popup-abstract-label"),
                    },
                  },
                  ...(details.abstractSource
                    ? [
                        {
                          tag: "span",
                          classList: ["references-popup-inline-source"],
                          properties: { textContent: details.abstractSource },
                          attributes: {
                            title: getString("popup-abstract-source", {
                              args: { source: details.abstractSource },
                            }),
                          },
                        } satisfies TagElementProps,
                      ]
                    : []),
                ],
              },
              {
                tag: "div",
                classList: ["references-popup-body-actions"],
                children: actions,
              },
            ],
          },
          {
            tag: "div",
            classList: ["abstract"],
            attributes: {
              "data-content-kind": details.contentKind || "abstract",
            },
            listeners: [{ type: "click", listener: this.translateNode }],
          },
        ],
      });
    }

    if (details.sources?.length) {
      children.push({
        tag: "div",
        classList: ["references-popup-provenance"],
        children: [
          {
            tag: "span",
            classList: ["references-popup-caption"],
            properties: { textContent: getString("popup-sources-label") },
          },
          {
            tag: "div",
            classList: ["references-popup-provenance-links"],
            children: details.sources.map((source) => {
              const url =
                source.url && isHttpUrl(source.url) ? source.url : undefined;
              return {
                tag: url ? "button" : "span",
                classList: ["references-popup-source-link"],
                attributes: url
                  ? {
                      type: "button",
                      title: url,
                      "data-popup-control": `source-${source.name}`,
                    }
                  : {},
                properties: { textContent: source.name },
                listeners: url
                  ? [{ type: "click", listener: () => Zotero.launchURL(url) }]
                  : [],
              };
            }),
          },
        ],
      });
    }
    const contentNode = ztoolkit.UI.createElement(doc, "div", {
      namespace: "html",
      classList: ["references-popup-tip"],
      children,
    });
    const newBody = contentNode.querySelector(
      ".abstract",
    ) as HTMLElement | null;
    if (newBody) {
      newBody.dataset.sourceText = content;
      this.renderText(newBody, content);
    }
    const titleNode = contentNode.querySelector(".title") as HTMLElement | null;
    if (titleNode) {
      titleNode.dataset.sourceText = title;
      // Local parsing may retain the entire citation as its title. Format
      // that fallback too, while keeping real titles and translation keys.
      const comparable = (text: string) =>
        text.normalize("NFKC").replace(/\s+/g, "");
      if (
        details.contentKind === "citation" &&
        title.trim() &&
        (isEnglishGBCitation(content) || /\p{Script=Han}/u.test(content)) &&
        /\b(?:1[6-9]|20)\d{2}\b/.test(content) &&
        /\[(?:[JMCGNDRSPAZ]|DB|CP|EB)(?:\/(?:OL|CD|DK|MT))?\]/.test(
          comparable(content),
        ) &&
        comparable(title) === comparable(content)
      )
        titleNode.dataset.citationTitle = "true";
      this.renderText(titleNode, title);
    }
    readingArea.replaceChildren(contentNode);
    if (newBody) this.restoreTranslation(newBody);
    if (titleNode) this.restoreTranslation(titleNode);
    this.place();
    if (activeControl) {
      const control = [
        ...readingArea.querySelectorAll<HTMLElement>("[data-popup-control]"),
      ].find((element) => element.dataset.popupControl === activeControl);
      (control || readingArea).focus({ preventScroll: true });
    }
    readingArea.scrollTop = scrollTop;
  }

  private authorNames(names: string[]): string {
    return names.join(
      names.every((name) => /^[\p{Script=Han}·\s]+$/u.test(name)) ? "、" : "; ",
    );
  }

  /** A labelled, selectable metadata value; keyboard activation copies it. */
  private detailProps(
    label: string,
    text: string,
    copyText = text,
  ): TagElementProps {
    return {
      tag: "div",
      classList: ["references-popup-detail"],
      children: [
        ...(label
          ? [
              {
                tag: "span",
                classList: ["references-popup-caption"],
                properties: { textContent: label },
              } satisfies TagElementProps,
            ]
          : []),
        {
          tag: "div",
          classList: ["references-popup-detail-value"],
          attributes: {
            role: "button",
            tabindex: "0",
            title: getString("popup-copy-tip"),
            "data-popup-control": `metadata-${label}`,
          },
          properties: { textContent: text },
          listeners: [
            { type: "click", listener: () => this.copyText(copyText) },
            {
              type: "keydown",
              listener: (event: Event) => {
                const e = event as KeyboardEvent;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                this.copyText(copyText);
              },
            },
          ],
        },
      ],
    };
  }

  /** Element props for one clickable tag chip. */
  private tagChipProps(tag: RefTag): TagElementProps {
    const actionable = Boolean(
      tag.onClick || (tag.url && isHttpUrl(tag.url)) || tag.itemID,
    );
    return {
      tag: actionable ? "button" : "span",
      classList: [
        "references-popup-chip",
        actionable ? "is-action" : "is-info",
      ],
      properties: { innerText: String(tag.text) },
      attributes: {
        ...(actionable
          ? {
              type: "button",
              "data-popup-control": `tag-${tag.text}-${tag.url || ""}`,
            }
          : {}),
        ...(tag.tip ? { title: String(tag.tip) } : {}),
      },
      styles: {
        backgroundColor: `color-mix(in srgb, ${tag.color || TAG_DEFAULT_COLOR} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tag.color || TAG_DEFAULT_COLOR} 24%, transparent)`,
        borderRadius: "5px",
        margin: "0",
        display: "inline-flex",
        alignItems: "center",
        padding: "0 8px",
        color: "var(--fill-primary)",
        cursor: actionable ? "pointer" : "default",
        userSelect: actionable ? "none" : "text",
      },
      listeners: actionable
        ? [
            {
              type: "click",
              listener: () => {
                if (tag.onClick) {
                  tag.onClick();
                } else if (tag.url) {
                  // remote metadata may carry arbitrary schemes — http(s) only
                  if (isHttpUrl(tag.url)) Zotero.launchURL(tag.url);
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
          ]
        : [],
    };
  }

  /**
   * Position the card next to the reference rect ("left" of it, or
   * "top center" above it), then clamp so it never leaves the window.
   */
  private place() {
    const doc = this.container.ownerDocument!;
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

    const gap = 12;
    const width = Math.min(
      520,
      Math.max(
        240,
        this.position === "left" ? refRect.x - gap * 2 : maxWidth * 0.7,
      ),
      Math.max(0, maxWidth - gap * 2),
    );
    setStyles({
      width: `${width}px`,
      left: "0px",
      right: "",
      top: "0px",
      bottom: "",
      flexDirection: "column",
    });
    const rect = this.container.getBoundingClientRect();
    const left =
      this.position === "left"
        ? refRect.x - rect.width - gap
        : refRect.x + refRect.width / 2 - rect.width / 2;
    const top =
      this.position === "left" ? refRect.y : refRect.y - rect.height - gap;
    setStyles({
      left: `${Math.max(gap, Math.min(left, maxWidth - rect.width - gap))}px`,
      top: `${Math.max(gap, Math.min(top, maxHeight - rect.height - gap))}px`,
    });
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
    const old = Number(this.container.dataset.zoom) || 1;
    const scale = Math.max(1, Math.min(1.7, old + (delta > 0 ? -0.05 : 0.05)));
    this.container.dataset.zoom = String(scale);
    this.container.style.fontSize = `calc(var(--zotero-font-size, 13px) * ${scale})`;
    this.place();
  }

  /* --------------------------- translation --------------------------- */

  /** Render only text nodes; headings come from the source, never inference. */
  private renderText(node: HTMLElement, text: string) {
    node.dataset.displayText = text;
    if (node.dataset.contentKind !== "abstract") {
      node.textContent =
        node.dataset.contentKind === "citation" ||
        node.dataset.citationTitle === "true"
          ? formatCitationText(text)
          : text;
      return;
    }
    const doc = node.ownerDocument!;
    const paragraphs = abstractParagraphs(text, { plainText: true });
    node.replaceChildren(
      ...paragraphs.map(({ heading, text: body }) => {
        const p = doc.createElementNS("http://www.w3.org/1999/xhtml", "p");
        if (heading) {
          const label = doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "strong",
          );
          label.className = "references-abstract-heading";
          label.textContent = heading;
          p.append(label);
        }
        const span = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "span",
        );
        span.textContent = body;
        p.append(span);
        return p;
      }),
    );
  }

  /** Copy keeps section boundaries without depending on browser innerText. */
  private readableText(node: HTMLElement): string {
    const text = node.dataset.displayText ?? node.innerText;
    if (node.dataset.contentKind !== "abstract") return text;
    return abstractParagraphs(text, { plainText: true })
      .map(({ heading, text }) => (heading ? `${heading}:\n${text}` : text))
      .join("\n\n");
  }

  /** Modified click keeps the existing title/body translation shortcut. */
  private translateNode = async (event: Event) => {
    const e = event as MouseEvent;
    const modified = Zotero.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey;
    if (!modified || !getPref("ctrlClickTranslate")) return;
    // currentTarget is nulled once dispatch ends — capture before awaiting
    const node = e.currentTarget as HTMLElement;
    if (!node) return;
    await this.toggleTranslation(node);
  };

  private translationEntry(node: HTMLElement): TranslationEntry | undefined {
    const source = node.dataset.sourceText ?? node.innerText;
    node.dataset.sourceText = source;
    const kind = node.dataset.contentKind || "title";
    const text =
      kind === "abstract"
        ? abstractParagraphs(source, { plainText: true })
            .map(({ heading, text }) =>
              heading ? `${heading}:\n${text}` : text,
            )
            .join("\n\n")
        : source;
    return openTranslation(text, `${this.translationScope}\u0000${kind}`);
  }

  /** Restore only translations the user already requested, including in flight. */
  private restoreTranslation(node: HTMLElement) {
    if (!getPref("ctrlClickTranslate")) return;
    const entry = this.translationEntry(node);
    if (!entry) {
      this.translationEntries.delete(node);
      this.paintTranslation(node, { visible: false });
      return;
    }
    this.translationEntries.set(node, entry);
    this.paintTranslation(node, entry);
    if (entry.pending) void this.followTranslation(node, entry, entry.pending);
  }

  private paintTranslation(node: HTMLElement, entry: TranslationEntry) {
    const visible = entry.visible && !!entry.text;
    node.dataset.showTranslation = String(visible);
    if (entry.text) node.dataset.translatedText = entry.text;
    else delete node.dataset.translatedText;
    const text = visible ? entry.text! : node.dataset.sourceText || "";
    if (node.dataset.displayText !== text) this.renderText(node, text);
    node.dataset.translating = String(!!entry.pending);
    const button = node
      .closest(".references-popup-body")
      ?.querySelector<HTMLButtonElement>(
        '[data-popup-control="translate-content"]',
      );
    if (button) {
      button.disabled = !!entry.pending;
      button.setAttribute("aria-busy", String(!!entry.pending));
      button.setAttribute("aria-pressed", String(visible));
      button.textContent = getString(
        entry.pending
          ? "popup-translating"
          : visible
            ? "popup-original"
            : "popup-translate",
      );
    }
  }

  private async followTranslation(
    node: HTMLElement,
    entry: TranslationEntry,
    pending: Promise<string | undefined>,
  ) {
    await pending;
    // The old card can disappear, change abstract, or switch translation engine.
    // Its result remains cached; only an unchanged live consumer may paint it.
    if (!node.isConnected || this.translationEntries.get(node) !== entry)
      return;
    if (this.translationEntry(node) !== entry) {
      this.restoreTranslation(node);
      return;
    }
    this.paintTranslation(node, entry);
    if (this.container?.isConnected) this.place();
    if (!entry.text) {
      const button = node
        .closest(".references-popup-body")
        ?.querySelector('[data-popup-control="translate-content"]');
      button?.setAttribute("title", getString("popup-translate-failed"));
    }
  }

  private async toggleTranslation(node: HTMLElement) {
    const entry = this.translationEntry(node);
    if (!entry || entry.pending) return;
    this.translationEntries.set(node, entry);
    if (entry.text) {
      entry.visible = !entry.visible;
      this.paintTranslation(node, entry);
      if (this.container?.isConnected) this.place();
      return;
    }
    const pending = requestTranslation(entry);
    this.paintTranslation(node, entry);
    await this.followTranslation(node, entry, pending);
  }

  /* ----------------------------- helpers ----------------------------- */

  private copyText(text: string) {
    new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
    new ztoolkit.ProgressWindow(getString("panel-copied"))
      .createLine({
        text: text.length > 160 ? `${text.slice(0, 157)}…` : text,
        type: "success",
      })
      .show();
  }
}
