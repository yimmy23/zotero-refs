export {
  isWindowAlive,
  getWin,
  getDoc,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

/**
 * Check if the window is alive.
 * Useful to prevent opening duplicate windows.
 * @param win
 */
function isWindowAlive(win?: Window) {
  return win && !Components.utils.isDeadWrapper(win) && !win.closed;
}

/** The active Zotero main window. */
function getWin(): _ZoteroTypes.MainWindow {
  return Zotero.getMainWindow();
}

function getDoc(): Document {
  return getWin().document;
}

/*
 * Timer helpers (the plugin sandbox has no timers of its own).
 *
 * Timers are bound to whichever main window is active at schedule time, so
 * each handle records its window: with several Zotero windows open, raw
 * window timer ids would otherwise be cleared against the wrong window.
 * Handles are plain numbers from our own sequence.
 */
let timerSeq = 1;
const timers = new Map<number, { win: Window; id: number }>();

function schedule(fn: () => void, ms: number, repeating: boolean): number {
  const win = getWin() as unknown as Window;
  const handle = timerSeq++;
  const cb = () => {
    if (!repeating) timers.delete(handle);
    fn();
  };
  const id = repeating ? win.setInterval(cb, ms) : win.setTimeout(cb, ms);
  timers.set(handle, { win, id });
  return handle;
}

function cancel(handle: number | undefined, repeating: boolean) {
  if (handle === undefined) return;
  const entry = timers.get(handle);
  timers.delete(handle);
  if (!entry || !isWindowAlive(entry.win)) return;
  if (repeating) entry.win.clearInterval(entry.id);
  else entry.win.clearTimeout(entry.id);
}

function setTimeout(fn: () => void, ms = 0): number {
  return schedule(fn, ms, false);
}
function clearTimeout(id?: number) {
  cancel(id, false);
}
function setInterval(fn: () => void, ms: number): number {
  return schedule(fn, ms, true);
}
function clearInterval(id?: number) {
  cancel(id, true);
}
