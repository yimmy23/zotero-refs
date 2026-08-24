import { refTextToInfo, isHttpUrl } from "../core/text";
import type { RefItem } from "../core/types";
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
  for (let i = 0; i < refRegex.length; i++) {
    const flags = new Set(
      refRegex[i].map(
        (regex) =>
          regex.test(text.trim()) || regex.test(text.replace(/\s+/g, "")),
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
    // same line, with sub/superscript tolerance
    if (
      line.y == lastLine.y ||
      (line.y >= lastLine.y && line.y < lastLine.y + lastLine.height) ||
      (line.y + line.height > lastLine.y &&
        line.y + line.height <= lastLine.y + lastLine.height) ||
      gutterNumber
    ) {
      lastLine.text += " " + line.text;
      lastLine.width += line.width;
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
  return lines;
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
    /^[[(]?(\d{1,3})(?:\s*[\].)．）]\s*(?=[^\d\s.])|\s+(?=[\p{L}“"']))/u,
  );
  return m ? Number(m[1]) : 0;
}

/**
 * "1 0 . Hosny" → "10 . Hosny"; "[ 1 2 ]" → "[12]". Only before the
 * number's punctuation — a bare "1 7 insight.jci.org" is a spaced page
 * number in a running footer, and closing it up once turned it into entry
 * 17 of a list that was waiting for 17.
 */
function compactLeadingDigits(t: string): string {
  return t.replace(
    /^([[(]?)(\d)(?:\s(\d))?(?:\s(\d))?(?=\s?[\].)．）])/,
    (_, b, a, c, d) => `${b}${a}${c ?? ""}${d ?? ""}`,
  );
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
  const t = text.trim();
  const c = t.replace(/\s+/g, "");
  if (TAIL_HEADING.test(t) || TAIL_HEADING_COMPACT.test(c)) return "heading";
  if (TAIL_BOILER.test(t) || TAIL_BOILER_COMPACT.test(c)) return "boilerplate";
  return null;
}

/**
 * A reference line that ends the way complete entries end: page range,
 * volume:pages, a DOI / URL / PMID / e-locator, or a closing bracket
 * ("[PubMed: …]"). Deliberately NOT a bare year or number — titles end in
 * those ("Cancer statistics, 2019", "RECIST 1.1", "COVID-19").
 */
const ENTRY_END =
  /(\d[-–‒]\d+\.?|;\s*\d+(?:\s*\(\d+\))?\s*:\s*\d+\.?|\]\.?|\bdoi[:\s]*\S+|https?:\/\/\S+|\bPMID:?\s*\d+\.?|\bPMC\d+\.?|\be\d{4,}\.?|print\]\.?)\s*$/i;

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
  ctx: { isLast: boolean; strayed: boolean; firstWidth: number },
): Verdict {
  const pp = prev.pageNum ?? 0;
  const lp = line.pageNum ?? 0;
  const closes =
    ctx.isLast && ENTRY_END.test(prev.text) && startsNewBlock(line.text);
  if (lp !== pp) {
    if (lp < pp) return "stray";
    return closes ? "end" : "accept";
  }
  // floor the unit so PDFs that report tiny text heights (some OCR text
  // layers say 1) do not reject every continuation line
  const h = Math.max(prev.height, line.height, 6);
  const px = absX(prev);
  const lx = absX(line);
  if (line.y < prev.y) {
    if (abs(lx - px) < 5 * h && prev.y - line.y < 4.5 * h) {
      return closes ? "end" : "accept";
    }
    return "stray";
  }
  if (lx > px + 4 * h) {
    // a one- or two-letter run up there is a logo ("ll"), not a column
    if (line.text.replace(/\s+/g, "").length < 4) return "stray";
    if (!ctx.isLast) return "accept";
    if (ctx.strayed) return "stray";
    const w = ctx.firstWidth;
    if (w > 0 && (line.width < 0.5 * w || line.width > 1.3 * w)) {
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
    lines.reduce((acc, l) => {
      const t = l.text.trim();
      if (!acc) return t;
      return acc.replace(/-$/, "") + (acc.endsWith("-") ? "" : " ") + t;
    }, "");
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
      (n === expected + 1 && cur && joinLines(entryLines).length >= 40)
    ) {
      closeEntry();
      cur = { ...line, text: text.trim() };
      entryLines = [line];
      last = line;
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
    const ctx = { isLast, strayed, firstWidth: cur.width };
    let verdict: Verdict = continuationVerdict(last, line, ctx);
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
    const noise = out.length > 1 ? tailNoiseKind(text) : null;
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
        (lp > pp && ENTRY_END.test(last.text))
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

function mergeSameRef(input: PDFLine[]): PDFLine[] {
  const numbered = mergeNumberedRefs(input);
  if (numbered) {
    ztoolkit.log(`[pdfparser] numbered merge -> ${numbered.length}`);
    return numbered;
  }
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
  ztoolkit.log("[pdfparser] mergeSameRef indent", indent);
  const refType = getRefType(firstLine.text);
  let ref: PDFLine | undefined;
  for (let i = 0; i < refLines.length; i++) {
    const line = refLines[i] as PDFLine;
    const text = line.text;
    const lineRefType = getRefType(text);
    if (
      // numbered types are reliable — skip other checks, carefully
      (lineRefType == refType && refType <= 2) ||
      (indent == 0 &&
        lineRefType != -1 &&
        lineRefType == refType &&
        abs(firstX - line.x) < (abs(indent) || line.height) * 0.5) ||
      (indent != 0 &&
        lineRefType == refType &&
        _refLines.find(
          (_line) =>
            line != _line &&
            (line.x - _line.x) * indent > 0 &&
            abs(line.x - _line.x) >= abs(indent) &&
            abs(abs(line.x - _line.x) - abs(indent)) < 2 * line.height,
        ) !== undefined)
    ) {
      ref = line;
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
      ref.text =
        ref.text.replace(/-$/, "") + (ref.text.endsWith("-") ? "" : " ") + text;
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

/** do rectangles A and B geometrically intersect */
function isIntersect(A: Box, B: Box): boolean {
  if (
    B.right < A.left ||
    B.left > A.right ||
    B.bottom > A.top ||
    B.top < A.bottom
  ) {
    return false;
  }
  return true;
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
async function hasLineNumbers(pages: any[]): Promise<boolean> {
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
      if (findLineNumbers(tc.items).size) return true;
    } catch {
      // unreadable page — no evidence
    }
  }
  return false;
}

/** read one pdf.js page into merged PDFLine objects */
async function readPdfPage(
  pdfPage: any,
  stripLineNumbers = false,
): Promise<PDFLine[]> {
  const textContent = await pdfPage.getTextContent();
  let items: PDFItem[] = textContent.items.filter(
    (item: PDFItem) => item.str.trim().length,
  );
  if (items.length == 0) {
    return [];
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
  return mergeSameLine(items);
}

/**
 * Get the pdf.js PDFViewerApplication from a Zotero 7 reader, polling for
 * up to ~5s while the internal view boots. Resolves null when unavailable.
 */
async function getViewerApp(reader: any): Promise<any | null> {
  for (let i = 0; i < 25; i++) {
    try {
      const internal = (reader as any)?._internalReader;
      const view =
        internal?._primaryView ?? internal?._lastView ?? internal?._views?.[0];
      const app = view?._iframeWindow?.PDFViewerApplication;
      if (app?.pdfLoadingTask && app?.pdfViewer) {
        return app;
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

/**
 * Walk the PDF backwards page by page and return the lines belonging to the
 * bibliography. See the class comment for the heuristics involved.
 */
async function getRefLines(
  app: any,
  fromCurrentPage: boolean,
  onProgress: ParseProgress,
): Promise<PDFLine[]> {
  await app.pdfLoadingTask.promise;
  await app.pdfViewer.pagesPromise;
  const pages: any[] = app.pdfViewer._pages;
  if (!pages?.length) {
    ztoolkit.log("[pdfparser] no pages");
    return [];
  }
  const pageLines: Record<number, PDFLine[]> = {};
  let maxWidth = 0;
  let maxHeight = 0;
  const lineNumbered = await hasLineNumbers(pages);
  if (lineNumbered)
    ztoolkit.log("[pdfparser] manuscript line numbers detected");
  // Ctrl+refresh support for theses: treat the current page as the last
  // page, so the bibliography of the current chapter is found
  let offset = 0;
  if (fromCurrentPage) {
    offset = pages.length - app.page;
  }
  const totalPageNum = pages.length - offset;
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
    const lines = await readPdfPage(pdfPage, lineNumbered);
    if (lines.length == 0) {
      continue;
    }
    pageLines[pageNum] = lines;
    const pct = ((totalPageNum - pageNum) / preLoadPageNum) * 100;
    onProgress(
      `${getString("parser-read-text")} ${totalPageNum - pageNum}/${preLoadPageNum}`,
      pct > 90 ? 90 : pct,
    );
  }

  // walk backwards and split each page into "parts" (visual text blocks);
  // the bibliography may span multiple parts across pages
  const parts: PDFLine[][] = [];
  let part: PDFLine[] = [];
  let refPart: PDFLine[] = [];
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
    /^(\d+[.．]?)?(references?|referencelist|bibliography|参考文献|literaturecited|workscited|references?andnotes|notesandreferences)$/i;
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
    if (pageNum in pageLines) {
      lines = [...pageLines[pageNum]];
    } else {
      lines = await readPdfPage(pdfPage, lineNumbered);
      pageLines[pageNum] = [...lines];
      const p = totalPageNum - pageNum;
      onProgress(`${getString("parser-read-text")} ${p}/${p}`, 90);
    }
    if (lines.length == 0) {
      continue;
    }

    // remove repeated journal headers / footers / page numbers:
    // same text (page numbers normalized away) at the same position on a
    // different page. Lines fully inside the central 100% body area
    // (20%..80% both axes) are protected and never removed.
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
    lines.forEach((line) => {
      // body-area protection
      if (
        (line.x / maxWidth > 0.2 &&
          line.y / maxHeight > 0.2 &&
          (line.x + line.width) / maxWidth < 0.8 &&
          (line.y + line.height) / maxHeight < 0.8) ||
        line.same
      ) {
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
          if (isSamePosition(line, _line) && isSameText(line, _line)) {
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
      return /^(Table|Fig|Figure).*\d/i.test(text);
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
      text = text.replace(/\s+/g, "");
      return (
        /(参考文献|reference|bibliography)/i.test(text) &&
        text.length < 20 &&
        // "References (160–200)" in a supplementary-materials list
        !/reference[s]?\(?\d/i.test(text)
      );
    };
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
      // false heading (Science's supplementary list says "References
      // (160–200)", box titles mention "reference"…): the block under a
      // real heading looks like references
      const refLike =
        part.filter((l) => getRefType(l.text) != -1).length / part.length;
      const startsAtOne = part.some((l) => numAtStart(l.text) === 1);
      if ((part.length < 3 && !startsAtOne) || refLike < 0.25) {
        ztoolkit.log(
          `[pdfparser] ignoring heading: block below is not references (n=${part.length}, refLike=${refLike.toFixed(2)})`,
        );
        return;
      }
      _refPart.parts.push(part);
      const res = part[0].text.trim().match(/^\d+/);
      _refPart.done = !(res && res[0] != "1");
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
          _refPart.heading = lines[i - 1];
          doneRefPart(part);
          part = [];
          break;
        }
        donePart(part);
        part = [];
      }
    }
    if (_refPart.done) {
      let lines: PDFLine[] = [];
      _refPart.parts.reverse().forEach((p) => {
        lines = [...lines, ...p];
      });
      const headingText = (_refPart.heading?.text ?? "").replace(/\s+/g, "");
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
    // numbered bibliographies: the continuation must pick up at the next
    // number ("11." on page N → a line starting "12." / "[12]" on N+1)
    // strict form (a real entry start, not a stray "839." page fragment)
    const numOf = (t: string) => numAtStart(t);
    let lastNum = Math.max(0, ...refPart.map((l) => numOf(l.text)));
    const numberedCount = (p: PDFLine[]) =>
      p.filter((l) => numOf(l.text) > 0).length;
    const picksUp = (p: PDFLine[]) =>
      lastNum > 0 &&
      numberedCount(p) >= 2 &&
      p.some((l) => numOf(l.text) === lastNum + 1);
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
        lastNum = Math.max(0, ...refPart.map((l) => numOf(l.text)));
      }
    }

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
    for (const pg of [...byPage.keys()].sort((a, b) => a - b)) {
      const lines = byPage
        .get(pg)!
        .sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || b.y - a.y);
      if (
        lines.length >= 3 &&
        (lastNum > 0 ? picksUp(lines) : refScore(lines) >= 0.5)
      ) {
        continuation.push(lines);
        // the next page must pick up where THIS page ends, not where the
        // heading page ended — double-spaced manuscripts split every page
        // into parts, so nothing but this step carries the count forward
        lastNum = Math.max(lastNum, ...lines.map((l) => numOf(l.text)));
      } else if (continuation.length) {
        break; // the list ended on the previous page
      }
    }
    if (continuation.length) {
      // the carried-over stray lines from those pages are superseded by
      // the complete blocks (they were the running head / a fragment)
      const contPages = new Set(continuation.map((p) => p[0].pageNum));
      refPart = refPart.filter((l) => !contPages.has(l.pageNum));
    }
    for (const p of continuation) {
      ztoolkit.log(
        `[pdfparser] appending continuation page p${p[0].pageNum} n=${p.length}`,
      );
      refPart = [...refPart, ...p];
    }
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
    const [best, bestNumbered, bestRefLike] = partRefNum[0];
    // nothing that looks like a bibliography anywhere (conference
    // abstract, poster, letter): return empty rather than one junk entry
    if (
      bestNumbered < 3 &&
      (parts[best].length < 3 || bestRefLike / parts[best].length < 0.5)
    ) {
      ztoolkit.log("[pdfparser] no heading and no reference-like block");
      return [];
    }
    refPart = parts[best];
    if (bestNumbered >= 3) {
      const start = findNumberedStart(refPart, refPart.length);
      if (start > 0) refPart = refPart.slice(start);
    }
    ztoolkit.log(
      `[pdfparser] no heading — fallback part p${refPart[0]?.pageNum} n=${refPart.length} numbered=${bestNumbered}`,
    );
    // A numbered block is not automatically a bibliography: author
    // affiliation lists, statistics tables, search strategies and section
    // headings all number their lines too. With no heading to trust,
    // demand the one thing every real reference carries — a publication
    // year. (mergeSameRef mutates the lines it merges, so score a copy.)
    const probe = mergeSameRef(refPart.map((l) => ({ ...l })));
    const dated = probe.filter((e) =>
      /\b(1[89]|20)\d{2}\b/.test(e.text),
    ).length;
    if (!probe.length || dated / probe.length < 0.5) {
      ztoolkit.log(
        `[pdfparser] fallback block carries no publication years (${dated}/${probe.length}) — not a bibliography`,
      );
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
export async function parsePDFReferences(
  reader: any,
  options: { fromCurrentPage?: boolean; onProgress?: ParseProgress } = {},
): Promise<RefItem[]> {
  const onProgress: ParseProgress = options.onProgress || (() => {});
  try {
    const app = await getViewerApp(reader);
    if (!app) {
      ztoolkit.log("[pdfparser] PDFViewerApplication unavailable");
      return [];
    }
    const refLines = await getRefLines(
      app,
      !!options.fromCurrentPage,
      onProgress,
    );
    if (refLines.length == 0) {
      ztoolkit.log("[pdfparser] getRefLines: 0 refLines");
      return [];
    }
    const merged = mergeSameRef(refLines);
    ztoolkit.log(`[pdfparser] ${merged.length} references`);
    if (merged.length == 0) {
      ztoolkit.log("[pdfparser] mergeSameRef: 0 references");
      return [];
    }
    const references: RefItem[] = [];
    for (let i = 0; i < merged.length; i++) {
      const line = merged[i];
      const raw = compactLeadingDigits(line.text.trim());
      // leading bibliography number: "(1)", "[12]", "12.", "1 " ...
      // ({1,3} so a leading year is never mistaken for a number)
      const numMatch = raw.match(/^[^0-9a-zA-Z]?\s*(\d{1,3})\s*[^0-9a-zA-Z]/);
      const text = (
        numAtStart(raw) > 0
          ? raw.replace(/^[[(]?\d{1,3}(?:\s*[\].)．）]\s*|\s+)/, "")
          : raw
              .replace(/^[^0-9a-zA-Z]\s*\d+\s*[^0-9a-zA-Z]/, "")
              .replace(/^\d+[.\s]?/, "")
      ).trim();
      const item: RefItem = {
        text,
        ...refTextToInfo(text),
        x: line._x,
        y: line.y + line.height,
        page: line.pageNum,
        number: numMatch ? Number(numMatch[1]) : i + 1,
      };
      // a link annotation on the line beats the URL parsed from the text
      if (line.url) {
        item.url = line.url;
      }
      references.push(item);
    }
    return references;
  } catch (e) {
    ztoolkit.log("[pdfparser] parse failed", e);
    return [];
  }
}
