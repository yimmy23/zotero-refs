import { refTextToInfo, isHttpUrl } from "../core/text";
import type { RefItem } from "../core/types";
import { getPref } from "../utils/prefs";

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
    // same line, with sub/superscript tolerance
    if (
      line.y == lastLine.y ||
      (line.y >= lastLine.y && line.y < lastLine.y + lastLine.height) ||
      (line.y + line.height > lastLine.y &&
        line.y + line.height <= lastLine.y + lastLine.height)
    ) {
      lastLine.text += " " + line.text;
      lastLine.width += line.width;
      lastLine.url = lastLine.url || line.url;
      lastLine._height.push(line.height);
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
function mergeSameRef(input: PDFLine[]): PDFLine[] {
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

/** read one pdf.js page into merged PDFLine objects */
async function readPdfPage(pdfPage: any): Promise<PDFLine[]> {
  const textContent = await pdfPage.getTextContent();
  const items: PDFItem[] = textContent.items.filter(
    (item: PDFItem) => item.str.trim().length,
  );
  if (items.length == 0) {
    return [];
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
  onProgress(`Read text 0/${preLoadPageNum}`, 1);

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
    const lines = await readPdfPage(pdfPage);
    if (lines.length == 0) {
      continue;
    }
    pageLines[pageNum] = lines;
    const pct = ((totalPageNum - pageNum) / preLoadPageNum) * 100;
    onProgress(
      `Read text ${totalPageNum - pageNum}/${preLoadPageNum}`,
      pct > 90 ? 90 : pct,
    );
  }

  // walk backwards and split each page into "parts" (visual text blocks);
  // the bibliography may span multiple parts across pages
  const parts: PDFLine[][] = [];
  let part: PDFLine[] = [];
  let refPart: PDFLine[] = [];
  const _refPart: { done: boolean; parts: PDFLine[][] } = {
    done: false,
    parts: [],
  };
  for (let pageNum = totalPageNum - 1; pageNum >= 1; pageNum--) {
    const pdfPage = pages[pageNum].pdfPage;
    maxWidth = pdfPage._pageInfo.view[2];
    maxHeight = pdfPage._pageInfo.view[3];
    let lines: PDFLine[];
    if (pageNum in pageLines) {
      lines = [...pageLines[pageNum]];
    } else {
      lines = await readPdfPage(pdfPage);
      pageLines[pageNum] = [...lines];
      const p = totalPageNum - pageNum;
      onProgress(`Read text ${p}/${p}`, 90);
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
        /(参考文献|reference|bibliography)/i.test(text) && text.length < 20
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
          doneRefPart(part);
          part = [];
          break;
        }
        donePart(part);
        part = [];
      }
    }
    if (_refPart.done) {
      _refPart.parts.reverse().forEach((p) => {
        refPart = [...refPart, ...p];
      });
      break;
    }
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
    const numOf = (t: string) =>
      Number(t.trim().match(/^\[?(\d{1,3})\]?[.)\s]/)?.[1]) || 0;
    const lastNum = Math.max(0, ...refPart.map((l) => numOf(l.text)));
    const numberedCount = (p: PDFLine[]) =>
      p.filter((l) => numOf(l.text) > 0).length;
    const picksUp = (p: PDFLine[]) =>
      lastNum > 0 &&
      numberedCount(p) >= 3 &&
      p.some((l) => numOf(l.text) === lastNum + 1);
    const continuation = parts
      .filter(
        (p) =>
          p.length >= 3 &&
          (p[0].pageNum ?? -1) > lastRefPage &&
          (picksUp(p) || refScore(p) >= 0.3),
      )
      .sort((a, b) => (a[0].pageNum ?? 0) - (b[0].pageNum ?? 0));
    if (continuation.length) {
      // the carried-over stray lines from those pages are superseded by
      // the complete blocks (they were the running head / a fragment)
      const contPages = new Set(continuation.map((p) => p[0].pageNum));
      refPart = refPart.filter((l) => !contPages.has(l.pageNum));
    }
    for (const p of continuation) {
      ztoolkit.log(
        `[pdfparser] appending continuation part p${p[0].pageNum} n=${p.length}`,
      );
      refPart = [...refPart, ...p];
    }
  }

  onProgress("Analyze layout", 95);
  if (refPart.length == 0) {
    // no explicit References heading found — fall back to the part with
    // the most reference-typed lines
    if (parts.length == 0) {
      ztoolkit.log("[pdfparser] no text parts found");
      return [];
    }
    const partRefNum: [number, number][] = [];
    for (let i = 0; i < parts.length; i++) {
      const isRefs = parts[i].map((line) =>
        Number(getRefType(line.text) != -1),
      );
      partRefNum.push([i, isRefs.reduce((a, b) => a + b, 0)]);
    }
    const best = partRefNum.sort((a, b) => b[1] - a[1])[0][0];
    refPart = parts[best];
  }
  onProgress("Done", 100);
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
      const raw = line.text.trim();
      // leading bibliography number: "(1)", "[12]", "12.", "1 " ...
      // ({1,3} so a leading year is never mistaken for a number)
      const numMatch = raw.match(/^[^0-9a-zA-Z]?\s*(\d{1,3})\s*[^0-9a-zA-Z]/);
      const text = raw
        .replace(/^[^0-9a-zA-Z]\s*\d+\s*[^0-9a-zA-Z]/, "")
        .replace(/^\d+[.\s]?/, "")
        .trim();
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
