import { getString } from "../utils/locale";
import { importAll } from "../core/importer";
import type { RefItem } from "../core/types";

/**
 * Batch import with the two safeguards a mis-click needs: an explicit
 * confirmation (count + "attachments per your settings"), and a way to
 * stop midway — clicking the progress window cancels; the remaining
 * references are left untouched.
 */
export async function runBatchImport(
  hostItem: Zotero.Item,
  targets: RefItem[],
  title: string,
  collections?: number[],
): Promise<{ ok: number; fail: number; stopped: number } | null> {
  if (!targets.length) return null;
  const win = Zotero.getMainWindow();
  const confirmed = Services.prompt.confirm(
    win as any,
    title,
    getString("import-confirm", { args: { count: targets.length } }),
  );
  if (!confirmed) return null;

  let cancelled = false;
  const popupWin = new ztoolkit.ProgressWindow(title, {
    closeTime: -1,
    closeOnClick: true,
    closeOtherProgressWindows: true,
  })
    .createLine({ text: `0/${targets.length}`, type: "default", progress: 0 })
    .show();
  // any close of the progress window (click, or Zotero closing it) = stop.
  // Zotero.ProgressWindow's mouseup handler calls this instance's close().
  const inner = popupWin.win as any;
  const origClose = inner.close;
  inner.close = () => {
    cancelled = true;
    origClose.call(inner);
  };
  try {
    inner.addDescription?.(getString("import-cancel-hint"));
  } catch {
    // description is cosmetic
  }

  const result = await importAll(
    hostItem,
    targets,
    collections,
    (done, total, msg) =>
      popupWin.changeLine({
        text: `${done}/${total} ${msg}`,
        progress: (done / total) * 100,
      }),
    () => cancelled,
  );
  if (!cancelled) {
    popupWin.changeHeadline(`${title} ✓`);
    popupWin.changeLine({
      text: `✓ ${result.ok}  ✗ ${result.fail}${
        result.stopped ? `  ⏹ ${result.stopped}` : ""
      }`,
      type: result.fail ? "fail" : "success",
      progress: 100,
    });
    popupWin.startCloseTimer(5000);
  } else {
    new ztoolkit.ProgressWindow(title, { closeOtherProgressWindows: true })
      .createLine({
        text: getString("import-cancelled", {
          args: { ok: result.ok, left: result.stopped },
        }),
        type: "default",
      })
      .show();
  }
  return result;
}
