import { extractSequenceReferences } from "./sequenceCore";
import { refTextToInfo } from "../core/text";
import type { RefItem } from "../core/types";
import type { SequenceExtraction, SequencePage } from "./sequenceTypes";

export interface SequenceReaderOptions {
  fromCurrentPage?: boolean;
  shouldCancel?: () => boolean;
  onProgress?: (pagesRead: number, totalPages: number) => void;
}

export interface SequenceReaderResult {
  refs: RefItem[];
  extraction: SequenceExtraction;
  /** Exactly the original run strings and transforms read from pdf.js. */
  pages: SequencePage[];
}

/** Explicit opt-in reader path; source parsing is independent of legacy lines. */
export async function parseSequencePDFReferences(
  reader: any,
  options: SequenceReaderOptions = {},
): Promise<SequenceReaderResult> {
  const pages: SequencePage[] = [];
  let totalPages: number | undefined;
  let sameSource = () => true;
  const cancelled = () => {
    if (options.shouldCancel?.()) throw new Error("sequence-cancelled");
    if (!sameSource()) throw new Error("sequence-source-changed");
  };
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    cancelled();
    // Zotero.Promise.delay also works in the offline adapter; avoid global timers.
    let done = false;
    const timer = (async () => {
      for (let i = 0; i < 300 && !done; i++) {
        await Zotero.Promise.delay(100);
        if (!done) cancelled();
      }
      if (!done) throw new Error("sequence-read-timeout");
      return new Promise<never>(() => {});
    })();
    try {
      const value = await Promise.race([promise, timer]);
      cancelled();
      return value;
    } finally {
      done = true;
    }
  };
  try {
    cancelled();
    const internal = reader?._internalReader;
    const view =
      internal?._primaryView ?? internal?._lastView ?? internal?._views?.[0];
    const app = view?._iframeWindow?.PDFViewerApplication;
    if (!app) throw new Error("sequence-reader-unavailable");
    const itemID = reader.itemID;
    const initialLoading = app.pdfLoadingTask;
    const initialViewer = app.pdfViewer;
    const initialDocument = app.pdfDocument;
    const initialPages = initialViewer?._pages;
    const currentPage = options.fromCurrentPage ? app.page - 1 : undefined;
    sameSource = () =>
      reader._internalReader === internal &&
      reader.itemID === itemID &&
      (internal?._primaryView ??
        internal?._lastView ??
        internal?._views?.[0]) === view &&
      view._iframeWindow?.PDFViewerApplication === app &&
      app.pdfLoadingTask === initialLoading &&
      app.pdfViewer === initialViewer &&
      (initialDocument === undefined ||
        initialDocument === null ||
        app.pdfDocument === initialDocument) &&
      (initialPages === undefined ||
        initialPages === null ||
        app.pdfViewer?._pages === initialPages);
    if (app.pdfLoadingTask?.promise) await wait(app.pdfLoadingTask.promise);
    if (app.pdfViewer?.pagesPromise) await wait(app.pdfViewer.pagesPromise);
    const document = app.pdfDocument;
    const pageViews = app.pdfViewer?._pages;
    const proxies = pageViews?.map((p: any) => p.pdfPage);
    const initialSource = sameSource;
    sameSource = () =>
      initialSource() &&
      app.pdfDocument === document &&
      app.pdfViewer?._pages === pageViews;
    const count = document?.numPages ?? proxies?.length;
    if (!Number.isInteger(count) || count <= 0)
      throw new Error("sequence-invalid-page-count");
    totalPages = count;
    if (count > 500) throw new Error("sequence-page-budget");
    let runCount = 0;
    let characterCount = 0;
    for (let i = 0; i < count; i++) {
      cancelled();
      const pdfPage =
        proxies?.[i] ??
        (document?.getPage ? await wait(document.getPage(i + 1)) : undefined);
      if (!pdfPage?.getTextContent)
        throw new Error("sequence-page-unavailable");
      const content = await wait<any>(pdfPage.getTextContent());
      const view = pdfPage.view ?? pdfPage._pageInfo?.view;
      if (
        !Array.isArray(content?.items) ||
        !view ||
        view.length < 4 ||
        ![view[0], view[1], view[2], view[3]].every(Number.isFinite) ||
        view[0] === view[2] ||
        view[1] === view[3]
      )
        throw new Error("sequence-page-shape");
      runCount += content.items.length;
      if (runCount > 250000) throw new Error("sequence-run-budget");
      characterCount += content.items.reduce(
        (sum: number, item: any) =>
          sum + (typeof item?.str === "string" ? item.str.length : 0),
        0,
      );
      if (characterCount > 8_000_000)
        throw new Error("sequence-character-budget");
      pages.push({
        page: i,
        origin: [Math.min(view[0], view[2]), Math.min(view[1], view[3])],
        width: Math.abs(view[2] - view[0]),
        height: Math.abs(view[3] - view[1]),
        items: content.items.map((item: any) => ({
          str: typeof item.str === "string" ? item.str : "",
          transform: Array.isArray(item.transform)
            ? item.transform.slice()
            : [],
          width: item.width,
          height: item.height,
          fontName: item.fontName,
          dir: item.dir,
        })),
      });
      options.onProgress?.(i + 1, count);
      await Zotero.Promise.delay(0);
    }
    cancelled();
    const extraction = extractSequenceReferences(pages, {
      fromPage: currentPage,
      totalPages: count,
    });
    cancelled();
    const refs: RefItem[] = extraction.entries.map((entry) => ({
      ...refTextToInfo(entry.text),
      text: entry.text,
      ...(entry.printedNumber === undefined
        ? {}
        : { number: entry.printedNumber }),
      page: entry.anchor.page,
      x: entry.anchor.x,
      y: entry.anchor.y,
    }));
    return { refs, extraction, pages };
  } catch (error) {
    const extraction = extractSequenceReferences([]);
    const code = String(error instanceof Error ? error.message : error);
    extraction.status =
      code === "sequence-cancelled"
        ? "cancelled"
        : /budget/.test(code)
          ? "limited"
          : code === "sequence-reader-unavailable"
            ? "unsupported"
            : "error";
    extraction.metrics.pages = pages.length;
    extraction.metrics.runs = pages.reduce(
      (total, page) => total + page.items.length,
      0,
    );
    extraction.coverage = {
      providedPages: pages.map((p) => p.page),
      expectedPages: totalPages,
      complete: false,
    };
    extraction.diagnostics.push({
      code,
      lineIDs: [],
      severity: "error",
    });
    return { refs: [], extraction, pages };
  }
}
