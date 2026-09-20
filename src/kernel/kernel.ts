import { fadeOutOverlay, renderFatalStartupInto } from "./fatal.js";
import { createShell, hasLiveShell } from "./shell.js";
import type { CreateTerminalOptions, TerminalHandle } from "./types.js";

/** Resolve the mount target. A selector is looked up here, INSIDE
 *  createTerminal's try, so a missing element is a startup failure this library
 *  reports rather than a null-check every consumer restates. An element is still
 *  accepted, because an embedder that CREATED the element already holds it. */
function resolveRoot(target: HTMLElement | string): HTMLElement {
  if (typeof target !== "string") {
    return target;
  }
  const found = document.querySelector(target);
  if (found === null) {
    throw new Error(`web-terminal-ui: no element matches the mount selector ${target}`);
  }
  if (!(found instanceof HTMLElement)) {
    // An SVG or MathML element can match a selector but has no style/classList
    // contract to host the terminal.
    throw new Error(`web-terminal-ui: the mount selector ${target} matched a non-HTML element`);
  }
  return found;
}

/** The host for the recovery surface when the mount target could not be
 *  resolved: a NEW element, never the body, whose styling a .wt-root would
 *  reformat. */
function createFallbackHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "wt-root wt-viewport";
  document.body.appendChild(host);
  return host;
}

function reportFatal(
  opts: CreateTerminalOptions,
  cause: unknown,
  surface: HTMLElement | undefined,
): boolean {
  try {
    return opts.onFatalError?.({ phase: "kernel-init", cause, surface }) === true;
  } catch (handlerErr) {
    // A reporting failure must not leave the page blank.
    console.error("web-terminal-ui: onFatalError handler failed", handlerErr);
    return false;
  }
}

/** Build the terminal UI inside `target`. Call at most once per document while
 *  the previous terminal is alive: a second call reports `kernel-init` with no
 *  surface and throws, touching nothing. A synchronous startup failure renders
 *  the recovery surface and still propagates; that surface is modal in viewport
 *  layout, so `onFatalError` returning `true` is the path that leaves the page
 *  interactive. */
export function createTerminal(
  target: HTMLElement | string,
  opts: CreateTerminalOptions = {},
): TerminalHandle {
  const layoutMode = opts.layout ?? "viewport";
  // Declared outside the try so the catch can tell "never resolved a root" from
  // "had one and the build failed".
  let root: HTMLElement | undefined;
  let refused = false;
  try {
    root = resolveRoot(target);
    // A second terminal must not draw on a root the first one may own, so this
    // failure has no surface and no overlay fade.
    if (hasLiveShell(root.ownerDocument)) {
      refused = true;
      const cause = new Error(
        "web-terminal-ui: a terminal already exists in this document; destroy() it first, or use the split option for a second pane",
      );
      reportFatal(opts, cause, undefined);
      throw cause;
    }
    return createShell(root, opts);
  } catch (cause) {
    if (refused) {
      throw cause;
    }
    // Container mode declines the fallback host on purpose: an embedded terminal
    // is one panel in someone else's working application, and claiming the
    // viewport to say its mount target is missing would break a page that is
    // otherwise fine. The failure is still delivered and rethrown.
    const surface = root ?? (layoutMode === "viewport" ? createFallbackHost() : undefined);
    if (surface !== undefined) {
      // Every .wt-fatal rule is scoped :where(.wt-root), and a throw can precede
      // the stamp (the owner guard fires before any DOM work).
      surface.classList.add("wt-root", layoutMode === "container" ? "wt-container" : "wt-viewport");
    }
    // The consumer's pre-JS spinner must come down even though nothing was built.
    fadeOutOverlay(opts.loading);
    if (!reportFatal(opts, cause, surface) && surface !== undefined) {
      renderFatalStartupInto(surface, { modal: layoutMode === "viewport" });
    }
    throw cause;
  }
}
