import { getString } from "../utils/locale";

/** Shared search surface across all three literature lists. */
export function createSearch(body: HTMLElement, placeholder: string) {
  const doc = body.ownerDocument!;
  const box = doc.createElement("div");
  box.className = "references-search";
  const input = doc.createElement("input");
  input.type = "search";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  const clear = doc.createElement("button");
  clear.type = "button";
  clear.className = "references-search-clear";
  clear.textContent = "×";
  clear.title = getString("panel-clear-search");
  clear.setAttribute("aria-label", clear.title);
  clear.hidden = true;
  input.addEventListener("input", () => {
    clear.hidden = !input.value;
  });
  const reset = () => {
    input.value = "";
    input.dispatchEvent(new doc.defaultView!.Event("input", { bubbles: true }));
    input.focus();
  };
  clear.addEventListener("click", reset);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      reset();
    }
  });
  const count = doc.createElement("span");
  count.className = "references-filter-count";
  count.setAttribute("aria-live", "polite");
  box.append(input, count, clear);
  body.append(box);
  return input;
}

/** Keep original toolbar SVGs, with visible text and keyboard-native buttons. */
export function actionButton(
  doc: Document,
  icon: string,
  label: string,
  tip = label,
) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "references-button references-labeled-button";
  button.title = tip;
  const glyph = doc.createElement("span");
  glyph.className = `references-icon-button ${icon}`;
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph, label);
  return button;
}

export function setListMessage(list: HTMLElement, message: string) {
  let empty = list.querySelector<HTMLElement>(":scope > .references-empty");
  if (!message) {
    empty?.remove();
    return;
  }
  if (!empty) {
    empty = list.ownerDocument!.createElement("div");
    empty.className = "references-empty";
    empty.setAttribute("role", "status");
    list.append(empty);
  }
  empty.textContent = message;
}
