/**
 * DEV-BUILD-ONLY remote eval endpoint for closed-loop debugging.
 *
 * Registered on Zotero's localhost-only connector server (port 23119)
 * and ONLY when the bundle was built with NODE_ENV=development — the
 * production xpi never contains an active endpoint (the whole module is
 * a no-op there). A per-boot RANDOM token is still required per request;
 * it is written to <dataDir>/dev-eval-token.txt so local tooling can read
 * it — no shared secret lives in the repository.
 */

import { libraryIndex } from "../core/libmatch";
import { refStorage } from "../core/storage";
import { parsePDFReferences } from "../pdf/parser";
import { openalex } from "../sources/openalex";
import { crossref } from "../sources/crossref";
import { attachReader, readerLinkState } from "../pdf/readerHook";

let TOKEN = "";

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
    TOKEN = Array.from(
      { length: 24 },
      () => "abcdefghijklmnopqrstuvwxyz0123456789"[(Math.random() * 36) | 0],
    ).join("");
    try {
      const iou = (globalThis as any).IOUtils;
      const pu = (globalThis as any).PathUtils;
      await iou.writeUTF8(
        pu.join(Zotero.DataDirectory.dir, "dev-eval-token.txt"),
        TOKEN,
      );
    } catch (e) {
      // no readable token file -> an unusable endpoint; don't register one
      report(`token write failed: ${e}`);
      ztoolkit.log("[devEval] token write failed", e);
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
            attachReader,
            readerLinkState,
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
    ztoolkit.log("[devEval] endpoint registered");
  } catch (e) {
    report(`register failed: ${e}`);
    ztoolkit.log("[devEval] register failed", e);
  }
}
