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

/* Timer helpers bound to the main window (the plugin sandbox has no timers). */
function setTimeout(fn: () => void, ms = 0): number {
  return getWin().setTimeout(fn, ms);
}
function clearTimeout(id?: number) {
  if (id !== undefined) getWin().clearTimeout(id);
}
function setInterval(fn: () => void, ms: number): number {
  return getWin().setInterval(fn, ms);
}
function clearInterval(id?: number) {
  if (id !== undefined) getWin().clearInterval(id);
}
