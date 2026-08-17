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

const TOKEN = "refs-dev-7f3fa390";

export function registerDevEval() {
  if (__env__ !== "development") return;
  try {
    const endpoints = (Zotero as any).Server?.Endpoints;
    if (!endpoints) {
      ztoolkit.log("[devEval] Zotero.Server not available");
      return;
    }
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
          let result = await fn(Zotero, addon, { libraryIndex, refStorage });
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
    endpoints["/refs-dev/eval"] = handler;
    ztoolkit.log("[devEval] endpoint registered");
  } catch (e) {
    ztoolkit.log("[devEval] register failed", e);
  }
}
