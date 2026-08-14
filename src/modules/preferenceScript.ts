/**
 * Preference pane logic. The pane itself is declarative
 * (preference="..." bindings in preferences.xhtml); nothing to wire yet
 * beyond keeping a handle on the window.
 */
export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window } as any;
  } else {
    addon.data.prefs.window = _window;
  }
}
