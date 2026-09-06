import { config } from "../../package.json";
import { getPref, setPref } from "../utils/prefs";

/** Keep Zotero's declarative preference bindings; wire only UI behavior. */
export async function registerPrefsScripts(_window: Window) {
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window } as any;
  } else {
    addon.data.prefs.window = _window;
  }
  const root = _window.document.getElementById(
    "refs-preferences",
  ) as HTMLElement | null;
  if (!root || root.hasAttribute("data-wired")) return;
  root.setAttribute("data-wired", "true");
  const tabs = Array.from(
    root.querySelectorAll("[role=tab]"),
  ) as HTMLButtonElement[];
  const activate = (tab: HTMLButtonElement) => {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      const panel = root.querySelector<HTMLElement>(
        `#${candidate.getAttribute("aria-controls")}`,
      );
      if (panel) panel.hidden = !selected;
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event: KeyboardEvent) => {
      let next: number;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[next]);
      tabs[next].focus();
    });
  });
  // Capture before Zotero's change binding: reject out-of-range values and
  // restore the previous value instead of persisting invalid configuration.
  root.addEventListener(
    "change",
    (event: Event) => {
      const input = event.target as HTMLInputElement;
      if (input.localName !== "input") return;
      const key = input
        .getAttribute("preference")
        ?.replace(`${config.prefsPrefix}.`, "") as Parameters<
        typeof getPref
      >[0];
      if (!key) return;
      if (
        !input.validity.valid ||
        (input.type === "number" && input.value === "")
      ) {
        event.stopImmediatePropagation();
        input.reportValidity();
        input.value = String(getPref(key) ?? "");
        return;
      }
      if (key === "CNKI.username" || key === "CNKI.password")
        setPref("CNKI.token", "");
    },
    true,
  );
}
