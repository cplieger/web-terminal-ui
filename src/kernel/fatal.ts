import { STARTUP_FAILURE_COPY } from "./startup-copy.js";
import { reloadPage } from "./navigation.js";
import { windowOf } from "./realm.js";

/** Fade out and remove a consumer-supplied loading overlay. */
export function fadeOutOverlay(ld: HTMLElement | undefined): void {
  if (!ld) {
    return;
  }
  ld.classList.add("fade");
  const removeOverlay = (): void => {
    ld.remove();
  };
  ld.addEventListener("transitionend", removeOverlay, { once: true });
  windowOf(ld.ownerDocument).setTimeout(removeOverlay, 1500);
}

export interface FatalPanelOptions {
  message?: string;
  /** `showModal()` (the terminal IS the page) or the bare `open` attribute (an
   *  embedded panel, or a pane beside a live one). */
  modal: boolean;
  /** Appended to the panel's two element ids, so two panels in one document keep
   *  their `aria-labelledby` targets unique. */
  idSuffix?: string;
}

/** Render the "Terminal failed to start" panel into `root`, replacing its children. */
export function renderFatalStartupInto(root: HTMLElement, opts: FatalPanelOptions): void {
  const suffix = opts.idSuffix ?? "";
  const doc = root.ownerDocument;
  const surface = doc.createElement("dialog");
  surface.className = "wt-fatal";
  // alertdialog over the implicit `dialog` role: an urgent message to act on. No
  // `aria-modal`: showModal() conveys modality, and an authored value can
  // contradict the UA.
  surface.setAttribute("role", "alertdialog");
  surface.setAttribute("aria-labelledby", `wt-fatal-title${suffix}`);
  surface.setAttribute("aria-describedby", `wt-fatal-message${suffix}`);
  // Nothing is behind this panel, so reload is the only recovery; Escape must not
  // close it.
  surface.addEventListener("cancel", (ev) => {
    ev.preventDefault();
  });

  const card = doc.createElement("div");
  card.className = "wt-fatal-card";
  const title = doc.createElement("h2");
  title.id = `wt-fatal-title${suffix}`;
  title.className = "wt-fatal-title";
  title.textContent = STARTUP_FAILURE_COPY.title;
  const messageEl = doc.createElement("p");
  messageEl.id = `wt-fatal-message${suffix}`;
  messageEl.className = "wt-fatal-message";
  messageEl.textContent = opts.message ?? STARTUP_FAILURE_COPY.message;
  const reloadButton = doc.createElement("button");
  reloadButton.className = "wt-btn wt-fatal-reload";
  reloadButton.type = "button";
  reloadButton.textContent = STARTUP_FAILURE_COPY.reloadLabel;
  reloadButton.addEventListener("click", () => {
    reloadPage(windowOf(doc));
  });
  card.append(title, messageEl, reloadButton);
  surface.appendChild(card);
  root.replaceChildren(surface);

  // showModal() requires a connected element in a document that has a window; a
  // detached root or a created document arrives here from a typed call, where a
  // throw would bury the real startup cause.
  if (opts.modal && surface.isConnected && doc.defaultView !== null) {
    surface.showModal();
  } else {
    surface.open = true;
  }
  reloadButton.focus();
}
