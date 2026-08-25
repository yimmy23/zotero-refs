/**
 * DEV-BUILD-ONLY remote eval endpoint for closed-loop debugging.
 *
 * Registered on Zotero's localhost-only connector server (port 23119)
 * and ONLY when the bundle was built with NODE_ENV=development — the
 * production xpi never contains an active endpoint (the whole module is
 * a no-op there). A shared-secret token is still required per request.
 */

import { libraryIndex } from "../core/libmatch";
import { refStorage } from "../core/storage";
import { parsePDFReferences } from "../pdf/parser";
import { refForCitation, toMainWindowRect } from "../pdf/readerLinks";
import { refsForReader } from "../pdf/readerHook";
import { openalex } from "../sources/openalex";
import { crossref } from "../sources/crossref";

const TOKEN = "refs-dev-7f3fa390";

export function registerDevEval() {
  if (__env__ !== "development") return;
  void registerWhenReady();
}

/** Zotero 10 loads the server module after plugin startup — wait for it */
async function registerWhenReady() {
  // stage log on disk — scaffold serve swallows Zotero's stdout
  let logbuf = "";
  const report = (msg: string) => {
    logbuf += `${new Date().toISOString()} ${msg}\n`;
    try {
      const iou = (globalThis as any).IOUtils;
      const pu = (globalThis as any).PathUtils;
      void iou?.writeUTF8(
        pu.join(Zotero.DataDirectory.dir, "dev-eval-status.log"),
        logbuf,
      );
    } catch {
      // diagnostics only
    }
  };
  try {
    report("start");
    await (Zotero as any).initializationPromise;
    report("init done");
    let endpoints: any;
    for (let i = 0; i < 150; i++) {
      try {
        endpoints = (Zotero as any).Server?.Endpoints;
      } catch (e) {
        if (!i) report(`Server getter threw: ${e}`);
      }
      if (endpoints) break;
      await Zotero.Promise.delay(200);
    }
    if (!endpoints) {
      report("endpoints unavailable after 30s");
      ztoolkit.log("[devEval] Zotero.Server not available");
      return;
    }
    report(
      `table: keys=${Object.keys(endpoints).length} ping=${"/connector/ping" in endpoints}`,
    );
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as any;
    const handler = function () {};
    handler.prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      permitBookmarklet: false,
      init: async function (req: any) {
        try {
          const data = req.data || {};
          if (data.token !== TOKEN) {
            return [403, "text/plain", "forbidden"];
          }
          const fn = new AsyncFunction(
            "Zotero",
            "addon",
            "dev",
            String(data.code),
          );
          let result = await fn(Zotero, addon, {
            libraryIndex,
            refStorage,
            parsePDFReferences,
            openalex,
            crossref,
            selfTest: selfTestReaderHook,
          });
          if (typeof result !== "string") {
            try {
              result = JSON.stringify(result);
            } catch {
              result = String(result);
            }
          }
          return [
            200,
            "application/json",
            JSON.stringify({ ok: true, result: String(result ?? "") }),
          ];
        } catch (e: any) {
          return [
            200,
            "application/json",
            JSON.stringify({
              ok: false,
              error: `${e}\n${e?.stack || ""}`,
            }),
          ];
        }
      },
    };
    // a plain sandbox write can land on the Xray expando (invisible to
    // Zotero's own realm) — waive Xrays so the write hits the real table
    const Cu = (globalThis as any).Components?.utils;
    const target = Cu?.waiveXrays ? Cu.waiveXrays(endpoints) : endpoints;
    target["/refs-dev/eval"] = handler;
    report(
      `registered: waived=${!!Cu?.waiveXrays} readback=${"/refs-dev/eval" in endpoints}`,
    );
    void selfTestReaderHook(report);
    ztoolkit.log("[devEval] endpoint registered");
  } catch (e) {
    report(`register failed: ${e}`);
    ztoolkit.log("[devEval] register failed", e);
  }
}

/** dev-only end-to-end probe of the reader citation-popup takeover */
async function selfTestReaderHook(report: (m: string) => void) {
  try {
    const delay = (ms: number) => Zotero.Promise.delay(ms);
    let reader: any;
    let view: any;
    for (let i = 0; i < 150; i++) {
      reader = (Zotero.Reader as any)._readers?.[0];
      view = reader?._internalReader?._primaryView;
      if (
        view?._iframeWindow?.PDFViewerApplication?.pdfDocument &&
        typeof view._onSetOverlayPopup === "function" &&
        String(view._onSetOverlayPopup).includes("hoverLink")
      ) {
        break;
      }
      view = null;
      await delay(200);
    }
    if (!view) {
      report("selftest: no wrapped PDF view (open a PDF tab first)");
      return;
    }
    const item = Zotero.Items.get(reader.itemID) as any;
    const top = item?.parentItem ?? item;
    report(
      `selftest v2: reader item "${String(top.getField("title")).slice(0, 50)}"`,
    );
    {
      let w: any = view._iframeWindow;
      const chain: string[] = [];
      for (let d = 0; d < 5; d++) {
        let via = "";
        let fe: any = null;
        try {
          fe = w?.browsingContext?.embedderElement;
          if (fe) via = "embedder";
        } catch (e) {
          via = `embThrow:${e}`;
        }
        if (!fe) {
          try {
            if (w?.frameElement) {
              fe = w.frameElement;
              via = "frameElement";
            } else if (!via) via = "none";
          } catch (e) {
            via = `feThrow:${e}`;
          }
        }
        chain.push(via);
        if (!fe) break;
        w = fe.ownerDocument?.defaultView;
      }
      report(
        `selftest frames: ${JSON.stringify(chain)} reachedTabs=${!!w?.Zotero_Tabs} hoverPref=${Zotero.Prefs.get("extensions.zotero.refs.hoverLink", true)}`,
      );
      const f = await refStorage.get(top, "FUSED");
      const pdf2 = await refStorage.get(top, "PDF");
      report(
        `selftest cache: FUSED=${f?.length || 0} PDF=${pdf2?.length || 0}`,
      );
    }
    let refs =
      (await refStorage.get(top, "FUSED")) ||
      (await refStorage.get(top, "PDF"));
    if (!refs?.length) refs = await parsePDFReferences(reader, {});
    const probe = refs?.find(
      (r: any) => r.number && (r.text || "").length > 60,
    );
    if (!probe) {
      report(`selftest: no numbered ref to probe (refs=${refs?.length || 0})`);
      return;
    }
    const doc = (Zotero.getMainWindow() as any).document;
    const card = () => !!doc.querySelector(".references-popup-container");
    const nativeDom = () => {
      const sel =
        ".citation-popup, .reference-popup, .preview-popup, .overlay-popup";
      const docs = [
        reader._iframeWindow?.document,
        view._iframeWindow?.document,
        doc,
      ];
      return docs.map((d: any) => !!d?.querySelector(sel)).join(",");
    };
    const overlay = (cites: any[]) => ({
      type: "citation",
      position: { pageIndex: 0, rects: [[100, 100, 140, 112]] },
      rect: [300, 300, 360, 315],
      references: cites,
    });
    const cite = {
      text: probe.text,
      chars: [],
      index: probe.number,
      position: {
        pageIndex: probe.page ?? 0,
        rects: [
          [
            probe.x ?? 100,
            (probe.y ?? 100) - 8,
            (probe.x ?? 100) + 200,
            (probe.y ?? 100) + 4,
          ],
        ],
      },
    };
    {
      const rr = refsForReader(reader);
      report(`selftest stages: hookRefs=${rr?.length || 0}`);
      const m = rr?.length ? refForCitation(rr, cite) : null;
      report(`selftest stages: match=${m ? "#" + m.number : "null"}`);
      const rect = toMainWindowRect(
        reader,
        view._iframeWindow,
        [300, 300, 360, 315],
      );
      report(`selftest stages: rect=${JSON.stringify(rect)}`);
    }
    // positive: single known citation -> OUR card, native suppressed
    // (the startup prime may still be parsing -- retry briefly)
    let ourCard = false;
    for (let i = 0; i < 15 && !ourCard; i++) {
      view._onSetOverlayPopup(overlay([cite]));
      await delay(400);
      ourCard = card();
      if (!ourCard) {
        view._onSetOverlayPopup(null);
        await delay(600);
      }
    }
    report(
      `selftest POSITIVE #${probe.number}: ourCard=${ourCard} nativeDom=${nativeDom()}`,
    );
    {
      const rr = refsForReader(reader);
      report(
        `selftest post: hookRefs=${rr?.length || 0} probeAnchor=${JSON.stringify({ x: probe.x, y: probe.y, page: probe.page })} rect=${JSON.stringify(toMainWindowRect(reader, view._iframeWindow, [300, 300, 360, 315]))}`,
      );
    }
    view._onSetOverlayPopup(null);
    await delay(900);
    // negative: unknown entry -> native popup, no card
    view._onSetOverlayPopup(
      overlay([
        {
          text: "999. Zzz. Unknown entry matching nothing. J Void. 2099;1:1-2.",
          chars: [],
          index: 999,
        },
      ]),
    );
    await delay(500);
    report(`selftest NEGATIVE: ourCard=${card()} nativeDom=${nativeDom()}`);
    view._onSetOverlayPopup(null);
    await delay(700);
    // multi-entry cluster -> native list popup
    view._onSetOverlayPopup(
      overlay([cite, { ...cite, index: (probe.number || 0) + 1 }]),
    );
    await delay(500);
    report(`selftest MULTI: ourCard=${card()} nativeDom=${nativeDom()}`);
    view._onSetOverlayPopup(null);
    report("selftest done");
  } catch (e) {
    report(`selftest failed: ${e}`);
  }
}
