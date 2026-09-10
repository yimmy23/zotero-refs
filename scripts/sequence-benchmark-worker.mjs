/** Internal benchmark worker. All paths and source hashes come from the parent job. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import console from "node:console";
import process from "node:process";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => globalThis.structuredClone(value);
const writeJSON = (file, value) =>
  fs.writeFile(file, JSON.stringify(value) + "\n", { flag: "wx" });
let blockedRequests = 0;
const denyNetwork = () => {
  blockedRequests++;
  throw new Error("benchmark-network-disabled");
};
// PDFs are opened from Uint8Array; CMaps/fonts are local files. These guards
// reject accidental networking through the Node/browser interfaces used here.
http.request = http.get = https.request = https.get = denyNetwork;
net.connect = net.createConnection = tls.connect = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();
globalThis.fetch = async () => denyNetwork();
globalThis.XMLHttpRequest = class {
  constructor() {
    denyNetwork();
  }
};
globalThis.WebSocket = class {
  constructor() {
    denyNetwork();
  }
};

function readCounts() {
  return { text: {}, annotations: {}, pages: {} };
}
function count(reads, kind, page) {
  reads[kind][page] = (reads[kind][page] ?? 0) + 1;
}
function summarizeReads(reads) {
  return Object.fromEntries(
    Object.entries(reads).map(([kind, values]) => {
      const total = Object.values(values).reduce(
        (sum, value) => sum + value,
        0,
      );
      const uniquePages = Object.keys(values).length;
      return [
        kind,
        {
          total,
          uniquePages,
          duplicateCalls: total - uniquePages,
          perPDFPage: values,
        },
      ];
    }),
  );
}
function sourcePage(page, content) {
  return {
    page: page.pageNumber - 1,
    origin: [
      Math.min(page.view[0], page.view[2]),
      Math.min(page.view[1], page.view[3]),
    ],
    width: Math.abs(page.view[2] - page.view[0]),
    height: Math.abs(page.view[3] - page.view[1]),
    items: content.items.map((item) => ({
      str: typeof item.str === "string" ? item.str : "",
      transform: Array.isArray(item.transform) ? item.transform.slice() : [],
      width: item.width,
      height: item.height,
      fontName: item.fontName,
      dir: item.dir,
    })),
  };
}

async function main() {
  if (process.argv.length !== 3)
    throw new Error("Internal use: sequence-benchmark-worker.mjs JOB.json");
  const job = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  const bytes = await fs.readFile(job.path);
  if (hash(bytes) !== job.sourcePDFSHA256)
    throw new Error("PDF changed after manifest validation");
  const pdfjs = await import(
    pathToFileURL(path.join(job.pdfjsRoot, "legacy/build/pdf.mjs")).href
  );
  const { DOMParser } = await import(job.domModule);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(job.pdfjsRoot, "legacy/build/pdf.worker.mjs"),
  ).href;
  const rawPages = new Map();
  const rawAnnotations = new Map();
  let documentPages = 0;
  for (const engine of ["old", "new"]) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const reads = readCounts();
    const logs = [];
    let task, doc;
    const output = {
      schema: 1,
      engine,
      key: job.key,
      path: job.path,
      sourcePDFSHA256: job.sourcePDFSHA256,
      sourceVersion: job[engine],
      pdfjsVersion: job.pdfjsVersion,
      startedAt,
      pages: null,
      refs: [],
      count: 0,
      status: "error",
      rawPages: path.join(job.directory, "pages.json"),
      fromPage: job.fromPage,
    };
    globalThis.Zotero = {
      Promise: {
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    };
    globalThis.ztoolkit = {
      log: (...args) => {
        if (logs.length < 500)
          logs.push(args.map(String).join(" ").slice(0, 2000));
      },
      getDOMParser: () => ({
        parseFromString: (text) => {
          const parsed = new DOMParser({ onError: () => {} }).parseFromString(
            text,
            "text/html",
          );
          return {
            body: { textContent: parsed.documentElement?.textContent ?? "" },
          };
        },
      }),
    };
    try {
      if (
        hash(await fs.readFile(job[engine].bundle)) !== job[engine].bundleSHA256
      )
        throw new Error("Frozen bundle hash mismatch");
      const module = await import(pathToFileURL(job[engine].bundle).href);
      task = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        cMapUrl: path.join(job.pdfjsRoot, "cmaps") + path.sep,
        cMapPacked: true,
        standardFontDataUrl:
          path.join(job.pdfjsRoot, "standard_fonts") + path.sep,
        disableFontFace: true,
        isEvalSupported: false,
        useSystemFonts: false,
        useWorkerFetch: false,
        verbosity: 0,
        stopAtErrors: false,
      });
      doc = await task.promise;
      output.pages = doc.numPages;
      documentPages = doc.numPages;
      if (job.fromPage !== null && job.fromPage > doc.numPages)
        throw new Error("from-page exceeds document page count");
      const pages = [];
      // Reader page proxies exist before parsing in the Zotero-shaped adapter.
      // No getTextContent call happens during this loading phase.
      for (let number = 1; number <= doc.numPages; number++) {
        count(reads, "pages", number);
        const page = await doc.getPage(number);
        pages.push({
          pdfPage: {
            view: page.view.slice(),
            _pageInfo: { view: page.view.slice() },
            getTextContent: async (...args) => {
              count(reads, "text", number);
              const content = await page.getTextContent(...args);
              if (!rawPages.has(number - 1))
                rawPages.set(number - 1, sourcePage(page, content));
              return clone(content); // Legacy URL annotation mutations stay private.
            },
            getAnnotations: async (...args) => {
              count(reads, "annotations", number);
              const annotations = await page.getAnnotations(...args);
              if (!rawAnnotations.has(number - 1))
                rawAnnotations.set(number - 1, clone(annotations));
              return clone(annotations);
            },
          },
        });
      }
      output.loadMs = performance.now() - started;
      const app = {
        pdfLoadingTask: { promise: Promise.resolve(doc) },
        pdfDocument: { numPages: doc.numPages },
        pdfViewer: { pagesPromise: Promise.resolve(), _pages: pages },
        page: job.fromPage ?? doc.numPages,
      };
      const reader = {
        _internalReader: {
          _primaryView: { _iframeWindow: { PDFViewerApplication: app } },
        },
      };
      const parseStarted = performance.now();
      if (engine === "old") {
        output.refs = await module.parsePDFReferences(reader, {
          fromCurrentPage: job.fromPage !== null,
        });
        output.status = logs.some((line) =>
          line.includes("[pdfparser] parse failed"),
        )
          ? "error"
          : output.refs.length
            ? "success"
            : "empty";
      } else {
        const parsed = await module.parseSequencePDFReferences(reader, {
          fromCurrentPage: job.fromPage !== null,
        });
        output.refs = parsed.refs;
        output.extraction = parsed.extraction;
        for (const page of parsed.pages) rawPages.set(page.page, page);
        output.status =
          parsed.extraction.status !== "ok"
            ? parsed.extraction.status
            : output.refs.length
              ? "success"
              : "empty";
      }
      output.parseMs = performance.now() - parseStarted;
      output.count = output.refs.length;
    } catch (error) {
      output.error = String(error?.stack ?? error);
    } finally {
      try {
        if (doc) await doc.destroy();
        else if (task) await task.destroy();
      } catch (error) {
        output.destroyError = String(error);
        output.status = "cleanup-error";
      }
      output.totalMs = performance.now() - started;
      output.completedAt = new Date().toISOString();
      output.reads = summarizeReads(reads);
      output.logs = logs;
      output.networkRequestsBlocked = blockedRequests;
      if (blockedRequests) output.status = "network-attempt-blocked";
      await writeJSON(path.join(job.directory, `${engine}.json`), output);
    }
  }
  await writeJSON(path.join(job.directory, "pages.json"), {
    schema: 1,
    sourcePDFSHA256: job.sourcePDFSHA256,
    documentPages,
    capturedPages: rawPages.size,
    complete: documentPages > 0 && rawPages.size === documentPages,
    pages: [...rawPages.values()].sort((a, b) => a.page - b.page),
    annotations: [...rawAnnotations].map(([page, items]) => ({ page, items })),
  });
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
