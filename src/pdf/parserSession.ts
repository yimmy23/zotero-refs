import { setTimeout, clearTimeout } from "../utils/window";

export interface PDFReadOptions {
  /** Absolute deadline in Date.now() milliseconds; default: 30 seconds. */
  deadline?: number;
  shouldCancel?: () => boolean;
  signal?: AbortSignal;
}

export class PDFReadInterrupted extends Error {
  constructor(
    readonly reason: "deadline" | "cancelled" | "source-changed",
    readonly phase: string,
  ) {
    super(`pdf-${reason === "deadline" ? "deadline-exceeded" : reason}`);
  }
}

/** Own only our waits: pdf.js loading tasks/pages belong to Zotero's reader. */
export class PDFReadSession {
  private readonly deadline: number;
  private sameSource: () => boolean;
  private disposed = false;
  private pending = new Set<() => void>();

  constructor(
    reader: any,
    private options: PDFReadOptions = {},
  ) {
    this.deadline = Number.isFinite(options.deadline)
      ? options.deadline!
      : Date.now() + 30_000;
    try {
      const itemID = reader?.itemID;
      const internal = reader?._internalReader;
      this.sameSource = () =>
        reader?.itemID === itemID &&
        (internal == null || reader?._internalReader === internal);
    } catch {
      this.sameSource = () => false;
    }
  }

  check(phase: string): void {
    if (
      this.disposed ||
      this.options.signal?.aborted ||
      this.options.shouldCancel?.()
    )
      throw new PDFReadInterrupted("cancelled", phase);
    let same = false;
    try {
      same = this.sameSource();
    } catch {
      // Dead reader wrappers are a source change, not a page read failure.
    }
    if (!same) throw new PDFReadInterrupted("source-changed", phase);
    if (Date.now() >= this.deadline)
      throw new PDFReadInterrupted("deadline", phase);
  }

  /** Capture identity before the first viewer wait; latch initialized values. */
  bind(reader: any, view: any, app: any): void {
    this.check("viewer");
    const initial = this.sameSource;
    const internal = reader._internalReader;
    const loading = app.pdfLoadingTask;
    const viewer = app.pdfViewer;
    const win = view._iframeWindow;
    let document = app.pdfDocument;
    let pages = viewer?._pages?.length ? viewer._pages : undefined;
    let proxies: any[] | undefined;
    this.sameSource = () => {
      if (
        !initial() ||
        reader._internalReader !== internal ||
        (internal?._primaryView ??
          internal?._lastView ??
          internal?._views?.[0]) !== view ||
        view._iframeWindow !== win ||
        win?.closed ||
        win?.PDFViewerApplication !== app ||
        app.pdfLoadingTask !== loading ||
        app.pdfViewer !== viewer ||
        (document != null && app.pdfDocument !== document) ||
        (pages != null && viewer._pages !== pages)
      )
        return false;
      document ??= app.pdfDocument;
      if (pages == null && viewer?._pages?.length) pages = viewer._pages;
      if (pages && !proxies) proxies = pages.map((page: any) => page.pdfPage);
      if (proxies) {
        if (pages.length !== proxies.length) return false;
        for (let i = 0; i < proxies.length; i++) {
          // Page proxies may initially be null until pagesPromise resolves.
          if (proxies[i] != null && pages[i]?.pdfPage !== proxies[i])
            return false;
          proxies[i] ??= pages[i]?.pdfPage;
        }
      }
      return true;
    };
    this.check("viewer");
  }

  /** Every asynchronous reader operation resumes only while this run is live. */
  wait<T>(start: () => T | PromiseLike<T>, phase: string): Promise<T> {
    this.check(phase);
    return new Promise<T>((resolve, reject) => {
      let timer: number | undefined;
      let finished = false;
      let signal = this.options.signal;
      const finish = (ok: boolean, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        signal = undefined;
        this.pending.delete(abort);
        if (ok) resolve(value as T);
        else reject(value);
      };
      const abort = () =>
        finish(false, new PDFReadInterrupted("cancelled", phase));
      const poll = () => {
        try {
          this.check(phase);
          timer = setTimeout(
            poll,
            Math.min(50, Math.max(1, this.deadline - Date.now())),
          );
        } catch (error) {
          finish(false, error);
        }
      };
      this.pending.add(abort);
      signal?.addEventListener("abort", abort, { once: true });
      poll();
      if (finished) return;
      try {
        Promise.resolve(start()).then(
          (value) => {
            // A late pdf.js result cannot revive a cancelled parser, change
            // diagnostics, populate probe caches, or run annotation processing.
            if (finished) return;
            try {
              this.check(phase);
              finish(true, value);
            } catch (error) {
              finish(false, error);
            }
          },
          (error) => finish(false, error),
        );
      } catch (error) {
        finish(false, error);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const abort of this.pending) abort();
    this.pending.clear();
    // Uncancellable reader-owned pdf.js promises may settle later. Their
    // handlers retain neither the reader snapshot nor UI cancel callbacks.
    this.sameSource = () => false;
    this.options = {};
  }
}
