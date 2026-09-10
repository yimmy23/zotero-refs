import {
  refTextToInfo,
  isHttpUrl,
  extractIdentifiers,
  doiResolverTarget,
} from "../core/text";
import type { RefItem } from "../core/types";
import { mergeFlatAuthorYearReferences } from "./groupedReferences";
import {
  segmentGroupedStudyReferences,
  type GroupedStudyDecision,
  type GroupedStudyEntry,
} from "./groupedStudyReferences";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";

/**
 * PDF bibliography extraction engine.
 *
 * Faithful port of zotero-reference's modules/pdf.ts (MuiseDestiny, AGPL).
 * The heuristics here are hard-won against real PDFs — do not "simplify"
 * them without regression material:
 * - sub/superscript-tolerant line merging with mode-of-heights line height
 * - ordered refRegex list to classify reference-entry line starts
 * - indent-driven multi-line reference merging with de-hyphenation
 * - header/footer removal via same-text+same-position across pages
 * - column detection and part splitting, with 参考文献/References break
 *   detection and cross-page continuation
 *
 * Differences from the original: no UI (progress is reported through a
 * callback), errors resolve to [] instead of throwing, and the pdf.js
 * application is obtained defensively from the Zotero 7 reader.
 */

/* ------------------------------------------------------------------ */
/* local pdf.js shapes (not part of core/types)                        */
/* ------------------------------------------------------------------ */

/** one text chunk of pdf.js page.getTextContent() */
interface PDFItem {
  str: string;
  dir?: string;
  fontName?: string;
  height: number;
  width: number;
  /** [a, b, c, d, x, y] — x/y at indexes 4/5 */
  transform: number[];
  /** attached link-annotation URL (filled by updateItemsAnnotions) */
  url?: string;
}

/** Successful line-number probes retained only until consumed in this parse. */
type ProbeTextCache = Map<any, { items: PDFItem[] }>;

/** merged visual line */
interface PDFLine {
  x: number;
  y: number;
  text: string;
  height: number;
  width: number;
  url?: string;
  /** every raw item height merged into this line (for mode / overlap) */
  _height: number[];
  /** duplicate marker: the same line found on another page (header/footer) */
  same?: PDFLine;
  column?: number;
  pageNum?: number;
  /** original x before indent-offset normalization in donePart */
  _x?: number;
  /** column indent offset removed from x in donePart */
  _offset?: number;
  /** printed margin page number, reconstructed in geometric glyph order */
  _folio?: number;
}

interface PDFAnnotation {
  rect: number[];
  url?: string;
  unsafeUrl?: string;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ParseProgress {
  (message: string, pct: number): void;
}

/* ------------------------------------------------------------------ */
/* reference-entry classification                                      */
/* ------------------------------------------------------------------ */

/**
 * Ordered list of reference-entry start patterns. Order matters: getRefType
 * returns the index of the first matching group, and mergeSameRef only glues
 * lines whose type equals the first line's type.
 */
const refRegex: RegExp[][] = [
  [/^\(\d+\)\s?/], // (1)
  [/^\[\d{0,3}\].+?[,.，．]?/], // [10] Polygon
  [/^［\d{0,3}］.+?[,.，．]?/], // ［1］
  [/^\d+[,.，．]/], // 1. Polygon
  [/^\d+[^\d\w]+?[,.，．]?/], // 1) Polygon
  [/^\[.+?\].+?[,.，．]?/], // [RCK + 20]
  [/^\d+\s+/], // 1 Polygon
  [
    /^[A-Z]\w.+?\(\d+[a-z]?\)/,
    /^[A-Z][A-Za-z]+[,.，．]?/,
    /^.+?,.+.,/,
    /^[一-龥]{1,4}[,.，．]?/, // 中文
  ],
];

function abs(v: number): number {
  return v > 0 ? v : -v;
}

/**
 * If the text looks like the start of a reference entry, return the index of
 * the matching pattern group; otherwise -1. Tested both as-is and with all
 * whitespace stripped (OCR'd PDFs often break "[ 12 ]").
 */
function getRefType(text: string): number {
  const prefixNormalized = compactLeadingDigits(text.trim());
  for (let i = 0; i < refRegex.length; i++) {
    const flags = new Set(
      refRegex[i].map(
        (regex) =>
          regex.test(prefixNormalized) ||
          regex.test(prefixNormalized.replace(/\s+/g, "")),
      ),
    );
    if (flags.has(true)) {
      return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* line merging                                                        */
/* ------------------------------------------------------------------ */

/**
 * Merge text items sharing the same visual line into PDFLine objects.
 * Sub/superscripts (slightly shifted y, contained in the line's height band)
 * are merged into their base line; the finished line's height is the mode of
 * all merged item heights so a superscript doesn't distort it.
 */
function mergeSameLine(items: PDFItem[]): PDFLine[] {
  const toLine = (item: PDFItem): PDFLine => {
    const line: PDFLine = {
      x: parseFloat(item.transform[4].toFixed(1)),
      y: parseFloat(item.transform[5].toFixed(1)),
      text: item.str || "",
      height: item.height,
      width: item.width,
      url: item.url,
      _height: [item.height],
    };
    if (line.width < 0) {
      line.x += line.width;
      line.width = -line.width;
    }
    return line;
  };

  if (items.length === 0) {
    return [];
  }
  let j = 0;
  const lines: PDFLine[] = [toLine(items[j])];
  for (j = 1; j < items.length; j++) {
    const line = toLine(items[j]);
    const lastLine = lines[lines.length - 1];
    // Gutter-set entry numbers (BMJ and friends put the "1" in the margin
    // as its own text run, in a smaller font whose baseline sits a
    // fraction of a point above the entry's) fall just outside the
    // containment tests below, so the number stays a line of its own and
    // numbering-driven entry detection downstream sees none. Glue such a
    // number to the text that follows it on the same visual band. Kept
    // deliberately narrow — a general band-overlap rule also swallows the
    // page number into the running head, which breaks header/footer
    // removal (widths stop matching across pages).
    const gutterNumber =
      /^[[(]?\d{1,3}[.)\]]?$/.test(lastLine.text.trim()) &&
      // what follows must read as the entry proper (the character class
      // numAtStart accepts after a bare number), so a stray numeral in
      // scanned body text does not swallow the digits next to it
      /^[\p{L}[(\u201c"']/u.test(line.text.trim()) &&
      line.x >= lastLine.x + lastLine.width - 1 &&
      line.x - (lastLine.x + lastLine.width) < 5 * lastLine.height &&
      Math.min(line.y + line.height, lastLine.y + lastLine.height) -
        Math.max(line.y, lastLine.y) >
        Math.min(line.height, lastLine.height) * 0.5;
    // A shared baseline is not enough: row-major text streams place the
    // two columns next to each other. Keep a real gutter between them,
    // while preserving the narrow margin-number exception above.
    const horizontalGap = Math.max(
      line.x - (lastLine.x + lastLine.width),
      lastLine.x - (line.x + line.width),
    );
    const nearby =
      horizontalGap <= 3 * Math.max(line.height, lastLine.height, 6);
    const verticalOverlap =
      Math.min(line.y + line.height, lastLine.y + lastLine.height) -
      Math.max(line.y, lastLine.y);
    // same line, with sub/superscript tolerance
    if (
      (nearby &&
        (line.y == lastLine.y ||
          verticalOverlap >= 0.5 * Math.min(line.height, lastLine.height))) ||
      gutterNumber
    ) {
      lastLine.text += " " + line.text;
      const left = Math.min(lastLine.x, line.x);
      lastLine.width =
        Math.max(lastLine.x + lastLine.width, line.x + line.width) - left;
      lastLine.x = left;
      lastLine.url = lastLine.url || line.url;
      lastLine._height.push(line.height);
      if (gutterNumber) {
        // adopt the entry text's band (keeping the margin number's x) so
        // the rest of that visual line still merges normally
        lastLine.y = line.y;
        lastLine.height = line.height;
      }
    } else {
      // finish the previous line: height = mode of merged heights
      const hh = lastLine._height;
      const num: Record<string, number> = {};
      for (let i = 0; i < hh.length; i++) {
        num[String(hh[i])] ??= 0;
        num[String(hh[i])] += 1;
      }
      lastLine.height = Number(
        Object.keys(num).sort((h1, h2) => num[h2] - num[h1])[0],
      );
      lines.push(line);
    }
  }
  return restoreNumberedColumnOrder(lines);
}

/* ------------------------------------------------------------------ */
/* multi-line reference merging                                        */
/* ------------------------------------------------------------------ */

/**
 * Merge continuation lines into complete reference entries.
 *
 * The first line defines the reference type and the base x (firstX); the
 * first differently-indented nearby line defines the hanging indent. A line
 * starts a new reference when (a) it matches a numbered type (<= 2, very
 * reliable), (b) there is no indent and it sits at firstX with the same
 * type, or (c) there is an indent and another line exists at the matching
 * indented position. Everything else is appended to the current reference,
 * de-hyphenating "Poly-" + "gon" -> "Polygon" and carrying link URLs over.
 * Noise trailing the bibliography (past 90% of the lines, far off-indent)
 * is cut off.
 */
/**
 * Leading bibliography number of a line: "12. ", "12) ", "[12] ", "(12) ",
 * "12 Author". 0 when absent. Rejects "10.1016/…" (digit after the dot),
 * years ("2019 …", four digits) and page numbers glued to text.
 */
function numAtStart(text: string): number {
  // JAMA sets the number in bold as its own text run: "1 . Sung H" — allow
  // whitespace between the number and its punctuation; Chinese PDFs use
  // the full-width period ("33 ．Lin B")
  // Punctuated forms ("12." "12)" "[12]" "(12)") may be followed by any
  // non-digit; the bare form ("12 Author") must be followed by a letter or
  // an opening quote, otherwise wrapped volume/page fragments ("41 , 1103")
  // and table cells ("25 (12%)") pass as entry starts.
  // some PDFs emit every digit of the number as its own glyph run, which
  // mergeSameLine joins with spaces ("1 0 . Hosny A") — close them up
  const m = compactLeadingDigits(text.trim()).match(
    /^(?:[[(](\d{1,3})[\])](?:\s*[.．])?\s*(?=[^\d０-９\s.．])|(\d{1,3})\s*[.)．）]\s*(?=[^\d０-９\s.．])|(\d{1,3})\s+(?=[\p{L}“"']))/u,
  );
  return m ? Number(m[1] || m[2] || m[3]) : 0;
}

/**
 * Normalize only a punctuated bibliography-number prefix, including full-width
 * brackets/digits and separately drawn digit glyphs. The citation body retains
 * its original typography. Bare "1 7 insight.jci.org" remains unchanged: closing
 * that running footer once made it look like the next reference number 17.
 */
function compactLeadingDigits(t: string): string {
  const digits = (value: string) =>
    value
      .replace(/\s+/g, "")
      .replace(/[０-９]/g, (digit) =>
        String(digit.charCodeAt(0) - "０".charCodeAt(0)),
      );
  return t
    .replace(
      /^([[(［（])\s*([0-9０-９](?:\s*[0-9０-９]){0,2})\s*([\])］）])/,
      (prefix, open, value, close) => {
        const square = open === "[" || open === "［";
        if (square ? !/[\]］]/.test(close) : !/[)）]/.test(close))
          return prefix;
        return `${square ? "[" : "("}${digits(value)}${square ? "]" : ")"}`;
      },
    )
    .replace(/^([0-9０-９](?:\s*[0-9０-９]){0,2})(?=\s*[.)．）])/, (_, value) =>
      digits(value),
    );
}

/**
 * Restore two-column reading order only when the numbering independently
 * proves it. Some PDFs emit 1, 4, 2, 5, 3, 6 down both columns together.
 * Never sort an arbitrary page by x/y: that would pull captions into its
 * bibliography. Ambiguous bands, reset numbers and large block gaps keep
 * their original order.
 */
function restoreNumberedColumnOrder(lines: PDFLine[]): PDFLine[] {
  const starts = lines.filter((line) => numAtStart(line.text) > 0);
  if (starts.length < 4) return lines;
  const numbers = starts.map((line) => numAtStart(line.text));
  if (!numbers.some((n, i) => i > 0 && n < numbers[i - 1])) return lines;
  if (new Set(numbers).size !== numbers.length) return lines;
  const unit = Math.max(6, ...starts.map((line) => line.height));
  const bands: PDFLine[][] = [];
  for (const line of starts) {
    const band = bands.find((group) => Math.abs(group[0].x - line.x) <= unit);
    if (band) band.push(line);
    else bands.push([line]);
  }
  if (bands.length !== 2 || bands.some((band) => band.length < 2)) return lines;
  bands.sort((a, b) => a[0].x - b[0].x);
  const leftEdge = Math.max(...bands[0].map((line) => line.x + line.width));
  const rightEdge = Math.min(...bands[1].map((line) => line.x));
  if (rightEdge - leftEdge < 2 * unit) return lines;
  const ordered = bands.flat().map((line) => numAtStart(line.text));
  if (ordered.some((n, i) => i > 0 && n !== ordered[i - 1] + 1)) return lines;

  const boundary = (leftEdge + rightEdge) / 2;
  const first = lines.indexOf(starts[0]);
  const last = lines.indexOf(starts[starts.length - 1]);
  const grouped: PDFLine[][] = [[], []];
  let end = first;
  for (; end < lines.length; end++) {
    const line = lines[end];
    const band =
      line.x + line.width <= boundary ? 0 : line.x >= boundary ? 1 : -1;
    if (band < 0) break;
    const prev = grouped[band][grouped[band].length - 1];
    const top = bands[band][0];
    if (line.x < top.x - unit || line.y > top.y + unit) break;
    if (prev && (line.y > prev.y + unit || prev.y - line.y > 4.5 * unit)) break;
    grouped[band].push(line);
  }
  if (end <= last) return lines;
  return [
    ...lines.slice(0, first),
    ...grouped[0],
    ...grouped[1],
    ...lines.slice(end),
  ];
}

/**
 * Typical trailing matter that follows a bibliography: back-matter headings
 * (acknowledgements, contributions, disclosures…), licence / copyright
 * boilerplate, figure legends and tables. Anchored at the line start;
 * nothing in here may plausibly start a wrapped line INSIDE an entry
 * ("Published online…" or "Available from:" would, so they are absent).
 */
/**
 * Headings that introduce the blocks which follow a bibliography
 * (back matter, legends, tables, appendices). Anchored at the line start;
 * nothing in here may plausibly start a wrapped line INSIDE an entry
 * ("Published online…" or "Available from:" would, so they are absent).
 */
const TAIL_HEADING_SRC =
  "acknowledg|authors?'?\\s*(contributions?|disclosures?)|contributors|author information|additional information|competing (interests?|financial)|conflicts? of interest|disclosures?\\b|disclaimer|declarations? of|role of the funding|financial (support|disclosure)|grant support|sources? of (support|funding)|supplementary|supporting information|supplemental|funding|data availability|availability of data|data sharing|code availability|ethics (approval|statement|committee)|ethical (approval|statement)|informed consent|patient consent|consent for publication|trial registration|correspondence|abbreviations|key ?words|footnotes|affiliations|article (info|history)|online content|extended data|reporting summary|peer review|web resources|key resources|star\\W*methods|source data|figure legends?|figure \\d|fig\\. \\d|table \\d|e-table|e-figure|appendix|notes?:?$|[［[（(【]?(致谢|基金项目|作者贡献|利益冲突|作者简介|收稿日期|修回日期|责任编辑|通信作者|通讯作者|编辑[:：])";
/**
 * Licence / copyright / running-head boilerplate. Ends the list when it
 * sits directly below the entry; on a later page it is more likely the
 * running head above the entry's real continuation and is only dropped.
 */
const TAIL_BOILER_SRC =
  "open access|©|copyright|creative commons|cc by|licensee\\b|licen[cs]ed under|licen[cs]e:|publisher'?s note|springer nature remains|received:|accepted:|accepted article|cite this article|how to cite|citation:|reprints and permissions|the author\\(s\\)|this (article|work|journal)|for personal use only|no part of this|all rights reserved|downloaded from|author manuscript|ready to submit|biomedcentral|check for updates|crossmark|orcid|e-?mail:";
const TAIL_HEADING = new RegExp(`^(${TAIL_HEADING_SRC})`, "i");
const TAIL_BOILER = new RegExp(`^(${TAIL_BOILER_SRC})`, "i");
/** the same patterns without the inter-word spaces, for text with all
 * whitespace removed (Science and Wiley letter-space their headings:
 * "AC KNOWLED GME NTS", "S U P P O R T I N G I N F O R M A T I O N") */
const TAIL_HEADING_COMPACT = new RegExp(
  `^(${TAIL_HEADING_SRC.replace(/ /g, "")})`,
  "i",
);
const TAIL_BOILER_COMPACT = new RegExp(
  `^(${TAIL_BOILER_SRC.replace(/ /g, "")})`,
  "i",
);

type TailKind = "heading" | "boilerplate" | null;
function tailNoiseKind(text: string): TailKind {
  const t = text.trim().replace(/[‘’]/g, "'");
  const c = t.replace(/\s+/g, "");
  if (TAIL_HEADING.test(t) || TAIL_HEADING_COMPACT.test(c)) return "heading";
  if (TAIL_BOILER.test(t) || TAIL_BOILER_COMPACT.test(c)) return "boilerplate";
  return null;
}

/**
 * A reference line that ends the way complete entries end: page range,
 * volume:pages, a DOI / URL / PMID / e-locator, or a bracketed lookup link
 * ("[PubMed: …]"). Citation-type marks such as [J], [M] and [EB/OL] are
 * followed by publication metadata, so their bracket is not an ending.
 * Deliberately NOT a bare year or number — titles end in
 * those ("Cancer statistics, 2019", "RECIST 1.1", "COVID-19").
 */
const ENTRY_END =
  /(\d\s*[-–‒]\s*\d+(?:\.e\d+)?\.?|;\s*\d+(?:\s*\(\d+\))?\s*:\s*\d+\.?|\[\s*(?:PubMed\b|PMC\d*\b|Crossref\b|Web of Science\b|Google Scholar\b)[^\]]*\]\.?|\bdoi[:\s]*\S+|https?:\/\/\S+|\bPMID:?\s*\d+\.?|\bPMC\d+\.?|\be\d{4,}\.?|print\]\.?)\s*$/i;

/** A year or range alone also occurs in tables; require citation syntax. */
function hasCitationEvidence(text: string): boolean {
  return (
    /\b10\.\s?\d{4,9}\s?\/\S+/i.test(text) ||
    /\bPMID\s*:?\s*\d{6,9}\b/i.test(text) ||
    // Require a year immediately followed by bibliographic volume/pages.
    // Ratios ("allocation ratio 1:1") are common in dated clinical tables.
    /\b(?:19|20)\d{2}\s*[).,;]\s*\d{1,4}\s*(?:\(\d[^)]{0,20}\))?\s*:\s*(?:\d{1,7}[-–‒]\d+|\d{2,7}|e\d{3,})\b/i.test(
      text,
    )
  );
}

/** Place/publisher/year syntax, used only inside the guarded title look-ahead. */
function hasBookPublicationEvidence(text: string): boolean {
  return /(?:^|[.!?]\s+)[\p{L}][\p{L}\s,.'’()-]{1,60}:\s*[\p{L}][\p{L}\d\s&,'’().-]{1,90}[;,]\s*(?:1\d|20)\d{2}[a-z]?[.。]?\s*$/u.test(
    text,
  );
}

/** Preserve literal ranges/identifiers while repairing ordinary word wraps. */
function joinReferenceText(
  left: string,
  right: string,
  leftURL?: string,
  rightURL?: string,
): string {
  const a = left.trimEnd();
  const b = right.trim();
  if (!a) return b;
  if (!a.endsWith("-")) return `${a} ${b}`;
  const urlToken = a.match(/https?:\/\/\S*$/i)?.[0];
  const doiToken = a.match(/\b10\.\d{4,9}\/\S*[a-z]-$/)?.[0];
  if (
    doiToken &&
    /^[a-z]/.test(b) &&
    (!urlToken ||
      (!/[?#]/.test(urlToken) && doiResolverTarget(urlToken) !== undefined))
  ) {
    // A lower-case DOI word wrap is ambiguous. Retain the printed hyphen
    // only when a neighboring resolver annotation supports exactly that
    // candidate; unrelated or conflicting links cannot choose its identity.
    const joined = extractIdentifiers(
      doiToken.slice(0, -1) + b,
    ).DOI?.toLowerCase();
    const retained = extractIdentifiers(doiToken + b).DOI?.toLowerCase();
    const targets = [doiResolverTarget(leftURL), doiResolverTarget(rightURL)];
    const keep =
      retained !== undefined &&
      joined !== retained &&
      targets.includes(retained) &&
      !targets.includes(joined);
    return (keep ? a : a.slice(0, -1)) + b;
  }
  const literal =
    (/\d-$/.test(a) && /^\d/.test(b)) ||
    /(?:https?:\/\/|\b10\.\d{4,9}\/)\S*-$/.test(a);
  return (literal ? a : a.slice(0, -1)) + b;
}

const STANDALONE_TAIL_HEADING =
  /^(?:acknowledg(?:e?ments?)?|funding|author[s’']*\s+(?:contributions?|disclosures?)|contributors|disclosures?|conflicts? of interest|competing interests?|supplement(?:ary|al)(?:\s+(?:information|materials?|data|methods|references))?|correspondence|abbreviations|appendi(?:x|ces))\s*[:：.]?$/i;

/**
 * A line that starts like a new block rather than the wrapped tail of an
 * entry: a capital letter that is not one of the tokens references do put
 * at a line start after the citation proper.
 */
const CONTINUATION_START =
  /^(DOI|PMID|PMCID|URL|Available|Accessed|Epub|Retrieved|Published|Cited|Updated|Online|Erratum|Corrigendum|Comment|Reply|Discussion|In:|Vol\b|Suppl|Abstract|Chapter|Pages?\b|Et al|Eds?\b|Translated|Reprinted)/;
function startsNewBlock(text: string): boolean {
  const t = text.trim();
  return /^[A-Z]/.test(t) && !CONTINUATION_START.test(t);
}

/** index of the line that starts a numbered list at 1 (2 must follow soon) */
function findNumberedStart(lines: PDFLine[], within = 12): number {
  for (let i = 0; i < Math.min(lines.length, within); i++) {
    if (numAtStart(lines[i].text) !== 1) continue;
    const probe = lines
      .slice(i + 1, i + 40)
      .some((l) => numAtStart(l.text) === 2);
    if (probe) return i;
  }
  return -1;
}

/** absolute x of a line (donePart normalizes `x` per column, keeps `_x`) */
function absX(l: PDFLine): number {
  return l._x ?? l.x;
}

type Verdict = "accept" | "stray" | "end";

/** A separately drawn continuation remains in its justified text row. */
function sameBaselineTail(
  prev: PDFLine,
  line: PDFLine,
  columnRight: number,
): boolean {
  const h = Math.max(prev.height, line.height, 6);
  return (
    line.pageNum === prev.pageNum &&
    (!ENTRY_END.test(prev.text) ||
      /^(?:doi|pmid|pmcid|url|available|accessed|retrieved|epub|published|cited|updated|online)\s*:?$/i.test(
        line.text.trim(),
      ) ||
      /^(?:https?:\/\/\S+|10\.\d{4,9}\/\S+)/i.test(line.text.trim())) &&
    Math.abs(line.y - prev.y) <= 0.2 * h &&
    absX(line) >= absX(prev) + prev.width - 1 &&
    absX(line) - (absX(prev) + prev.width) < 8 * h &&
    absX(line) + line.width <= columnRight + h
  );
}

/**
 * May `line` continue the entry whose most recent accepted line is `prev`?
 *
 * The text stream of a page is NOT reading order: figures, axis labels,
 * captions, running heads and footers are frequently drawn AFTER the body
 * text, so the lines that follow an entry in the stream can sit anywhere on
 * the page (JAMA draws the whole figure after the references — 45 lines of
 * axis labels were glued to the last entry). Geometry decides:
 *  - a later page continues the entry (the cut-off tail of the last entry
 *    of page N is the top of page N+1);
 *  - below `prev` in the same column band (entry starts and wrapped lines
 *    differ by the hanging indent only) without a block-sized vertical gap
 *    continues it — double-spaced manuscripts put ~2.4 heights between
 *    wrapped lines, so 4.5 is generous;
 *  - above `prev` and clearly to its RIGHT is the top of the next column;
 *  - anything else is a stray line of another block: dropped, and the
 *    entry goes on with its next plausible line (a running footer drawn
 *    between the two halves of an entry must not cost the second half).
 *
 * The LAST entry has no following number to bound the damage, so it gets
 * stricter treatment: after a stray line no more column jumps; a column
 * jump must look like a column line (not an axis label, not a page-wide
 * caption); and once the entry reads as complete (ENTRY_END) a line that
 * starts like a new block ends it.
 */
function continuationVerdict(
  prev: PDFLine,
  line: PDFLine,
  ctx: {
    isLast: boolean;
    strayed: boolean;
    firstWidth: number;
    columnRight: number;
    row?: PDFLine;
  },
): Verdict {
  const pp = prev.pageNum ?? 0;
  const lp = line.pageNum ?? 0;
  const closes =
    ctx.isLast && ENTRY_END.test(prev.text) && startsNewBlock(line.text);
  if (lp !== pp) {
    if (lp < pp) return "stray";
    // Once the final citation is complete, the top of another page is
    // usually running matter. Its page number/lowercase text must not
    // bypass the capital-letter new-block guard. Explicit citation
    // addenda (DOI, PMID, availability/access dates) may still continue.
    if (
      ctx.isLast &&
      ENTRY_END.test(prev.text) &&
      !/^(?:doi[:\s]|PMID[:\s]|PMCID[:\s]|URL[:\s]|(?:Available|Accessed|Retrieved|Epub|Published|Updated|Cited)\b|https?:\/\/|10\.\d{4,9}\/)/i.test(
        line.text.trim(),
      )
    )
      return "end";
    return closes ? "end" : "accept";
  }
  // floor the unit so PDFs that report tiny text heights (some OCR text
  // layers say 1) do not reject every continuation line
  const h = Math.max(prev.height, line.height, 6);
  const px = absX(prev);
  const lx = absX(line);
  // Widely justified rows may draw their final word separately. A shared
  // baseline inside the already-established column is not a column jump.
  if (sameBaselineTail(prev, line, ctx.columnRight)) {
    return closes ? "end" : "accept";
  }
  // A rejected fragment of this composite row cannot become a column
  // jump: its gap, column bound and complete-citation guards still apply.
  if (ctx.row === prev && Math.abs(line.y - prev.y) <= 0.2 * h) return "stray";
  if (line.y < prev.y) {
    if (abs(lx - px) < 5 * h && prev.y - line.y < 4.5 * h) {
      return closes ? "end" : "accept";
    }
    return "stray";
  }
  if (lx > px + 4 * h) {
    // Moving upward within the known column is another block, not a jump
    // to a new column (for example, an appendix table label above the tail).
    if (lx < ctx.columnRight - h) return "stray";
    // a one- or two-letter run up there is a logo ("ll"), not a column
    const compact = line.text.replace(/\s+/g, "");
    const rangeTail =
      /\d[-–‒]\s*$/.test(prev.text) && /^\d+[.,;]?$/.test(compact);
    if (compact.length < 4 && !rangeTail) return "stray";
    if (!ctx.isLast) return "accept";
    if (ctx.strayed && !rangeTail) return "stray";
    const w = ctx.firstWidth;
    if (!rangeTail && w > 0 && (line.width < 0.5 * w || line.width > 1.3 * w)) {
      return "stray";
    }
    return "accept";
  }
  return "stray";
}

/** a real entry never needs this many wrapped lines — bound the last one */
const MAX_TAIL_LINES = 12;

/**
 * Numbered bibliographies (the vast majority of biomedical journals): a
 * line starts a new entry iff it begins with the NEXT number in sequence.
 * Monotonic numbering is far more robust than the indent geometry below,
 * which breaks across columns / pages / justified layouts.
 * Returns null when the input is not a numbered list starting at 1.
 */
function mergeNumberedRefs(input: PDFLine[]): PDFLine[] | null {
  if (!input.length) return null;
  const startIdx = findNumberedStart(input);
  if (startIdx < 0) return null;
  input = input.slice(startIdx);
  const nums = input.map((l) => numAtStart(l.text));
  // last index at which each number starts a line — tells whether more
  // entries can still follow the current one
  const lastIdx = new Map<number, number>();
  nums.forEach((n, i) => {
    if (n > 0) lastIdx.set(n, i);
  });
  const moreToCome = (i: number, expected: number) =>
    (lastIdx.get(expected) ?? -1) > i || (lastIdx.get(expected + 1) ?? -1) > i;

  const out: PDFLine[] = [];
  let cur: PDFLine | undefined;
  // the lines accepted into `cur`, in order; its text is rebuilt from them
  // when the entry closes, so a line can still be retracted
  let entryLines: PDFLine[] = [];
  // the line most recently merged into `cur` (geometry of the entry's tail)
  let last: PDFLine | undefined;
  // Composite row geometry advances its right edge without moving the
  // left-hand anchor needed by the next wrapped line. Raw lines stay intact.
  let row: { line: PDFLine; columnRight?: number } | undefined;
  // The last line known to sit in the entry's own column flow (the entry
  // start, or a line found directly below one). Lines accepted through the
  // page-change / column-jump rules are only PROVISIONAL: the first line
  // of a new page is as likely a running head or footer as the entry's
  // continuation. When a later line does not follow the provisional run
  // but does follow the anchor (same rules, and it is a real column line),
  // the run was the running head — retract it and take that line instead.
  let anchor: PDFLine | undefined;
  let provisional: PDFLine[] = [];
  let expected = 1;
  // after trailing matter (licence text, "Publisher's note"…) lines are
  // dropped until the numbering resumes — Nature-family papers number
  // their Methods references (69–83) after a block of front matter
  let skipping = false;
  let strayed = false;
  let tailLines = 0;
  let strayCount = 0;
  let endedAt = "";
  const joinLines = (lines: PDFLine[]) =>
    lines.reduce(
      (acc, l, i) => joinReferenceText(acc, l.text, lines[i - 1]?.url, l.url),
      "",
    );
  const closeEntry = () => {
    if (!cur) return;
    cur.text = joinLines(entryLines);
    for (const l of entryLines) if (l.url) cur.url = l.url;
  };
  const accept = (line: PDFLine, solid: boolean) => {
    entryLines.push(line);
    if (solid) {
      anchor = line;
      provisional = [];
    } else {
      provisional.push(line);
    }
    last = line;
    row = { line };
    tailLines++;
  };
  for (let i = 0; i < input.length; i++) {
    const line = input[i];
    const n = nums[i];
    const text = line.text;
    if (
      n === expected ||
      // one entry lost to OCR/layout: accept a single skip once the
      // current entry already has real content
      (n === expected + 1 &&
        cur &&
        joinLines(entryLines).length >= 40 &&
        (lastIdx.get(expected) ?? -1) < i)
    ) {
      closeEntry();
      cur = { ...line, text: text.trim() };
      entryLines = [line];
      last = line;
      row = { line };
      anchor = line;
      provisional = [];
      out.push(cur);
      expected = n + 1;
      skipping = false;
      strayed = false;
      tailLines = 0;
      continue;
    }
    if (!cur || !last || !anchor) continue; // leading noise before entry 1
    if (skipping) continue;
    const isLast = !moreToCome(i, expected);
    const bandWidth = 5 * Math.max(last.height, 6);
    let columnRight = absX(last) + last.width;
    for (const candidate of entryLines) {
      if (
        candidate.pageNum === last.pageNum &&
        Math.abs(absX(candidate) - absX(last)) < bandWidth
      ) {
        columnRight = Math.max(columnRight, absX(candidate) + candidate.width);
      }
    }
    const currentRow = row?.line ?? last;
    columnRight = row?.columnRight ?? columnRight;
    const ctx = {
      isLast,
      strayed,
      firstWidth: cur.width,
      columnRight,
      row: currentRow === last ? undefined : currentRow,
    };
    let verdict: Verdict = continuationVerdict(currentRow, line, ctx);
    if (verdict === "stray") {
      // does it follow the anchor instead, as a real column line?
      if (
        !isLast &&
        provisional.length &&
        line.width >= 0.5 * cur.width &&
        continuationVerdict(anchor, line, ctx) === "accept"
      ) {
        strayCount += provisional.length;
        const drop = new Set(provisional);
        entryLines = entryLines.filter((l) => !drop.has(l));
        provisional = [];
        accept(line, false);
        continue;
      }
      strayed = true;
      strayCount++;
      continue;
    }
    // Trailing matter is only trailing when it sits where the list would
    // continue (geometry above). A block heading ("Acknowledgments",
    // "Figure legends", "Supplementary Table 1") ends the list wherever it
    // is. Boilerplate ("Open Access This article is licensed…", "© 2024…",
    // "Accepted Article") ends it when it opens a block directly below the
    // entry on the same page (the licence paragraph), or below the LAST
    // entry, or on a later page once the entry reads as complete; a lone
    // boilerplate line — a footer or watermark the stream placed between
    // the two halves of an entry — is only dropped.
    let noise = out.length > 1 ? tailNoiseKind(text) : null;
    // Heading words also open real titles ("Supplementary oxygen…",
    // "Funding mechanisms…"). Preserve a wrapped title while its citation
    // is incomplete and the line remains in the same typographic flow.
    if (
      noise === "heading" &&
      !STANDALONE_TAIL_HEADING.test(text.trim()) &&
      !ENTRY_END.test(joinLines(entryLines)) &&
      line.pageNum === last.pageNum &&
      line.y < last.y &&
      last.y - line.y <= 3 * Math.max(last.height, line.height, 6) &&
      Math.abs(absX(line) - absX(last)) < 5 * Math.max(last.height, 6) &&
      line.height <= 1.25 * Math.max(last.height, 6)
    ) {
      const continuation: PDFLine[] = [];
      for (
        let j = i;
        j < input.length && continuation.length <= MAX_TAIL_LINES;
        j++
      ) {
        if (j > i && nums[j] > 0) break;
        if (
          j > i &&
          continuationVerdict(input[j - 1], input[j], ctx) !== "accept"
        )
          break;
        continuation.push(input[j]);
      }
      if (
        hasCitationEvidence(joinLines(continuation)) ||
        hasBookPublicationEvidence(joinLines(continuation))
      )
        noise = null;
    }
    if (noise) {
      const lp = line.pageNum ?? 0;
      const pp = last.pageNum ?? 0;
      const below = lp === pp && line.y < last.y;
      const next = input[i + 1];
      const blockFollows =
        !!next &&
        nums[i + 1] === 0 &&
        next.pageNum === line.pageNum &&
        next.y < line.y;
      if (
        noise === "heading" ||
        (below && (isLast || blockFollows)) ||
        (lp > pp && ENTRY_END.test(currentRow.text))
      ) {
        skipping = true;
        endedAt ||= `tail noise "${text.trim().slice(0, 40)}"`;
      } else {
        strayCount++;
      }
      continue;
    }
    if (verdict === "accept" && isLast && tailLines >= MAX_TAIL_LINES) {
      verdict = "end";
    }
    if (verdict === "end") {
      skipping = true;
      endedAt ||= `#${out.length} closed before "${text.trim().slice(0, 40)}"`;
      continue;
    }
    if (sameBaselineTail(currentRow, line, columnRight)) {
      // Advance only the accepted row edge/text, with its original column
      // bound fixed; keep last/anchor at the row's left for wrapped lines.
      row = {
        columnRight,
        line: {
          ...currentRow,
          text: joinReferenceText(
            currentRow.text,
            line.text,
            currentRow.url,
            line.url,
          ),
          width: absX(line) + line.width - absX(currentRow),
          url: line.url ?? currentRow.url,
        },
      };
      entryLines.push(line);
      if (provisional.length) provisional.push(line);
      tailLines++;
      continue;
    }
    // solid = directly below a line of the entry's own flow
    const solid =
      provisional.length === 0 &&
      line.pageNum === last.pageNum &&
      line.y < last.y;
    accept(line, solid);
  }
  closeEntry();
  if (strayCount || endedAt) {
    ztoolkit.log(
      `[pdfparser] numbered merge: ${strayCount} stray line(s) dropped${endedAt ? "; " + endedAt : ""}`,
    );
  }
  // A scrambled text stream (OCR'd scans) carries its numbered starts out
  // of order; the walk above then stalls after a couple of entries and
  // appends the whole rest of the block to them. Detect that stall — a
  // handful of entries against many numbered starts — and hand the block
  // back to the indent-based merge, which does not need the numbers to be
  // in sequence. Deliberately tight: a healthy bibliography whose block
  // also carries numeric noise (tables, page fragments) must not qualify.
  const numberedLines = input.filter((l) => numAtStart(l.text) > 0).length;
  if (out.length <= 5 && numberedLines >= out.length * 4) {
    ztoolkit.log(
      `[pdfparser] numbering out of sequence (${out.length} of ${numberedLines}) — indent merge`,
    );
    return null;
  }
  return out.length >= 3 ? out : null;
}

/** Index the existing indentation predicate; do not change layout decisions. */
function createIndentMatcher(lines: PDFLine[], indent: number) {
  const width = abs(indent);
  const xs = [
    ...new Set(lines.map((line) => line.x).filter(Number.isFinite)),
  ].sort((a, b) => a - b);
  const matches = (x: number, line: PDFLine) =>
    (line.x - x) * indent > 0 &&
    abs(line.x - x) >= width &&
    abs(abs(line.x - x) - width) < 2 * line.height;
  return (line: PDFLine): boolean => {
    // Keep unusual floating-point inputs on the original predicate, including
    // the possibility of multiplication underflow at subnormal indentation.
    if (
      !Number.isFinite(line.x) ||
      !Number.isFinite(line.height) ||
      !Number.isFinite(indent) ||
      width < 1e-6
    )
      return lines.some((other) => other !== line && matches(other.x, line));
    let low = 0,
      high = xs.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (indent < 0 ? xs[mid] - line.x < width : line.x - xs[mid] >= width)
        low = mid + 1;
      else high = mid;
    }
    const index = indent < 0 ? low : low - 1;
    return index >= 0 && index < xs.length && matches(xs[index], line);
  };
}

function mergeSameRef(input: PDFLine[]): PDFLine[] {
  if (!input.length) return [];
  const numbered = mergeNumberedRefs(input);
  if (numbered) {
    ztoolkit.log(`[pdfparser] numbered merge -> ${numbered.length}`);
    return numbered;
  }
  const flatAuthorYear = mergeFlatAuthorYearReferences(
    input,
    joinReferenceText,
  );
  if (flatAuthorYear) return flatAuthorYear;

  const _refLines = [...input];
  let refLines: (PDFLine | false)[] = input;
  const firstLine = input[0];
  // known indent of a fresh reference line
  const firstX = firstLine.x;
  const secondLine = input
    .slice(1)
    .find(
      (line) =>
        line.x != firstX && abs(line.x - firstX) < 10 * firstLine.height,
    );
  const indent = secondLine ? firstX - secondLine.x : 0;
  const hasIndentCompanion =
    indent !== 0 ? createIndentMatcher(_refLines, indent) : () => false;
  ztoolkit.log("[pdfparser] mergeSameRef indent", indent);
  const refType = getRefType(firstLine.text);
  // A year-first book/software citation and its following author-first entries
  // share a hanging margin, not a lexical start type. Do not let the first
  // entry's typography glue the entire unnumbered bibliography together.
  const unnumberedHanging = indent < 0 && numAtStart(firstLine.text) === 0;
  const groupKey = (line: PDFLine) =>
    `${line.pageNum ?? 0}/${line.column ?? 0}/${line._offset ?? 0}`;
  const groupIndents = new Map<string, number>();
  if (unnumberedHanging)
    for (const line of input)
      groupIndents.set(
        groupKey(line),
        Math.max(groupIndents.get(groupKey(line)) ?? 0, line.x - firstX),
      );
  const knownMargins: number[] = [];
  const continuationGroups = new Set<string>();
  let ref: PDFLine | undefined;
  let entryCount = 0;
  for (let i = 0; i < refLines.length; i++) {
    const line = refLines[i] as PDFLine;
    const text = line.text;
    const lineRefType = getRefType(text);
    const group = groupKey(line);
    // A new, larger section heading followed by its own numbered subsection
    // is structural evidence for an appendix, even without the word Appendix.
    const sectionLabel = text.match(/^([A-Z])\s+[A-Z\s]+$/)?.[1];
    const next = _refLines[i + 1];
    const appendedSection =
      !!ref &&
      !!sectionLabel &&
      (line.pageNum ?? 0) > (ref.pageNum ?? 0) &&
      line.height > 1.15 * ref.height &&
      (ENTRY_END.test(ref.text) ||
        /\d[-–‒]\d+[,;]?\s+(?:1\d|20)\d{2}\.?$/.test(ref.text)) &&
      !!next &&
      next.pageNum === line.pageNum &&
      next.y < line.y &&
      line.y - next.y < 4 * line.height &&
      Math.abs(absX(next) - absX(line)) < line.height &&
      next.text.startsWith(`${sectionLabel}.1 `);
    const biographyLines: PDFLine[] = [];
    if (
      unnumberedHanging &&
      ref &&
      ENTRY_END.test(ref.text.replace(/(\d)\s*([-–‒])\s*(?=\d)/g, "$1$2"))
    ) {
      for (const candidate of _refLines.slice(i, i + 6)) {
        if (
          candidate.pageNum !== line.pageNum ||
          candidate.column !== line.column ||
          Math.abs(absX(candidate) - absX(line)) >=
            Math.max(1, line.height * 0.2)
        )
          break;
        biographyLines.push(candidate);
      }
    }
    // Author profiles replace the bibliography's hanging indent with a prose
    // block. A title such as "Dr. ..." alone is not evidence of a biography.
    const authorBiography =
      biographyLines.length >= 3 &&
      !/\b(?:1\d|20)\d{2}\b/.test(text) &&
      !biographyLines.some((candidate) =>
        hasCitationEvidence(candidate.text),
      ) &&
      /\b(?:his|her|their)\s+research\s+(?:interests?|areas?|focuses)|\b(?:he|she)\s+(?:is|has|completed)\b/i.test(
        biographyLines.map((candidate) => candidate.text).join(" "),
      );
    const publisherNotice =
      !!ref &&
      tailNoiseKind(text) === "boilerplate" &&
      /^(?:publisher['’]?s\s*note|springer nature remains)/i.test(
        text.trim(),
      ) &&
      (ENTRY_END.test(ref.text.replace(/(\d)\s*([-–‒])\s*(?=\d)/g, "$1$2")) ||
        hasCitationEvidence(ref.text));
    // A final column may contain only wrapped author/title lines. Its local
    // minimum was normalized to zero by donePart; restore its continuation
    // role when it matches an already observed hanging margin and the preceding
    // citation is unfinished. A shifted column with its own hanging entries
    // has a nonzero indent range and must establish its own fresh margin.
    if (
      unnumberedHanging &&
      ref &&
      !ENTRY_END.test(ref.text) &&
      !hasCitationEvidence(line.text) &&
      !ENTRY_END.test(line.text) &&
      groupKey(ref) !== group &&
      (groupIndents.get(group) ?? 0) < Math.abs(indent) * 0.5 &&
      knownMargins.some(
        (margin) =>
          Math.abs(absX(line) - margin + indent) <=
          Math.max(1, line.height * 0.2),
      )
    )
      continuationGroups.add(group);
    // Unnumbered bibliographies need the same explicit end markers as
    // numbered ones. The old indent fallback classified "APPENDIX" and
    // its paragraphs as author names. Publication-history dates are a
    // separate, narrow pattern so "Received doses..." can remain a title.
    if (
      entryCount >= 2 &&
      (appendedSection ||
        authorBiography ||
        publisherNotice ||
        STANDALONE_TAIL_HEADING.test(text.trim()) ||
        /^received(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\d{4}|\d{1,2}[a-z]+\d{4})(?=[;,.]|revised|accepted|$)/i.test(
          text.replace(/\s+/g, ""),
        ))
    ) {
      refLines = refLines.slice(0, i);
      break;
    }
    if (
      !continuationGroups.has(group) &&
      // numbered types are reliable — skip other checks, carefully
      ((lineRefType == refType && refType >= 0 && refType <= 2) ||
        (indent == 0 &&
          lineRefType != -1 &&
          lineRefType == refType &&
          abs(firstX - line.x) < (abs(indent) || line.height) * 0.5) ||
        (indent != 0 &&
          (lineRefType == refType || unnumberedHanging) &&
          hasIndentCompanion(line)))
    ) {
      ref = line;
      entryCount++;
      if (unnumberedHanging && !knownMargins.includes(absX(line)))
        knownMargins.push(absX(line));
    } else if (ref) {
      // cut off tail noise that followed the bibliography into refLines,
      // usually the last few lines
      if (
        ref &&
        i / refLines.length > 0.9 &&
        abs(abs(ref.x - line.x) - abs(indent)) > 5 * line.height
      ) {
        refLines = refLines.slice(0, i);
        break;
      }
      // Poly-
      // gon
      // -> Polygon
      ref.text = joinReferenceText(ref.text, text, ref.url, line.url);
      if (line.url) {
        ref.url = line.url;
      }
      refLines[i] = false;
    }
  }
  return refLines.filter((e): e is PDFLine => !!e);
}

/* ------------------------------------------------------------------ */
/* link annotations                                                    */
/* ------------------------------------------------------------------ */

/** Require substantial glyph overlap: touching a neighboring row is not a link. */
function isIntersect(A: Box, B: Box): boolean {
  const width = Math.min(A.right - A.left, B.right - B.left);
  const height = Math.min(A.top - A.bottom, B.top - B.bottom);
  if (!(width > 0 && height > 0)) return false;
  const overlapX = Math.min(A.right, B.right) - Math.max(A.left, B.left);
  const overlapY = Math.min(A.top, B.top) - Math.max(A.bottom, B.bottom);
  return overlapX >= width * 0.5 && overlapY >= height * 0.5;
}

/** attach each link annotation's URL to every text item its rect touches */
function updateItemsAnnotions(items: PDFItem[], annotations: PDFAnnotation[]) {
  // annotations {rect: [left, bottom, right, top]}
  const toBox = (rect: number[]): Box => {
    const [left, bottom, right, top] = rect;
    return { left, bottom, right, top };
  };
  annotations.forEach((annotation) => {
    if (!annotation.rect) {
      return;
    }
    const annoBox = toBox(annotation.rect);
    items.forEach((item) => {
      const [x, y] = item.transform.slice(4);
      const itemBox = toBox([x, y, x + item.width, y + item.height]);
      if (isIntersect(annoBox, itemBox)) {
        // pdf.js `url` is scheme-whitelisted; `unsafeUrl` is the raw /URI
        // string of an untrusted PDF — never let file:/smb:/custom
        // schemes into a reference (they get persisted and launched)
        const raw = annotation.url || annotation.unsafeUrl;
        if (isHttpUrl(raw)) item.url = raw;
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* page reading                                                        */
/* ------------------------------------------------------------------ */

/**
 * Drop the line numbers of a manuscript page (submitted / accepted
 * manuscripts, pre-proofs, bioRxiv: "427 428 429…" down the left or right
 * margin). They are bare-integer text runs that share a column in the
 * margin, run consecutively down the page and sit beside (almost) every
 * text line; merged into the lines they corrupt both the entry numbers
 * ("456 1 0 . Hosny A") and the text ("…RGPM, 454 Granton P"). Entry
 * numbers set as their own run (BMJ, JAMA) also live in the margin and
 * also count up — but beside one line in three or four, not beside every
 * line, which is what the coverage test separates.
 */
function findLineNumbers(items: PDFItem[]): Set<PDFItem> {
  const drop = new Set<PDFItem>();
  const ints: PDFItem[] = [];
  const texts: PDFItem[] = [];
  for (const it of items) {
    const t = it.str.trim();
    if (/^\d{1,4}$/.test(t)) ints.push(it);
    else if (/\p{L}/u.test(t)) texts.push(it);
  }
  if (ints.length < 8 || texts.length < 8) return drop;
  const pct = (arr: number[], q: number) => {
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  };
  const x = (it: PDFItem) => it.transform[4];
  const y = (it: PDFItem) => it.transform[5];
  const wide = texts.filter((t) => t.width >= 30);
  if (wide.length < 4) return drop;
  const bodyLeft = pct(wide.map(x), 0.1);
  const bodyRight = pct(
    wide.map((t) => x(t) + t.width),
    0.9,
  );
  const bands = [...new Set(texts.map((t) => Math.round(y(t))))];
  // cluster the margin integers by x — the line-number column is the big one
  const margin = ints.filter(
    (it) => x(it) + it.width <= bodyLeft + 1.5 || x(it) >= bodyRight - 1.5,
  );
  // (left-aligned columns share x, right-aligned ones — "9" under "10" —
  // share the right edge)
  const clusters: PDFItem[][] = [];
  for (const it of margin) {
    const c = clusters.find(
      (k) =>
        Math.abs(x(it) - x(k[0])) <= 3 ||
        Math.abs(x(it) + it.width - (x(k[0]) + k[0].width)) <= 3,
    );
    if (c) c.push(it);
    else clusters.push([it]);
  }
  for (const c of clusters) {
    if (c.length < 8) continue;
    c.sort((a, b) => y(b) - y(a));
    const v = c.map((it) => Number(it.str.trim()));
    let consecutive = 0;
    for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] === 1) consecutive++;
    if (consecutive < 0.8 * (v.length - 1)) continue;
    const covered = bands.filter((b) =>
      c.some((it) => Math.abs(y(it) - b) <= Math.max(2, 0.5 * it.height)),
    ).length;
    if (covered < 0.6 * bands.length) continue;
    for (const it of c) drop.add(it);
  }
  return drop;
}

/**
 * Does this document carry manuscript line numbers? Decided on BODY pages
 * (the second page and the middle one), never on the bibliography itself:
 * a published review whose 189 one-line references carry bare numbers in
 * the margin looks exactly like a line-numbered page, but its body pages
 * do not. Manuscripts number every page.
 */
async function hasLineNumbers(
  pages: any[],
  probeText?: ProbeTextCache,
): Promise<boolean> {
  // a handful of body pages from the first third of the document: the
  // title page has none, a pre-proof cover sheet has no text, and pages
  // further in may already be the bibliography (a review's one-line
  // references with bare numbers in the margin would pass for line numbers)
  const n = pages.length;
  const probes = new Set<number>(
    [1, 2, 3, Math.floor(n / 4), Math.floor(n / 3)].filter(
      (i) => i > 0 && i < n,
    ),
  );
  for (const i of probes) {
    try {
      const tc = await pages[i].pdfPage.getTextContent();
      const found = findLineNumbers(tc.items).size > 0;
      // Only these at-most-five successful body-page probes enter the cache.
      probeText?.set(pages[i].pdfPage, tc);
      if (found) return true;
    } catch {
      // unreadable page — no evidence
    }
  }
  return false;
}

/** Restore only a proven numbered margin drawn after its citation text. */
function restoreGutterNumberItems(items: PDFItem[]): PDFItem[] {
  const number = (item: PDFItem) => {
    const m = compactLeadingDigits(item.str.trim()).match(
      /^(?:\[(\d{1,3})\]|(\d{1,3})[.)])$/,
    );
    return m ? Number(m[1] || m[2]) : 0;
  };
  const numbered = items
    .map((item, index) => ({ item, index, n: number(item) }))
    .filter(
      ({ item, n }) => n > 0 && item.width <= 4 * Math.max(item.height, 6),
    );
  if (numbered.length < 2) return items;
  const body = items
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item }) =>
        /^[\p{L}“"']/u.test(item.str.trim()) &&
        item.width >= 3 * Math.max(item.height, 6),
    );
  const groups: (typeof numbered)[] = [];
  for (const entry of numbered) {
    const group = groups.find(
      (g) => Math.abs(g[0].item.transform[4] - entry.item.transform[4]) < 2,
    );
    if (group) group.push(entry);
    else groups.push([entry]);
  }
  const before = new Map<number, PDFItem>();
  const moved = new Set<PDFItem>();
  for (const group of groups) {
    const bracketedPair =
      group.length === 2 &&
      group.every((entry) =>
        /^\[\d{1,3}\]$/.test(compactLeadingDigits(entry.item.str.trim())),
      );
    const minimum = bracketedPair ? 2 : 3;
    if (group.length < minimum) continue;
    group.sort((a, b) => b.item.transform[5] - a.item.transform[5]);
    if (
      group.filter((entry, i) => i > 0 && entry.n === group[i - 1].n + 1)
        .length < (bracketedPair ? 1 : Math.max(2, group.length - 2))
    )
      continue;
    const targets = group.map((entry) => {
      const n = entry.item,
        h = Math.max(n.height, 6);
      const target = body
        .filter(
          ({ item }) =>
            Math.abs(item.transform[5] - n.transform[5]) <
              0.35 * Math.max(item.height, h) &&
            item.transform[4] >= n.transform[4] + n.width - 1 &&
            item.transform[4] - (n.transform[4] + n.width) < 5 * h,
        )
        .sort((a, b) => a.item.transform[4] - b.item.transform[4])[0];
      return { entry, target };
    });
    if (
      targets.filter((x) => x.target).length <
      Math.max(minimum, 0.8 * group.length)
    )
      continue;
    const min = Math.min(
      ...targets.flatMap((x) =>
        x.target ? [x.target.index, x.entry.index] : [],
      ),
    );
    const max = Math.max(
      ...targets.flatMap((x) =>
        x.target ? [x.target.index, x.entry.index] : [],
      ),
    );
    if (
      items.slice(min, max + 1).filter((item) => hasCitationEvidence(item.str))
        .length < (bracketedPair ? 1 : 2)
    )
      continue;
    for (const { entry, target } of targets)
      if (target && entry.index > target.index && !before.has(target.index)) {
        before.set(target.index, entry.item);
        moved.add(entry.item);
      }
  }
  if (!moved.size) return items;
  return items.flatMap((item, index) =>
    moved.has(item)
      ? []
      : before.has(index)
        ? [before.get(index)!, item]
        : [item],
  );
}

/** read one pdf.js page into merged PDFLine objects */
async function readPdfPage(
  pdfPage: any,
  stripLineNumbers = false,
  probeText?: ProbeTextCache,
): Promise<PDFLine[]> {
  const probed = probeText?.get(pdfPage);
  // Consume before annotation/text processing, including its failure paths.
  probeText?.delete(pdfPage);
  const textContent = probed ?? (await pdfPage.getTextContent());
  let items: PDFItem[] = textContent.items.filter(
    (item: PDFItem) => item.str.trim().length,
  );
  if (items.length == 0) {
    return [];
  }
  // Very large diagonal watermarks are a different typographic layer.
  // Establish normal horizontal body type before excluding such a layer;
  // a rotated or vertical document must retain its actual text.
  const angleOf = (item: PDFItem) => {
    const degrees = Math.abs(
      (Math.atan2(item.transform[1], item.transform[0]) * 180) / Math.PI,
    );
    return Math.min(degrees, 180 - degrees);
  };
  const horizontalItems = items.filter(
    (item) => angleOf(item) < 5 && /\p{L}/u.test(item.str),
  );
  const horizontalHeights = horizontalItems
    .map((item) => item.height)
    .sort((a, b) => a - b);
  const bodyHeight =
    horizontalHeights[Math.floor(horizontalHeights.length / 2)];
  if (
    bodyHeight > 0 &&
    horizontalHeights.length >= 8 &&
    items.some((item) => {
      if (item.height <= 2.5 * bodyHeight) return false;
      const angle = angleOf(item);
      return angle > 15 && angle < 75;
    })
  ) {
    const horizontalBands = new Map<number, PDFItem[]>();
    for (const item of horizontalItems) {
      const y = Math.round(item.transform[5]);
      if (!horizontalBands.has(y)) horizontalBands.set(y, []);
      horizontalBands.get(y)!.push(item);
    }
    const pageView = pdfPage._pageInfo?.view;
    const pageWidth =
      pageView?.length >= 4 ? pageView[2] - pageView[0] : Infinity;
    const pageHeight =
      pageView?.length >= 4 ? pageView[3] - pageView[1] : Infinity;
    // PDF text runs may be individual words. Measure connected horizontal
    // rows, and require long rows inside the body rather than a few header
    // fragments above genuinely slanted main text. This also admits a short
    // final bibliography whose entire height is below 15% of the page.
    let wideBodyRows = 0;
    for (const [y, band] of horizontalBands) {
      const height = Math.max(...band.map((item) => item.height));
      if (
        !pageView ||
        y <= pageView[1] + 0.1 * pageHeight ||
        y + height >= pageView[3] - 0.1 * pageHeight
      )
        continue;
      const ordered = band
        .slice()
        .sort((a, b) => a.transform[4] - b.transform[4]);
      let left = Infinity,
        right = -Infinity,
        width = 0;
      for (const item of ordered) {
        const x = item.transform[4];
        if (x - right > 2 * height) left = x;
        right = Math.max(right, x + item.width);
        width = Math.max(width, right - left);
      }
      if (width >= 0.2 * pageWidth) wideBodyRows++;
    }
    if (
      horizontalHeights.length >= 8 &&
      horizontalBands.size >= 4 &&
      wideBodyRows >= 2
    ) {
      items = items.filter((item) => {
        const angle = angleOf(item);
        return !(
          bodyHeight > 0 &&
          angle > 15 &&
          angle < 75 &&
          item.height > 2.5 * bodyHeight
        );
      });
    }
  }
  if (stripLineNumbers) {
    const drop = findLineNumbers(items);
    if (drop.size) {
      ztoolkit.log(
        `[pdfparser] page: ${drop.size} margin line numbers dropped`,
      );
      items = items.filter((it) => !drop.has(it));
    }
  }
  const annotations: PDFAnnotation[] = await pdfPage.getAnnotations();
  updateItemsAnnotions(items, annotations);
  const lines = mergeSameLine(restoreGutterNumberItems(items));
  const view = pdfPage._pageInfo?.view;
  if (view?.length >= 4) {
    const pageHeight = view[3] - view[1];
    for (const line of lines) {
      if (
        !/^\d{1,5}$/.test(line.text.replace(/\s+/g, "")) ||
        (line.y > view[1] + pageHeight * 0.12 &&
          line.y < view[3] - pageHeight * 0.12)
      )
        continue;
      // Some journals draw right-aligned page digits in reverse stream
      // order. Only the margin folio uses geometric order; reference text
      // and the general line-merging rules remain untouched.
      const digits = items
        .filter(
          (item) =>
            /^\d+$/.test(item.str.trim()) &&
            Math.abs(item.transform[5] - line.y) <=
              Math.max(1, line.height * 0.2) &&
            item.transform[4] >= line.x - 1 &&
            item.transform[4] + item.width <= line.x + line.width + 1,
        )
        .sort((a, b) => a.transform[4] - b.transform[4]);
      const value = digits.map((item) => item.str.trim()).join("");
      if (/^\d{1,5}$/.test(value)) line._folio = Number(value);
    }
  }
  return lines;
}

/**
 * Get the pdf.js PDFViewerApplication from a Zotero 7 reader, polling for
 * up to ~5s while the internal view boots. Resolves null when unavailable.
 */
async function getViewerApp(
  reader: any,
  captureManualPage: boolean,
): Promise<{ app: any; manualPage?: unknown } | null> {
  for (let i = 0; i < 25; i++) {
    try {
      const internal = (reader as any)?._internalReader;
      const view =
        internal?._primaryView ?? internal?._lastView ?? internal?._views?.[0];
      const app = view?._iframeWindow?.PDFViewerApplication;
      if (app?.pdfLoadingTask && app?.pdfViewer) {
        if (!captureManualPage) return { app };
        try {
          return { app, manualPage: app.page };
        } catch {
          return { app, manualPage: undefined };
        }
      }
    } catch {
      // reader still initializing
    }
    await Zotero.Promise.delay(200);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* bibliography line extraction                                        */
/* ------------------------------------------------------------------ */

interface ContinuationMarker {
  direction: "forward" | "back";
  folio: number;
  line: PDFLine;
}

function continuationMarkers(lines: PDFLine[]): ContinuationMarker[] {
  return lines.flatMap((line) => {
    const match = line.text
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .match(/^[([]?(下转|下接|上接)第?(\d{1,5})页[)\]]?[。.]?$/);
    if (!match) return [];
    return [
      {
        direction: match[1] === "上接" ? "back" : "forward",
        folio: Number(match[2]),
        line,
      },
    ];
  });
}

function continuationEvidence(text: string): boolean {
  return hasCitationEvidence(
    text
      .normalize("NFKC")
      .replace(/\(\s+(?=\d)/g, "(")
      .replace(/(?<=\d)\s+\)/g, ")")
      .replace(/(?<=\d)\s*([-–‒])\s*(?=\d)/g, "$1"),
  );
}

function pageFolios(lines: PDFLine[]): number[] {
  return [
    ...new Set(lines.flatMap((line) => (line._folio ? [line._folio] : []))),
  ];
}

/** A standalone continuation notice must actually border numbered references. */
function bibliographyMarker(marker: ContinuationMarker, lines: PDFLine[]) {
  const h = Math.max(6, marker.line.height);
  const nearby = lines.filter((line) =>
    marker.direction === "forward"
      ? line.y > marker.line.y && line.y - marker.line.y < 8 * h
      : line.y <= marker.line.y + h / 2 && marker.line.y - line.y < 8 * h,
  );
  const center = marker.line.x + marker.line.width / 2;
  return nearby.some(
    (start) =>
      numAtStart(compactLeadingDigits(start.text)) > 0 &&
      center >= start.x - h &&
      center <= start.x + Math.max(start.width, 4 * h) + h &&
      continuationEvidence(
        nearby
          .filter((line) => line.x >= start.x - h && line.x < start.x + 4 * h)
          .map((line) => line.text)
          .join(" "),
      ),
  );
}

/**
 * Crop an explicitly marked bibliography block before combining pages. The
 * marker bounds the vertical region; numbering proves physical column order.
 * A small top tolerance retains a wrapped tail on the first right-column line.
 */
function continuationSegment(
  lines: PDFLine[],
  pageNum: number,
  top: PDFLine,
  bottom: PDFLine | null,
  first: number,
): PDFLine[] | null {
  const h = Math.max(6, top.height);
  const band = lines.filter(
    (line) =>
      line !== top &&
      line !== bottom &&
      line._folio === undefined &&
      line.y <= top.y + h / 2 &&
      (!bottom || line.y > bottom.y + h / 2) &&
      !continuationMarkers([line]).length,
  );
  const starts = band.filter(
    (line) =>
      numAtStart(compactLeadingDigits(line.text)) === first &&
      top.y - line.y < 6 * h &&
      top.x + top.width / 2 >= line.x - h &&
      top.x + top.width / 2 <= line.x + Math.max(line.width, 4 * h) + h,
  );
  if (starts.length !== 1) return null;
  const left = starts[0].x;
  const relevant = band.filter((line) => line.x >= left - h);
  const numbered = relevant.filter(
    (line) => numAtStart(compactLeadingDigits(line.text)) > 0,
  );
  const columns: number[] = [];
  for (const line of [...numbered].sort((a, b) => a.x - b.x))
    if (!columns.some((x) => Math.abs(x - line.x) < 2 * h))
      columns.push(line.x);
  if (!columns.length || columns.length > 3) return null;
  const ordered = relevant
    .map((line) => ({
      ...line,
      text: compactLeadingDigits(line.text),
      _x: line.x,
      pageNum,
      column: Math.max(0, columns.filter((x) => line.x >= x - h).length - 1),
    }))
    .sort((a, b) => a.column - b.column || b.y - a.y);
  const firstIndex = ordered.findIndex(
    (line) => numAtStart(compactLeadingDigits(line.text)) === first,
  );
  const selected = ordered.slice(firstIndex);
  const numbers = selected
    .map((line) => numAtStart(compactLeadingDigits(line.text)))
    .filter(Boolean);
  if (numbers.length < 2 || numbers.some((n, i) => n !== first + i))
    return null;
  return selected;
}

/**
 * Numbered journal continuations can share a page with another article.
 * null = no relevant marker (use normal parsing); [] = ambiguous marked
 * layout (do not silently pick the neighbouring article's bibliography).
 * Extra page reads are capped and reused through the existing page cache.
 */
async function markedContinuation(
  pages: any[],
  pageLines: Record<number, PDFLine[]>,
  totalPageNum: number,
  lineNumbered: boolean,
  probeText?: ProbeTextCache,
  preloadedEmptyPages?: Set<number>,
  diagnostics?: PDFParseDiagnostics,
): Promise<PDFLine[] | null> {
  const relevantMarkers = () =>
    Object.entries(pageLines).flatMap(([page, lines]) =>
      continuationMarkers(lines)
        .filter((marker) => bibliographyMarker(marker, lines))
        .map((marker) => ({ ...marker, page: Number(page) })),
    );
  const initialMarkers = relevantMarkers();
  if (!initialMarkers.length) return null;
  // A later independent chapter keeps the ordinary backward-selection rules.
  // A heading above a back marker on the same page belongs to the mixed-page
  // case, so only strictly later pages can override the marked region.
  const latestMarkedPage = Math.max(
    ...initialMarkers.map((marker) => marker.page),
  );
  for (const [page, lines] of Object.entries(pageLines)) {
    if (Number(page) <= latestMarkedPage || Number(page) >= totalPageNum)
      continue;
    for (const heading of lines) {
      if (
        !/^(?:参考文献|references?|bibliography)$/i.test(
          heading.text.replace(/\s+/g, ""),
        )
      )
        continue;
      const segment = continuationSegment(
        lines,
        Number(page),
        heading,
        null,
        1,
      );
      if (!segment) continue;
      const merged = mergeSameRef(segment.map((line) => ({ ...line })));
      if (
        merged.length >= 3 &&
        merged.filter((line) => continuationEvidence(line.text)).length >=
          merged.length * 0.5
      )
        return null;
    }
  }
  let reads = 0;
  const failedPages = new Set<number>();
  const LIMIT = 64;
  const read = async (index: number) => {
    // Empty preload reads used to consume this lookup budget on reread.
    // Keep that search boundary while reusing their already-known empty lines.
    if (preloadedEmptyPages?.has(index)) {
      if (reads >= LIMIT) return false;
      reads++;
      preloadedEmptyPages.delete(index);
      return true;
    }
    if (!(index in pageLines)) {
      if (reads >= LIMIT || failedPages.has(index)) return false;
      reads++;
      try {
        pageLines[index] = await readPdfPage(
          pages[index].pdfPage,
          lineNumbered,
          probeText,
        );
      } catch {
        failedPages.add(index);
        ztoolkit.log(
          `[pdfparser] continuation lookup could not read p${index}`,
        );
        return false;
      }
    }
    return true;
  };
  // First locate the source within the already-authorized backward range.
  // A back marker alone never authorizes reading beyond a manual page limit.
  for (let i = totalPageNum - 1; i >= 0 && reads < LIMIT; i--) await read(i);
  const sources = relevantMarkers()
    .filter(
      (marker) => marker.direction === "forward" && marker.page < totalPageNum,
    )
    .flatMap((marker) => {
      const lines = pageLines[marker.page];
      const headings = lines.filter(
        (line) =>
          /^(?:参考文献|references?|bibliography)$/i.test(
            line.text.replace(/\s+/g, ""),
          ) && line.y > marker.line.y,
      );
      return headings.flatMap((heading) => {
        const segment = continuationSegment(
          lines,
          marker.page,
          heading,
          marker.line,
          1,
        );
        if (!segment) return [];
        const merged = mergeSameRef(segment.map((line) => ({ ...line })));
        if (
          merged.length < 3 ||
          merged.filter((line) => continuationEvidence(line.text)).length <
            merged.length * 0.5
        )
          return [];
        const folios = pageFolios(lines);
        return [{ marker, segment, folios }];
      });
    });
  if (sources.length !== 1) {
    if (diagnostics) {
      diagnostics.status = "ambiguous";
      diagnostics.warnings.push("continuation-source-ambiguous");
    }
    return [];
  }
  const source = sources[0];
  const partial = () => {
    if (diagnostics) {
      diagnostics.status = "partial";
      diagnostics.warnings.push("continuation-target-unverified");
    }
    return source.segment;
  };
  // No reliable source folio means we can keep its local bibliography,
  // but cannot prove that a continuation belongs to this article.
  if (source.folios.length !== 1) return partial();
  for (let i = totalPageNum; i < pages.length && reads < LIMIT; i++)
    await read(i);
  // Do not call a partially searched document unique when the lookup cap
  // prevented ruling out another page carrying the same printed folio.
  if (
    Object.keys(pageLines).length - (preloadedEmptyPages?.size || 0) <
    pages.length
  )
    return partial();
  const targets = Object.entries(pageLines).filter(([, lines]) =>
    lines.some((line) => line._folio === source.marker.folio),
  );
  if (targets.length !== 1 || Number(targets[0][0]) <= source.marker.page)
    return partial();
  const [targetPage, targetLines] = targets[0];
  if (pageFolios(targetLines).length !== 1) return partial();
  const backs = continuationMarkers(targetLines).filter(
    (marker) =>
      marker.direction === "back" && marker.folio === source.folios[0],
  );
  if (backs.length !== 1) return partial();
  // More continuation notices in the target region are not an unambiguous
  // two-part bibliography; leave that unresolved rather than follow cycles.
  if (
    continuationMarkers(targetLines).some(
      (marker) =>
        marker !== backs[0] &&
        marker.line !== backs[0].line &&
        marker.line.y < backs[0].line.y,
    )
  )
    return partial();
  const next =
    Math.max(...source.segment.map((line) => numAtStart(line.text))) + 1;
  const tail = continuationSegment(
    targetLines,
    Number(targetPage),
    backs[0].line,
    null,
    next,
  );
  if (!tail) return partial();
  const merged = mergeSameRef(
    [...source.segment, ...tail].map((line) => ({ ...line })),
  );
  if (
    merged.length !==
    next - 1 + tail.filter((line) => numAtStart(line.text) > 0).length
  )
    return partial();
  ztoolkit.log(
    `[pdfparser] verified continuation p${source.marker.page} -> p${targetPage}, ${merged.length} references`,
  );
  return [...source.segment, ...tail];
}

/** Repeated study-status labels distinguish a grouped bibliography category. */
function isGroupedStudyBibliography(lines: PDFLine[]): boolean {
  return (
    lines.filter((line) =>
      /\{(?:published(?: and unpublished)?|unpublished) data(?: only)?\}/i.test(
        line.text,
      ),
    ).length >= 3 &&
    lines.some((line) =>
      /^references to (?:studies included in this review|studies excluded from this review|studies awaiting assessment|ongoing studies|other published versions of this review)$/i.test(
        line.text.trim().replace(/\s+/g, " "),
      ),
    )
  );
}

/**
 * Walk the PDF backwards page by page and return the lines belonging to the
 * bibliography. See the class comment for the heuristics involved.
 */
async function getRefLines(
  app: any,
  fromCurrentPage: boolean,
  manualCurrentPage: unknown,
  onProgress: ParseProgress,
  probeText: ProbeTextCache,
  diagnostics?: PDFParseDiagnostics,
): Promise<PDFLine[]> {
  await app.pdfLoadingTask.promise;
  await app.pdfViewer.pagesPromise;
  const pages: any[] = app.pdfViewer._pages;
  if (!pages?.length) {
    ztoolkit.log("[pdfparser] no pages");
    return [];
  }
  // Ctrl+refresh support for theses: treat the invocation's captured page as
  // the last page, so an asynchronous viewer page change cannot move the
  // chapter boundary while loading or probing body pages.
  let totalPageNum = pages.length;
  if (fromCurrentPage) {
    if (
      typeof manualCurrentPage !== "number" ||
      !Number.isFinite(manualCurrentPage) ||
      !Number.isInteger(manualCurrentPage) ||
      manualCurrentPage < 1 ||
      manualCurrentPage > pages.length
    ) {
      if (diagnostics) {
        diagnostics.status = "unavailable";
        diagnostics.pageCount = pages.length;
        diagnostics.searchEndPage = null;
        diagnostics.warnings.push("manual-page-unavailable");
      }
      ztoolkit.log("[pdfparser] manual current page unavailable");
      return [];
    }
    totalPageNum = manualCurrentPage;
  }
  const pageLines: Record<number, PDFLine[]> = {};
  // Track only which empty preloads would previously have been reread.
  const preloadedEmptyPages = new Set<number>();
  let maxWidth = 0;
  let maxHeight = 0;
  const lineNumbered = await hasLineNumbers(pages, probeText);
  if (lineNumbered)
    ztoolkit.log("[pdfparser] manuscript line numbers detected");
  if (diagnostics) {
    diagnostics.pageCount = pages.length;
    diagnostics.searchEndPage = totalPageNum - 1;
  }
  const prefNum = Number(getPref("preLoadingPageNum"));
  const minPreLoadPageNum =
    Number.isFinite(prefNum) && prefNum > 0 ? Math.floor(prefNum) : 4;
  const preLoadPageNum =
    totalPageNum > minPreLoadPageNum ? minPreLoadPageNum : totalPageNum;
  onProgress(`${getString("parser-read-text")} 0/${preLoadPageNum}`, 1);

  // pre-read the last pages (needed to detect repeated headers/footers)
  for (
    let pageNum = totalPageNum - 1;
    pageNum >= totalPageNum - preLoadPageNum;
    pageNum--
  ) {
    if (pageNum < 0) {
      break;
    }
    const pdfPage = pages[pageNum].pdfPage;
    maxWidth = pdfPage._pageInfo.view[2];
    maxHeight = pdfPage._pageInfo.view[3];
    const lines = await readPdfPage(pdfPage, lineNumbered, probeText);
    // An empty text layer is a completed read, not a cache miss.
    pageLines[pageNum] = lines;
    if (lines.length == 0) {
      preloadedEmptyPages.add(pageNum);
      continue;
    }
    const pct = ((totalPageNum - pageNum) / preLoadPageNum) * 100;
    onProgress(
      `${getString("parser-read-text")} ${totalPageNum - pageNum}/${preLoadPageNum}`,
      pct > 90 ? 90 : pct,
    );
  }

  const marked = await markedContinuation(
    pages,
    pageLines,
    totalPageNum,
    lineNumbered,
    probeText,
    preloadedEmptyPages,
    diagnostics,
  );
  if (marked !== null) {
    onProgress(getString("parser-done"), 100);
    return marked;
  }

  // walk backwards and split each page into "parts" (visual text blocks);
  // the bibliography may span multiple parts across pages
  const parts: PDFLine[][] = [];
  let part: PDFLine[] = [];
  let refPart: PDFLine[] = [];
  const standaloneRefHeadings: PDFLine[] = [];
  const standaloneHeadingPages = new Map<
    number,
    { lines: PDFLine[]; headings: PDFLine[] }
  >();
  const _refPart: { done: boolean; parts: PDFLine[][]; heading?: PDFLine } = {
    done: false,
    parts: [],
  };
  // A bibliography found late in the document may not be THE bibliography:
  // manuscripts append a separately numbered "Methods References" /
  // "Supplementary References", and bundled supplements carry their own
  // three-entry list. When the heading is qualified like that, or the list
  // is tiny, keep walking and prefer an earlier plain "References" list
  // (a plain one over a qualified one, or one at least twice as long).
  const PLAIN_HEADING =
    /^(\d+[.．]?)?(references?|referencelist|bibliography|参考文献|literaturecited|workscited|references?(?:and|&)notes|notesandreferences|sourcesandcredits)[.:：．]?$/i;
  const headingTextOf = (text: string) =>
    text
      .trim()
      .replace(/^\[(.+)\]$/, "$1")
      .replace(/^(?:[A-Z]\.)?\d+(?:\.\d+)*(?:[.．]|\s*[-–—])?\s+/i, "")
      .replace(/^(?:[A-Z]|[IVX]{2,4})[.．]\s*/i, "")
      .replace(/\s+/g, "");
  let stash: {
    lines: PDFLine[];
    heading?: PDFLine;
    qualified: boolean;
  } | null = null;
  for (let pageNum = totalPageNum - 1; pageNum >= 0; pageNum--) {
    const pdfPage = pages[pageNum].pdfPage;
    maxWidth = pdfPage._pageInfo.view[2];
    maxHeight = pdfPage._pageInfo.view[3];
    let lines: PDFLine[];
    // The normal backward walk has now consumed the old empty-page miss.
    const emptyPreload = preloadedEmptyPages.delete(pageNum);
    if (pageNum in pageLines) {
      lines = [...pageLines[pageNum]];
      if (emptyPreload) {
        // Preserve progress notifications while avoiding the duplicate IO.
        const p = totalPageNum - pageNum;
        onProgress(`${getString("parser-read-text")} ${p}/${p}`, 90);
      }
    } else {
      lines = await readPdfPage(pdfPage, lineNumbered, probeText);
      pageLines[pageNum] = [...lines];
      if (
        continuationMarkers(lines).some((marker) =>
          bibliographyMarker(marker, lines),
        )
      ) {
        const linked = await markedContinuation(
          pages,
          pageLines,
          totalPageNum,
          lineNumbered,
          probeText,
          preloadedEmptyPages,
          diagnostics,
        );
        if (linked !== null) {
          onProgress(getString("parser-done"), 100);
          return linked;
        }
      }
      const p = totalPageNum - pageNum;
      onProgress(`${getString("parser-read-text")} ${p}/${p}`, 90);
    }
    if (lines.length == 0) {
      continue;
    }

    // Only page-edge material can be a running header/footer. References
    // in either body column may differ only by year/volume/page digits.
    const atPageEdge = (line: PDFLine, pg: number) => {
      const view = pages[pg].pdfPage._pageInfo.view;
      const height = view[3] - view[1];
      const width = view[2] - view[0];
      return (
        line.y <= view[1] + 0.12 * height ||
        line.y + line.height >= view[3] - 0.12 * height ||
        line.x >= view[2] - 0.12 * width ||
        line.x + line.width <= view[0] + 0.12 * width
      );
    };
    const folioRow = new Set<PDFLine>();
    for (const folio of lines.filter(
      (line) => line._folio && atPageEdge(line, pageNum),
    )) {
      const headers = lines.filter(
        (line) =>
          line !== folio &&
          /\p{L}/u.test(line.text) &&
          Math.abs(line.y - folio.y) <
            0.2 * Math.min(line.height, folio.height) &&
          Math.max(line.height, folio.height) <
            1.5 * Math.min(line.height, folio.height) &&
          Math.max(
            line.x - folio.x - folio.width,
            folio.x - line.x - line.width,
          ) >
            5 * Math.max(line.height, folio.height),
      );
      if (!headers.length) continue;
      // A folio must advance with the physical pages already read. A
      // bibliography number beside its text is not enough to drop a row.
      const corroborated = Object.entries(pageLines).some(
        ([pg, page]) =>
          Number(pg) !== pageNum &&
          page.some(
            (other) =>
              other._folio !== undefined &&
              other._folio - Number(pg) === folio._folio! - pageNum &&
              atPageEdge(other, Number(pg)) &&
              Math.abs(other.y - folio.y) <
                2 * Math.max(other.height, folio.height),
          ),
      );
      if (corroborated) {
        folioRow.add(folio);
        headers.forEach((header) => folioRow.add(header));
      }
    }
    lines = lines.filter((line) => !folioRow.has(line));

    // Match normalized running matter only after the page-edge check.
    const normCache = new Map<string, string>();
    const removeNumber = (text: string) => {
      const hit = normCache.get(text);
      if (hit !== undefined) return hit;
      let t = text;
      // roman/letter page numbers
      if (/^[A-Z]{1,3}$/.test(t)) {
        t = "";
      }
      // normal page numbers 1, 2, 3
      t = t.replace(/\s+/g, "").replace(/\d+/g, "");
      normCache.set(text, t);
      return t;
    };
    const isSamePosition = (lineA: PDFLine, lineB: PDFLine) => {
      const round = (n: number) => Math.round(n);
      return (
        round(lineA.x) == round(lineB.x) &&
        round(lineA.y) == round(lineB.y) &&
        round(lineA.width) == round(lineB.width) &&
        round(lineA.height) == round(lineB.height)
      );
    };
    const isSameText = (lineA: PDFLine, lineB: PDFLine) =>
      removeNumber(lineA.text) == removeNumber(lineB.text);
    const wrappedRanges = new Set(
      lines.filter(
        (line) =>
          /^\s*\d+\s*[-–‒]\s*\d+[.,;]?\s*$/.test(line.text) &&
          lines.some(
            (previous) =>
              /\p{L}/u.test(previous.text) &&
              previous.y > line.y &&
              previous.y - line.y <
                3 * Math.max(previous.height, line.height, 6) &&
              Math.abs(absX(previous) - absX(line)) <
                5 * Math.max(previous.height, line.height, 6),
          ),
      ),
    );
    lines.forEach((line) => {
      if (!atPageEdge(line, pageNum) || wrappedRanges.has(line) || line.same) {
        return;
      }
      for (const _pageIndex in pageLines) {
        // one match is enough — stop scanning the remaining pages
        if (line.same) break;
        // skip this line's own page
        if (Number(_pageIndex) == pageNum) {
          continue;
        }
        pageLines[Number(_pageIndex)].find((_line) => {
          // cheap geometry reject first, regex-normalized text second
          if (
            atPageEdge(_line, Number(_pageIndex)) &&
            isSamePosition(line, _line) &&
            isSameText(line, _line)
          ) {
            line.same = _line;
            return true;
          }
          return false;
        });
      }
    });
    lines = lines.filter((e) => !e.same);
    if (lines.length == 0) {
      continue;
    }

    // skip figure/table captions so they don't break column detection
    const isFigureOrTable = (text: string) => {
      text = text.replace(/\s+/g, "");
      return (
        /^(Table|Fig|Figure).*\d/i.test(text) ||
        /^(?:Supplementary|Supplemental)(?:Tables?|Fig(?:ure)?s?)[.:]?[sS]?\d/i.test(
          text,
        )
      );
    };
    lines = lines.filter((e) => !isFigureOrTable(e.text));
    if (lines.length == 0) {
      continue;
    }

    // column detection: a new column starts when y jumps back up, or the
    // line is entirely right/left of everything in the current column
    const columns: PDFLine[][] = [[lines[0]]];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const column = columns[columns.length - 1];
      if (
        line.y > column[column.length - 1].y ||
        column
          .map((_line) => Number(line.x > _line.x + _line.width))
          .reduce((a, b) => a + b) == column.length ||
        column
          .map((_line) => Number(line.x + line.width < _line.x))
          .reduce((a, b) => a + b) == column.length
      ) {
        columns.push([line]);
      } else {
        column.push(line);
      }
    }
    columns.forEach((column, columnIndex) => {
      column.forEach((line) => {
        line.column = columnIndex;
        line.pageNum = pageNum;
      });
    });

    let isStart = false;
    // finish a part: restore reading order, then normalize the hanging
    // indent per page+column group (keep original x in _x, offset in _offset)
    const donePart = (part: PDFLine[]) => {
      if (part.length == 0) {
        return part;
      }
      part.reverse();
      const groups: PDFLine[][] = [[part[0]]];
      for (let i = 1; i < part.length; i++) {
        const line = part[i];
        const lastGroup = groups[groups.length - 1];
        const lastLine = lastGroup[lastGroup.length - 1];
        if (
          line.column == lastLine.column &&
          line.pageNum == lastLine.pageNum
        ) {
          lastGroup.push(line);
        } else {
          groups.push([line]);
        }
      }
      groups.forEach((group) => {
        const groupOffset = group.map((l) => l.x).sort((a, b) => a - b)[0];
        group.forEach((l) => {
          l._x = l.x;
          l._offset = groupOffset;
          l.x = parseInt((l.x - groupOffset).toFixed(1));
        });
      });
      parts.push(part);
      ztoolkit.log(
        `[pdfparser] part p${part[0].pageNum} n=${part.length} first="${part[0].text.slice(0, 40)}" last="${part[part.length - 1].text.slice(0, 40)}"`,
      );
      return part;
    };
    // a bibliography heading: 参考文献 / References / Bibliography, short
    const isRefBreak = (text: string) => {
      text = headingTextOf(text);
      if (
        text.toLowerCase() === "additionalreferences" &&
        isGroupedStudyBibliography(lines)
      )
        return false;
      // A whole heading, not a table's "1 [Reference]" or a sentence fragment
      // containing that word. Qualified lists retain the existing stash rules.
      return /^(?:\d+[.．]?)?(?:(?:supplementary|supplemental|methods?|additional|selected|electronic|e))?(?:参考文献|references?|referencelist|bibliography|literaturecited|workscited|references?(?:and|&)notes|notesandreferences|sourcesandcredits)[.:：．]?$/i.test(
        text,
      );
    };
    const headingIndexes = lines
      .map((line, index) => (isRefBreak(line.text) ? index : -1))
      .filter((index) => index >= 0);
    if (headingIndexes.length) {
      // The reverse walk normalizes line coordinates while committing parts.
      // Keep one filtered, immutable source snapshot for a later ownership
      // decision that must use physical geometry rather than stream columns.
      const snapshot = lines.map((line) => ({
        ...line,
        _height: [...line._height],
      }));
      standaloneHeadingPages.set(pageNum, {
        lines: snapshot,
        headings: headingIndexes.map((index) => snapshot[index]),
      });
    }
    // finish a bibliography part; the bibliography is complete when its
    // first entry starts with number 1 (otherwise it continues on an
    // earlier page — keep collecting)
    const doneRefPart = (part: PDFLine[]) => {
      if (part.length == 0) {
        // heading with nothing below it on this page
        _refPart.done = _refPart.parts.length > 0;
        return;
      }
      part = donePart(part);
      // A bibliography may have an explanatory preface. Keep the verified
      // numbered sequence, without borrowing paragraphs preceding entry 1.
      const numberedStart = findNumberedStart(part, part.length);
      if (numberedStart > 0) part = part.slice(numberedStart);
      // false heading (Science's supplementary list says "References
      // (160–200)", box titles mention "reference"…): the block under a
      // real heading looks like references
      const refLike =
        part.filter((l) => getRefType(l.text) != -1).length / part.length;
      const startsAtOne = part.some((l) => numAtStart(l.text) === 1);
      const dated = part.some((line) =>
        /\b(?:1\d|20)\d{2}\b/.test(
          line.text
            .replace(/https?:\/\/\S+/gi, "")
            .normalize("NFKC")
            .replace(/(\d)\s+(?=\d)/g, "$1"),
        ),
      );
      const linkedUndated =
        part.some((line) => /\bn\s*\.\s*d\s*\./i.test(line.text)) &&
        part.some((line) => /https?:\/\/\S+|\b10\.\d{4,9}\//i.test(line.text));
      const shortNumberedStart =
        part.length < 3 && numAtStart(part[0].text) === 1;
      if (
        (part.length < 3 && !startsAtOne) ||
        refLike < 0.25 ||
        (!dated && !linkedUndated && numberedStart < 0 && !shortNumberedStart)
      ) {
        ztoolkit.log(
          `[pdfparser] ignoring heading: block below is not references (n=${part.length}, refLike=${refLike.toFixed(2)}, dated=${dated})`,
        );
        return;
      }
      _refPart.parts.push(part);
      const firstNumber = numAtStart(part[0].text);
      _refPart.done = firstNumber === 0 || firstNumber === 1;
      ztoolkit.log(
        `[pdfparser] refPart p${part[0].pageNum} n=${part.length} done=${_refPart.done}`,
      );
    };

    // bottom-right-most element(s): every other line is up/left of it —
    // body text of a page (read bottom-up) should start there, anything
    // before it is a trailing figure/table
    const endLines = lines.filter((line) =>
      lines.every((_line) => {
        if (_line == line) {
          return true;
        }
        return _line.x + _line.width < line.x + line.width || _line.y > line.y;
      }),
    );
    const heightOverlap = (hh1: number[], hh2: number[]) =>
      hh1.some((h1) =>
        // with tolerance
        hh2.some((h2) => h1 - h2 < (h1 > h2 ? h2 : h1) * 0.3),
      );
    const endLine = endLines[endLines.length - 1];
    // The "skip until the bottom-right body line" heuristic assumes the
    // content stream ends with the body text. Many journals draw the
    // running footer FIRST, so endLine sits at the start of the array and
    // walking backwards would skip the entire page (JITC lost pages of
    // references this way). Only skip when endLine is late in the stream.
    const endIdx = lines.indexOf(endLine);
    if (endIdx >= 0 && endIdx < lines.length * 0.5) {
      isStart = true;
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (
        // some PDFs end their last page with figures/tables — skip them
        // until the true bottom-right body line is reached
        !isStart &&
        (line != endLine ||
          /(图|fig|Fig|Figure).*\d+/.test(line.text.replace(/\s+/g, "")))
      ) {
        // a figure may come first: pack and drop the part collected so far
        // (e.g. 10.1016/j.scitotenv.2018.03.202)
        if (part.length && pageNum == totalPageNum - 1) {
          donePart(part);
          part = [];
        }
        continue;
      } else {
        isStart = true;
      }
      // previous page's first line vs this page's last line: font-height
      // mismatch means a different block
      if (
        part.length > 0 &&
        !heightOverlap(part[part.length - 1]._height, line._height)
      ) {
        donePart(part);
        part = [line];
        continue;
      }
      // check before pushing
      if (isRefBreak(line.text)) {
        if (!standaloneRefHeadings.includes(line))
          standaloneRefHeadings.push(line);
        _refPart.heading = line;
        doneRefPart(part);
        part = [];
        break;
      }
      part.push(line);
      if (
        // break inside the page when any of these hold
        lines[i - 1] &&
        (!heightOverlap(line._height, lines[i - 1]._height) ||
          (lines[i].column as number) < (lines[i - 1].column as number) ||
          (line.pageNum == lines[i - 1].pageNum &&
            line.column == lines[i - 1].column &&
            // enlarged line-gap threshold
            abs(line.y - lines[i - 1].y) > line.height * 3))
      ) {
        if (isRefBreak(lines[i - 1].text)) {
          if (!standaloneRefHeadings.includes(lines[i - 1]))
            standaloneRefHeadings.push(lines[i - 1]);
          _refPart.heading = lines[i - 1];
          doneRefPart(part);
          part = [];
          break;
        }
        donePart(part);
        part = [];
      }
    }
    // An unbroken block on page zero has no following page/gap to commit
    // it. Preserve it for the existing no-heading/year-gated fallback.
    if (pageNum === 0 && part.length && !_refPart.done) {
      donePart(part);
      part = [];
    }
    if (_refPart.done) {
      let lines: PDFLine[] = [];
      _refPart.parts.reverse().forEach((p) => {
        lines = [...lines, ...p];
      });
      const headingText = headingTextOf(_refPart.heading?.text ?? "");
      const qualified = !!_refPart.heading && !PLAIN_HEADING.test(headingText);
      const starts = lines.filter((l) => numAtStart(l.text) > 0).length;
      const dated = lines.filter((l) =>
        /\b(1[89]|20)\d{2}\b/.test(l.text),
      ).length;
      if (!stash) {
        // "tiny" is judged on numbered entry starts, not lines: the walk
        // may have split a double-spaced heading page into parts that the
        // completion step only adds later
        if ((qualified || (starts < 6 && lines.length < 40)) && pageNum > 0) {
          ztoolkit.log(
            `[pdfparser] bibliography on p${pageNum} is ${qualified ? `"${headingText}"` : "tiny"} (${lines.length} lines, ${starts} numbered) — looking for an earlier one`,
          );
          stash = { lines, heading: _refPart.heading, qualified };
          _refPart.done = false;
          _refPart.parts = [];
          _refPart.heading = undefined;
          continue;
        }
        refPart = lines;
        break;
      }
      // second list: the earlier one wins when it is the plain bibliography
      // (the later was qualified) or clearly the larger of two plain ones —
      // and it must read like a bibliography itself (one year per entry,
      // so ≥ 15% of lines): a manuscript's front matter also survives the
      // heading guard
      const better =
        !qualified &&
        dated >= 0.15 * lines.length &&
        (stash.qualified || lines.length >= 2 * stash.lines.length);
      if (better) {
        ztoolkit.log(
          `[pdfparser] using the earlier bibliography on p${pageNum} (${lines.length} lines)`,
        );
        refPart = lines;
      } else {
        refPart = stash.lines;
        _refPart.heading = stash.heading;
      }
      break;
    }
  }
  if (refPart.length == 0 && stash) {
    refPart = stash.lines;
    _refPart.heading = stash.heading;
  }

  // The bibliography may CONTINUE past the page that carries the heading
  // (NEJM/Lancet: heading + refs 1–11 at the bottom of page N, refs 12–31
  // at the top of page N+1). Pages after N were walked first and their
  // blocks sit in `parts` as ordinary parts — append the reference-like
  // ones, in page/reading order, so the list is complete.
  if (refPart.length) {
    // page that carries the heading = the earliest page in refPart. Lines
    // from later pages can only be a small carry-over (typically the next
    // page's running head that survived footer removal), never the block.
    const lastRefPage = Math.min(
      ...refPart.map((l) => l.pageNum ?? Number.MAX_SAFE_INTEGER),
    );
    const refScore = (p: PDFLine[]) =>
      p.filter((l) => getRefType(l.text) != -1).length / p.length;
    const unnumberedContinuation = (lines: PDFLine[]) => {
      if (refScore(lines) < 0.5) return false;
      const entries = mergeSameRef(lines.map((line) => ({ ...line })));
      // An uppercase word opens both an author name and an ordinary
      // paragraph. Demand the publication years of a bibliography too.
      return (
        entries.length > 0 &&
        entries.filter((entry) => /\b(1[89]|20)\d{2}\b/.test(entry.text))
          .length >=
          entries.length * 0.5
      );
    };
    // numbered bibliographies: the continuation must pick up at the next
    // number ("11." on page N → a line starting "12." / "[12]" on N+1)
    // strict form (a real entry start, not a stray "839." page fragment)
    const numOf = (t: string) => numAtStart(t);
    // A lone numbered footnote beside an author-year bibliography does not
    // turn its next page into a numbered continuation starting at footnote+1.
    let numberedBibliography = findNumberedStart(refPart, refPart.length) >= 0;
    const bibliographyHeight = refPart[0].height;
    const smallNumberedFootnote = (line: PDFLine) =>
      !numberedBibliography &&
      /^\d{1,3}\s+https?:\/\/\S+\s*$/i.test(line.text.trim()) &&
      !refPart.some(
        (other) =>
          other.pageNum === line.pageNum &&
          other.y < line.y &&
          other.height >= 0.85 * bibliographyHeight &&
          /\p{L}/u.test(other.text),
      ) &&
      line.height < 0.85 * bibliographyHeight;
    refPart = refPart.filter((line) => !smallNumberedFootnote(line));
    // A bare number may open a wrapped title or a volume fragment. Advance
    // only the established entry sequence, rather than taking its maximum.
    const sequenceEnd = (lines: PDFLine[], first = 0) => {
      const nums = lines.map((line) => numOf(line.text));
      const positions = new Map<number, number>();
      nums.forEach((n, i) => {
        if (n) positions.set(n, i);
      });
      const citationAt = (start: number) => {
        let text = lines[start].text;
        for (
          let i = start + 1;
          i < Math.min(lines.length, start + MAX_TAIL_LINES + 1);
          i++
        ) {
          if (nums[i] || tailNoiseKind(lines[i].text)) break;
          text += " " + lines[i].text;
        }
        return hasCitationEvidence(text);
      };
      let current = first;
      nums.forEach((n, i) => {
        if (
          n === current + 1 ||
          (current > 0 &&
            n > current + 1 &&
            (positions.get(current + 1) ?? -1) < i &&
            (n === current + 2 ||
              ((positions.get(n + 1) ?? -1) > i && citationAt(i))))
        )
          current = n;
      });
      return current;
    };
    let lastNum = numberedBibliography ? sequenceEnd(refPart) : 0;
    const numberedCount = (p: PDFLine[]) =>
      p.filter((l) => numOf(l.text) > 0).length;
    const picksUp = (p: PDFLine[]) =>
      lastNum > 0 &&
      numberedCount(p) >= 2 &&
      p.some((l) => numOf(l.text) === lastNum + 1);
    // The final page may contain just one entry. Require the exact next
    // number, a publication year and a complete citation ending before
    // accepting this weaker continuation signal.
    const singleContinuation = (p: PDFLine[]) => {
      if (lastNum < 3 || numberedCount(p) !== 1) return false;
      const start = p.findIndex((line) => numOf(line.text) === lastNum + 1);
      if (start < 0) return false;
      const text = p
        .slice(start)
        .map((line) => line.text.trim())
        .join(" ");
      return (
        /\b(1[89]|20)\d{2}\b/.test(text) &&
        ENTRY_END.test(text) &&
        hasCitationEvidence(text)
      );
    };
    // Heading page: the walk (bottom-up, breaking parts on big gaps) may
    // have committed the entries between the heading and the page bottom
    // as ordinary parts before it reached the heading — double-spaced
    // manuscripts split every entry into its own part. Take the lines of
    // the heading page that come AFTER the heading in reading order.
    //
    // "After" must be judged spatially, not by stream order: the stream
    // column index only says "drawn later", and JAMA draws the figure at
    // the top of the page after the references. So a line qualifies when
    // it is (1) below the heading inside the heading's column band and
    // chained to the block without a block-sized gap (rules out the page
    // footer), or (2) in a column to the right of the heading's and that
    // right-hand block really continues the bibliography — it picks up
    // the numbering, or (unnumbered lists) its entries carry publication
    // years. Axis labels, legends and captions fail both.
    const heading = _refPart.heading;
    if (heading && heading.pageNum === lastRefPage) {
      const have = new Set(refPart);
      const onPage = (l: PDFLine) => l.pageNum === lastRefPage;
      const pageLinesAll = [
        ...refPart.filter(onPage),
        ...parts.flat().filter((l) => onPage(l) && !have.has(l)),
      ];
      const colLines = pageLinesAll.filter((l) => l.column === heading.column);
      const spanL = Math.min(absX(heading), ...colLines.map(absX));
      const spanR = Math.max(
        absX(heading) + heading.width,
        ...colLines.map((l) => absX(l) + l.width),
      );
      const hh = Math.max(heading.height, 6);
      const inSpan = (l: PDFLine) =>
        absX(l) < spanR - hh && absX(l) + l.width > spanL + hh;
      const candidates = pageLinesAll.filter((l) => !have.has(l));
      const extra: PDFLine[] = [];
      // (1) below the heading, in its column band, chained downward
      let floorY = Math.min(
        heading.y,
        ...refPart
          .filter((l) => onPage(l) && l.column === heading.column)
          .map((l) => l.y),
      );
      const below = candidates
        .filter((l) => l.y < heading.y && inSpan(l))
        .sort((a, b) => b.y - a.y);
      for (const l of below) {
        if (floorY - l.y > 5 * Math.max(l.height, hh)) break;
        if (smallNumberedFootnote(l)) continue;
        extra.push(l);
        floorY = Math.min(floorY, l.y);
      }
      // (2) columns to the right of the heading's column
      const right = candidates
        .filter((l) => absX(l) >= spanR - hh)
        .sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || b.y - a.y);
      if (right.length >= 2) {
        const YEAR = /\b(1[89]|20)\d{2}\b/;
        const probe = mergeSameRef(right.map((l) => ({ ...l })));
        const dated = probe.filter((e) => YEAR.test(e.text)).length;
        // the merge may over-split a block whose entry numbers are set as
        // separate runs (NEJM 2006: 48 "entries" for 14 references), so
        // also judge the raw lines: a justified text column (most lines
        // near the block's full width) in which years occur at the rate
        // of one per entry (≥ 1 in 7 lines — 3-column layouts wrap an
        // entry over ~6 lines). Axis labels fail the width test, legends
        // and captions the year rate.
        const widths = right.map((l) => l.width).sort((a, b) => a - b);
        const wide = widths[Math.floor(widths.length * 0.9)] || 0;
        const columnLike =
          right.filter((l) => l.width >= 0.7 * wide).length >=
          right.length * 0.5;
        const yearLines = right.filter((l) => YEAR.test(l.text)).length;
        const continues =
          (lastNum > 0 && picksUp(right)) ||
          (probe.length > 0 && dated / probe.length >= 0.5) ||
          (columnLike && yearLines >= right.length / 7);
        if (continues) extra.push(...right);
        else
          ztoolkit.log(
            `[pdfparser] heading page: ${right.length} lines right of the heading column are not references (lastNum=${lastNum}, entries=${probe.length}, dated=${dated}, yearLines=${yearLines}, columnLike=${columnLike})`,
          );
      }
      const dropped = candidates.length - extra.length;
      if (dropped)
        ztoolkit.log(
          `[pdfparser] heading page: ${dropped} lines not after the heading in reading order`,
        );
      if (extra.length) {
        const merged = [
          ...refPart.filter((l) => l.pageNum === lastRefPage),
          ...extra,
        ].sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || b.y - a.y);
        refPart = [
          ...merged,
          ...refPart.filter((l) => l.pageNum !== lastRefPage),
        ];
        ztoolkit.log(
          `[pdfparser] heading page completed with ${extra.length} more lines`,
        );
        numberedBibliography ||=
          findNumberedStart(refPart, refPart.length) >= 0;
        if (numberedBibliography) lastNum = sequenceEnd(refPart);
      }
    }

    // The recovery cursor starts after heading-page completion, which can add
    // lines that the reverse walk committed separately. It advances only
    // through supported, orderly pages before a prospective ownership page.
    const recoveryBaseLastNum = numberedBibliography
      ? sequenceEnd(refPart.filter((line) => line.pageNum === lastRefPage))
      : 0;
    const advanceRecoveryCursor = (cursor: number, lines: PDFLine[]) => {
      if (cursor < 1 || !lines.some((line) => numOf(line.text) === cursor + 1))
        return cursor;
      const end = sequenceEnd(lines, cursor);
      if (end <= cursor) return cursor;
      const entries = mergeSameRef(lines.map((line) => ({ ...line })));
      const entriesByNumber = new Map(
        entries.map((line) => [numOf(line.text), line]),
      );
      for (let number = cursor + 1; number <= end; number++) {
        const entry = entriesByNumber.get(number);
        if (!entry || !hasCitationEvidence(entry.text)) return cursor;
      }
      return end;
    };

    // Parts may straddle pages (the walk carries an unbroken block from
    // page N+1 into page N) and double-spaced manuscripts split every
    // entry into its own part — so judge per PAGE: the union of all lines
    // on each later page, restored to reading order (column, then top→down).
    const byPage = new Map<number, PDFLine[]>();
    for (const p of parts) {
      for (const l of p) {
        const pg = l.pageNum ?? -1;
        if (pg > lastRefPage) {
          if (!byPage.has(pg)) byPage.set(pg, []);
          byPage.get(pg)!.push(l);
        }
      }
    }
    const continuation: PDFLine[][] = [];
    const supportedRestart = (lines: PDFLine[]) => {
      if (sequenceEnd(lines) < 2) return false;
      const entries = mergeSameRef(lines.map((line) => ({ ...line })));
      const supported = entries.filter((entry) =>
        hasCitationEvidence(entry.text),
      ).length;
      return supported >= 2 && supported >= entries.length * 0.5;
    };
    const restartedBibliography = (page: number, pageLines: PDFLine[]) => {
      if (!numberedBibliography || lastNum < 1) return false;
      const headings = standaloneRefHeadings.filter(
        (heading) => heading.pageNum === page,
      );
      if (!headings.length) return false;
      const ordered = [...new Set([...pageLines, ...headings])].sort(
        (a, b) => (a.column ?? 0) - (b.column ?? 0) || b.y - a.y,
      );
      const headingSet = new Set(headings);
      const expected = lastNum + 1;
      const expectedIndex = ordered.findIndex(
        (line) => numOf(line.text) === expected,
      );
      if (expectedIndex < 0) return false;
      for (const heading of headings) {
        const headingIndex = ordered.indexOf(heading);
        // A later restarted bibliography cannot invalidate a valid
        // continuation prefix that already supplied the expected number.
        if (headingIndex < 0 || headingIndex >= expectedIndex) continue;
        const freshIndex = ordered.findIndex(
          (line, index) =>
            index > headingIndex &&
            index < expectedIndex &&
            numOf(line.text) === 1,
        );
        if (freshIndex < 0) continue;
        const restarted = ordered
          .slice(freshIndex, expectedIndex)
          .filter((line) => !headingSet.has(line));
        // A heading word and numbered table rows are not ownership evidence.
        // Require a fresh sequence plus multiple complete citations before
        // treating the expected number as part of another bibliography.
        if (supportedRestart(restarted)) return true;
      }
      return false;
    };
    const recoverSamePagePrefix = (page: number) => {
      const snapshot = standaloneHeadingPages.get(page);
      if (!snapshot) return null;
      const priorByPage = new Map<number, PDFLine[]>();
      for (const line of refPart) {
        const priorPage = line.pageNum ?? -1;
        if (priorPage <= lastRefPage || priorPage >= page) continue;
        if (!priorByPage.has(priorPage)) priorByPage.set(priorPage, []);
        priorByPage.get(priorPage)!.push(line);
      }
      // Accepted ordinary continuations supersede stray carried lines from
      // the same page, matching the final append behavior below.
      for (const accepted of continuation) {
        const priorPage = accepted[0]?.pageNum ?? -1;
        if (priorPage > lastRefPage && priorPage < page)
          priorByPage.set(priorPage, accepted);
      }
      let recoveryLastNum = recoveryBaseLastNum;
      for (const priorPage of [...priorByPage.keys()].sort((a, b) => a - b)) {
        const prior = priorByPage
          .get(priorPage)!
          .slice()
          .sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || b.y - a.y);
        recoveryLastNum = advanceRecoveryCursor(recoveryLastNum, prior);
      }
      if (!numberedBibliography || recoveryLastNum < 1) return null;
      const headingSet = new Set(snapshot.headings);
      const expected = recoveryLastNum + 1;
      for (const heading of [...snapshot.headings].sort((a, b) => b.y - a.y)) {
        const tolerance = 3 * Math.max(heading.height, 6);
        const headingX = absX(heading);
        const sameLane = (line: PDFLine) =>
          Math.abs(absX(line) - headingX) <=
          Math.max(tolerance, 3 * Math.max(line.height, 6));
        const above = snapshot.lines.filter(
          (line) => !headingSet.has(line) && line.y > heading.y,
        );
        const expectedLines = above.filter(
          (line) => numOf(line.text) === expected,
        );
        // More than one physical candidate, or a candidate in another x lane,
        // is not an ownership boundary we can resolve conservatively.
        if (expectedLines.length !== 1 || !sameLane(expectedLines[0])) continue;
        if (
          snapshot.lines.some((line) => numOf(line.text) > 0 && !sameLane(line))
        )
          continue;

        const below = snapshot.lines
          .filter(
            (line) =>
              !headingSet.has(line) && line.y < heading.y && sameLane(line),
          )
          .sort((a, b) => b.y - a.y);
        const freshIndex = below.findIndex((line) => numOf(line.text) === 1);
        if (freshIndex !== 0 || !supportedRestart(below)) continue;

        const laneAbove = above.filter(sameLane).sort((a, b) => b.y - a.y);
        const expectedIndex = laneAbove.indexOf(expectedLines[0]);
        if (
          expectedIndex < 0 ||
          laneAbove.slice(0, expectedIndex).some((line) => numOf(line.text) > 0)
        )
          continue;
        let start = expectedIndex;
        while (start > 0 && numOf(laneAbove[start - 1].text) === 0) {
          const previous = laneAbove[start - 1];
          const current = laneAbove[start];
          if (
            previous.y - current.y >
            3 * Math.max(previous.height, current.height, 6)
          )
            break;
          start--;
        }

        let next = expected;
        let acceptedEnd = -1;
        for (let index = expectedIndex; index < laneAbove.length;) {
          if (numOf(laneAbove[index].text) !== next) break;
          let following = index + 1;
          while (
            following < laneAbove.length &&
            numOf(laneAbove[following].text) === 0
          )
            following++;
          const entryText = laneAbove
            .slice(index, following)
            .map((line) => line.text.trim())
            .join(" ");
          if (!hasCitationEvidence(entryText)) break;
          acceptedEnd = following;
          next++;
          if (following >= laneAbove.length) break;
          index = following;
        }
        if (
          acceptedEnd < 0 ||
          laneAbove.slice(acceptedEnd).some((line) => numOf(line.text) > 0)
        )
          continue;
        const recovered = laneAbove.slice(start, acceptedEnd);
        const numbered = recovered.slice(expectedIndex - start);
        if (next === expected + 1) {
          if (recoveryLastNum < 3 || numberedCount(numbered) !== 1) continue;
          const text = numbered.map((line) => line.text.trim()).join(" ");
          if (
            !/\b(1[89]|20)\d{2}\b/.test(text) ||
            !ENTRY_END.test(text) ||
            !hasCitationEvidence(text)
          )
            continue;
        } else if (next <= expected + 1) continue;

        const laneOffset = Math.min(...recovered.map(absX));
        const normalized = recovered.map((line) => ({
          ...line,
          _height: [...line._height],
        }));
        normalized.forEach((line) => {
          line._x = absX(line);
          line._offset = laneOffset;
          line.x = parseInt((line._x - laneOffset).toFixed(1));
          line.column = 0;
        });
        return normalized;
      }
      return null;
    };
    const continuationPages = new Set([
      ...byPage.keys(),
      ...[...standaloneHeadingPages.keys()].filter(
        (page) => page > lastRefPage,
      ),
    ]);
    let ownershipBoundaryPage: number | null = null;
    for (const pg of [...continuationPages].sort((a, b) => a - b)) {
      const recovered = recoverSamePagePrefix(pg);
      if (recovered) {
        continuation.push(recovered);
        ownershipBoundaryPage = pg;
        ztoolkit.log(
          `[pdfparser] recovered continuation prefix before restarted bibliography p${pg} n=${recovered.length}`,
        );
        break;
      }
      const pageParts = byPage.get(pg);
      if (!pageParts) continue;
      const lines = pageParts.sort(
        (a, b) => (a.column ?? 0) - (b.column ?? 0) || b.y - a.y,
      );
      if (restartedBibliography(pg, lines)) {
        ztoolkit.log(
          `[pdfparser] ordinary continuation stopped at restarted bibliography p${pg}`,
        );
        break;
      }
      if (
        (lines.length >= 3 &&
          (lastNum > 0 ? picksUp(lines) : unnumberedContinuation(lines))) ||
        singleContinuation(lines)
      ) {
        continuation.push(lines);
        // the next page must pick up where THIS page ends, not where the
        // heading page ended — double-spaced manuscripts split every page
        // into parts, so nothing but this step carries the count forward
        if (numberedBibliography) {
          lastNum = sequenceEnd(lines, lastNum);
        }
      } else if (continuation.length) {
        break; // the list ended on the previous page
      }
    }
    if (continuation.length) {
      // the carried-over stray lines from those pages are superseded by
      // the complete blocks (they were the running head / a fragment)
      const contPages = new Set(continuation.map((p) => p[0].pageNum));
      refPart = refPart.filter(
        (line) =>
          !contPages.has(line.pageNum) &&
          (ownershipBoundaryPage === null ||
            (line.pageNum ?? -1) < ownershipBoundaryPage),
      );
    }
    for (const p of continuation) {
      ztoolkit.log(
        `[pdfparser] appending continuation page p${p[0].pageNum} n=${p.length}`,
      );
      refPart = [...refPart, ...p];
    }
    // Earlier continuation pages can be recovered after a later page was
    // already carried into refPart. Preserve each page's existing line order.
    refPart.sort((a, b) => (a.pageNum ?? 0) - (b.pageNum ?? 0));
  }

  // A child-category recovery must stop at the next major study section.
  if (isGroupedStudyBibliography(refPart)) {
    const heights = refPart
      .map((line) => line.height)
      .filter((height) => height > 0)
      .sort((a, b) => a - b);
    const bodyHeight = heights[Math.floor(heights.length / 2)] ?? 0;
    const end = refPart.findIndex((line, index) => {
      if (
        !/^characteristicsofstudies$/i.test(line.text.replace(/\s+/g, "")) ||
        !(bodyHeight > 0 && line.height >= bodyHeight * 1.2)
      )
        return false;
      // Ignore smaller structural legends, but never skip an open author/title line.
      const previous = refPart
        .slice(0, index)
        .reverse()
        .find((prior) => prior.height >= bodyHeight * 0.85);
      if (!previous || !ENTRY_END.test(previous.text)) return false;
      // A title alone can also be an authorless publication. Confirm the
      // following study-table structure in the already-read page, even when
      // the bibliography block contains only its major heading.
      const following = (pageLines[line.pageNum ?? -1] ?? [])
        .filter(
          (next) =>
            next.y < line.y &&
            line.y - next.y <= 30 * bodyHeight &&
            Math.abs(absX(next) - absX(line)) <= 2 * bodyHeight,
        )
        .sort((a, b) => b.y - a.y)
        .slice(0, 32);
      const subheading = following.find((next) =>
        /^characteristicsof(?:included|excluded)studies(?:\[orderedbystudyid\])?$/i.test(
          next.text.replace(/\s+/g, ""),
        ),
      );
      if (!subheading) return false;
      const fields = following.filter(
        (next) =>
          next.y < subheading.y &&
          /^(?:methods|participants|interventions|outcomes|notes)$/i.test(
            next.text.trim(),
          ),
      );
      const alignedFields = fields.some(
        (first) =>
          new Set(
            fields
              .filter(
                (next) => Math.abs(absX(next) - absX(first)) <= bodyHeight,
              )
              .map((next) => next.text.trim().toLowerCase()),
          ).size >= 2,
      );
      if (!alignedFields) return false;
      return (
        (line.pageNum ?? 0) > (previous.pageNum ?? 0) ||
        (line.pageNum === previous.pageNum &&
          line.column === previous.column &&
          previous.y - line.y > 3 * bodyHeight)
      );
    });
    if (end >= 0) refPart = refPart.slice(0, end);
  }

  onProgress(getString("parser-analyze"), 95);
  if (refPart.length == 0) {
    // no explicit References heading found — fall back to the part with
    // the most reference-typed lines
    if (parts.length == 0) {
      ztoolkit.log("[pdfparser] no text parts found");
      return [];
    }
    // prefer a numbered list starting at 1 (score = numbered lines), else
    // the part with the most reference-typed lines
    const partRefNum: [number, number, number][] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const start = findNumberedStart(p, p.length);
      const numbered =
        start >= 0
          ? p.slice(start).filter((l) => numAtStart(l.text) > 0).length
          : 0;
      const isRefs = p.filter((line) => getRefType(line.text) != -1).length;
      partRefNum.push([i, numbered, isRefs]);
    }
    partRefNum.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
    let foundFallback = false;
    for (const [index, numbered, refLike] of partRefNum) {
      const rawPart = parts[index];
      // Conference abstracts, posters and letters may contain isolated
      // reference-like lines. Keep the existing eligibility gate, but let a
      // higher-ranked junk block yield to the next candidate.
      if (
        numbered < 3 &&
        (rawPart.length < 3 || refLike / rawPart.length < 0.5)
      )
        continue;
      let candidate = rawPart;
      if (numbered >= 3) {
        const start = findNumberedStart(candidate, candidate.length);
        if (start > 0) candidate = candidate.slice(start);
      }
      // A numbered block is not automatically a bibliography: author
      // affiliation lists, statistics tables, search strategies and section
      // headings all number their lines too. Apply the established merged
      // entry gates once per candidate, in the established rank order.
      const probe = mergeSameRef(candidate.map((line) => ({ ...line })));
      const dated = probe.filter((entry) =>
        /\b(1[89]|20)\d{2}\b/.test(entry.text),
      ).length;
      const supported = probe.filter((entry) =>
        hasCitationEvidence(entry.text),
      ).length;
      if (
        !probe.length ||
        dated / probe.length < 0.5 ||
        supported / probe.length < 0.5
      ) {
        ztoolkit.log(
          `[pdfparser] fallback block lacks citation evidence (dated=${dated}/${probe.length}, supported=${supported}/${probe.length}) — trying next candidate`,
        );
        continue;
      }
      refPart = candidate;
      foundFallback = true;
      ztoolkit.log(
        `[pdfparser] no heading — fallback part p${refPart[0]?.pageNum} n=${refPart.length} numbered=${numbered}`,
      );
      break;
    }
    if (!foundFallback) {
      ztoolkit.log("[pdfparser] no heading and no valid reference-like block");
      return [];
    }
  }
  onProgress(getString("parser-done"), 100);
  return refPart;
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Parse the bibliography of the PDF open in a Zotero reader.
 *
 * @param reader Zotero ReaderInstance (internals accessed defensively)
 * @param options.fromCurrentPage treat the current page as the last page
 *   (Ctrl+refresh for theses whose chapters end with their own bibliography)
 * @param options.onProgress progress callback, e.g. ("Read text 3/4", 45)
 * @returns parsed references; [] when nothing can be extracted (logged)
 */
async function parsePDFReferencesImpl(
  reader: any,
  options: PDFParseOptions = {},
  diagnostics?: PDFParseDiagnostics,
): Promise<RefItem[]> {
  const onProgress: ParseProgress = options.onProgress || (() => {});
  const probeText: ProbeTextCache = new Map();
  try {
    const viewer = await getViewerApp(reader, !!options.fromCurrentPage);
    if (!viewer) {
      if (diagnostics) diagnostics.status = "unavailable";
      ztoolkit.log("[pdfparser] PDFViewerApplication unavailable");
      return [];
    }
    const refLines = await getRefLines(
      viewer.app,
      !!options.fromCurrentPage,
      viewer.manualPage,
      onProgress,
      probeText,
      diagnostics,
    );
    if (refLines.length == 0) {
      ztoolkit.log("[pdfparser] getRefLines: 0 refLines");
      return [];
    }
    // Region selection/probes retain their established merger. Only the final
    // confirmed block may use the conservative grouped-study sequence path.
    const grouped = segmentGroupedStudyReferences(refLines);
    const merged = grouped?.refs ?? mergeSameRef(refLines);
    if (diagnostics) {
      diagnostics.segmentation = {
        strategy: grouped ? "grouped-study" : "legacy-merge",
        sourceLineCount: refLines.length,
        ...(grouped
          ? {
              entries: grouped.entries,
              decisions: grouped.decisions,
              sourceLines: refLines.map((line, lineIndex) => ({
                lineIndex,
                page: line.pageNum!,
                column: line.column!,
                x: line._x ?? line.x,
                y: line.y,
              })),
            }
          : {}),
      };
    }
    ztoolkit.log(`[pdfparser] ${merged.length} references`);
    if (merged.length == 0) {
      ztoolkit.log("[pdfparser] mergeSameRef: 0 references");
      return [];
    }
    const references: RefItem[] = [];
    // Year-first citations can be numbered ("1. 2018. ..."). Keep the
    // general number detector strict around decimals/DOIs; allow stripping
    // this form only when the complete output independently proves 1..N.
    const yearFirstNumber = (text: string) =>
      Number(
        compactLeadingDigits(text.trim()).match(
          /^[[(]?(\d{1,3})(?:[\])][.．]?|[.)．])\s+(?=(?:1\d|20)\d{2}[.\s])/,
        )?.[1] ?? 0,
      );
    const sequentialNumbers =
      merged.length >= 3 &&
      merged.every(
        (line, i) =>
          (numAtStart(line.text) || yearFirstNumber(line.text)) === i + 1,
      );
    for (let i = 0; i < merged.length; i++) {
      const line = merged[i];
      const raw = compactLeadingDigits(line.text.trim());
      // leading bibliography number: "(1)", "[12]", "12.", "1 " ...
      // ({1,3} so a leading year is never mistaken for a number)
      const numMatch = raw.match(/^[^0-9a-zA-Z]?\s*(\d{1,3})\s*[^0-9a-zA-Z]/);
      const text = (
        numAtStart(raw) > 0 ||
        (sequentialNumbers && yearFirstNumber(raw) === i + 1)
          ? raw.replace(
              /^(?:[[(]\d{1,3}[\])](?:\s*[.．])?\s*|\d{1,3}(?:\s*[.)．）]\s*|\s+))/,
              "",
            )
          : raw
      ).trim();
      const item: RefItem = {
        text,
        ...refTextToInfo(text),
        x: line._x,
        y: line.y + line.height,
        page: line.pageNum,
        number: numMatch ? Number(numMatch[1]) : i + 1,
      };
      // Keep the source link: merged text can contain a partial DOI or a
      // stray page-footer DOI, so its parsed field cannot veto the annotation.
      if (isHttpUrl(line.url)) item.url = line.url;
      references.push(item);
      if (diagnostics) {
        const printedNumber =
          numAtStart(raw) || (sequentialNumbers ? yearFirstNumber(raw) : 0);
        const sourceStart = {
          page: Number.isInteger(line.pageNum) ? line.pageNum! : null,
          x: Number.isFinite(line._x) ? line._x! : null,
          y: Number.isFinite(item.y) ? item.y! : null,
        };
        diagnostics.entries.push({
          ordinal: i + 1,
          printedNumber: printedNumber || null,
          displayNumber: item.number!,
          sourceStart,
        });
        if (Object.values(sourceStart).some((value) => value === null))
          diagnostics.warnings.push("missing-source-start-anchor");
      }
    }
    return references;
  } catch (e) {
    ztoolkit.log("[pdfparser] parse failed", e);
    if (diagnostics) {
      diagnostics.status = "error";
      diagnostics.entries = [];
      diagnostics.segmentation = undefined;
      diagnostics.warnings.push("parser-error");
    }
    return [];
  } finally {
    // Release unconsumed probes on every success, early return and failure.
    probeText.clear();
  }
}

/** Observations about extraction, never a certificate of completeness. */
export interface PDFParseDiagnostics {
  status:
    | "extracted"
    | "not-found"
    | "unavailable"
    | "partial"
    | "ambiguous"
    | "error";
  /** The existing parser does not establish complete source-line coverage. */
  completeness: "not-assessed";
  pageCount: number | null;
  searchEndPage: number | null;
  warnings: string[];
  entries: {
    ordinal: number;
    printedNumber: number | null;
    displayNumber: number;
    /** Start anchor only; not the full extent of a citation. */
    sourceStart: { page: number | null; x: number | null; y: number | null };
  }[];
  /** Attribution over selected, preprocessed lines, not raw glyph spans or
   * proof that the selector found every source bibliography line. */
  segmentation?: {
    strategy: "legacy-merge" | "grouped-study";
    sourceLineCount: number;
    entries?: GroupedStudyEntry[];
    decisions?: GroupedStudyDecision[];
    sourceLines?: {
      lineIndex: number;
      page: number;
      column: number;
      x: number;
      y: number;
    }[];
  };
  numbering: {
    kind: "none" | "numbered" | "unnumbered" | "mixed";
    missing: number[];
    duplicates: number[];
    startsAtOne: boolean | null;
    consecutive: boolean | null;
  };
}

type PDFParseOptions = {
  fromCurrentPage?: boolean;
  onProgress?: ParseProgress;
};

function diagnoseNumbering(
  entries: PDFParseDiagnostics["entries"],
): PDFParseDiagnostics["numbering"] {
  const printed = entries.flatMap((entry) =>
    entry.printedNumber === null ? [] : [entry.printedNumber],
  );
  const seen = new Set<number>(),
    duplicates = new Set<number>();
  for (const number of printed) {
    if (seen.has(number)) duplicates.add(number);
    seen.add(number);
  }
  const sorted = [...seen].sort((a, b) => a - b),
    missing: number[] = [];
  // numAtStart accepts at most three digits, bounding this gap enumeration.
  for (let i = 1; i < sorted.length; i++) {
    for (let n = sorted[i - 1] + 1; n < sorted[i] && n <= 999; n++)
      missing.push(n);
  }
  return {
    kind: !entries.length
      ? "none"
      : !printed.length
        ? "unnumbered"
        : printed.length === entries.length
          ? "numbered"
          : "mixed",
    missing,
    duplicates: [...duplicates],
    startsAtOne: printed.length ? printed[0] === 1 : null,
    consecutive: printed.length
      ? printed.every((n, i) => !i || n === printed[i - 1] + 1)
      : null,
  };
}

/** Backwards-compatible production route without the optional diagnostic report. */
export async function parsePDFReferences(
  reader: any,
  options: PDFParseOptions = {},
): Promise<RefItem[]> {
  return parsePDFReferencesImpl(reader, options);
}

/** Explicit diagnostic route using the same parser and same reference output. */
export async function parsePDFReferencesDetailed(
  reader: any,
  options: PDFParseOptions = {},
): Promise<{ refs: RefItem[]; diagnostics: PDFParseDiagnostics }> {
  const diagnostics: PDFParseDiagnostics = {
    status: "not-found",
    completeness: "not-assessed",
    pageCount: null,
    searchEndPage: null,
    warnings: [],
    entries: [],
    numbering: diagnoseNumbering([]),
  };
  const refs = await parsePDFReferencesImpl(reader, options, diagnostics);
  if (refs.length && diagnostics.status === "not-found")
    diagnostics.status = "extracted";
  diagnostics.numbering = diagnoseNumbering(diagnostics.entries);
  if (diagnostics.numbering.missing.length)
    diagnostics.warnings.push("printed-number-gap");
  if (diagnostics.numbering.duplicates.length)
    diagnostics.warnings.push("duplicate-printed-number");
  if (diagnostics.numbering.startsAtOne === false)
    diagnostics.warnings.push("printed-sequence-not-from-one");
  if (diagnostics.numbering.consecutive === false)
    diagnostics.warnings.push("nonconsecutive-printed-sequence");
  if (diagnostics.numbering.kind === "mixed")
    diagnostics.warnings.push("mixed-numbering-evidence");
  diagnostics.warnings = [...new Set(diagnostics.warnings)];
  return { refs, diagnostics };
}
