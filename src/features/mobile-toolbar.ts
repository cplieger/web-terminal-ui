/**
 * mobileToolbar feature: the on-screen key toolbar (Tab/Esc/arrows/Enter + a
 * collapse toggle and sticky-Ctrl) in the thumb-zone region.
 * The engine's toolbar.bindMobileToolbar wires the buttons (DECCKM-aware
 * arrows, sticky-Ctrl state; engine >= v3, where the widget moved out of the
 * keyboard module); this feature builds the toolbar chrome, routes its
 * output through the kernel funnel, and registers sticky-Ctrl as an input
 * transform so a typed character is rewritten to its Ctrl byte when armed.
 *
 * @module
 */

import { toolbar } from "@cplieger/web-terminal-engine";
import type { TerminalFeature } from "../kernel/types.js";
import { fromHTML } from "./dom.js";

const { bindMobileToolbar } = toolbar;

/** mobileToolbar's public API, so a peer feature (tabs) can drive the key grid
 *  from a button it owns instead of the toolbar's own toggle. */
export interface MobileToolbarApi {
  /** Show/hide the key grid (flips the toolbar's collapsed state). */
  toggle(): void;
  /** Whether the key grid is currently open. */
  isOpen(): boolean;
  /** Whether sticky-Ctrl is currently armed (a pending Ctrl press). */
  isCtrlArmed(): boolean;
  /** Subscribe to sticky-Ctrl arm/disarm; returns an unsubscribe. Lets a peer
   *  (the tab bar's keyboard button) surface the pending modifier even while the
   *  key grid — and its own Ctrl button — is closed. */
  onCtrlArmedChange(fn: (armed: boolean) => void): () => void;
}

/** Options for the mobileToolbar feature. */
export interface MobileToolbarOptions {
  /** When true, the toolbar hides its own top-right toggle button and positions
   *  the key grid to open above the mobile tab bar. The grid is then driven
   *  externally through the returned API (tabs renders a keyboard button in the
   *  switcher bar and calls toggle()). The tabbed presets set this; presetTouch
   *  leaves it off and keeps the self-contained top-right toggle. */
  externalToggle?: boolean;
}

// The key grid, without the scroll-to-bottom button (that is the scrollToBottom
// feature, composed into the same region's "scroll" slot).
const TOOLBAR_HTML = `
<div class="key-toolbar collapsed no-transition" aria-label="Navigation keys" role="toolbar">
  <button type="button" id="kb-toggle" class="kb-toggle" aria-label="Toggle key toolbar"><svg class="icon-hamburger" viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg><svg class="icon-close" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
  <button type="button" id="kb-tab" class="kb-key kb-r1c1" aria-label="Tab">TAB</button>
  <button type="button" id="kb-esc" class="kb-key kb-r1c2" aria-label="Escape">ESC</button>
  <button type="button" id="kb-up" class="kb-key kb-r1c3" aria-label="Up"><svg viewBox="0 0 24 24"><polyline points="6 15 12 9 18 15"/></svg></button>
  <button type="button" id="kb-enter" class="kb-key kb-r1c4" aria-label="Enter"><svg viewBox="0 0 24 24"><polyline points="9 10 4 15 9 20"/><polyline points="20 4 20 15 4 15"/></svg></button>
  <button type="button" id="kb-ctrl" class="kb-key kb-r2c1" aria-label="Sticky Ctrl modifier" aria-pressed="false">CTRL</button>
  <button type="button" id="kb-left" class="kb-key kb-r2c2" aria-label="Left"><svg viewBox="0 0 24 24"><polyline points="15 6 9 12 15 18"/></svg></button>
  <button type="button" id="kb-down" class="kb-key kb-r2c3" aria-label="Down"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></button>
  <button type="button" id="kb-right" class="kb-key kb-r2c4" aria-label="Right"><svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg></button>
</div>`;

/** Build the mobileToolbar feature.
 *
 *  The chrome is always built; whether it is VISIBLE is a CSS decision — the keys
 *  and the toggle are `display: none` and only a coarse pointer restores them
 *  (`css/23-toolbar.css`) — so a desktop consumer including this feature pays the
 *  DOM and sees nothing. Order it before `tabs` when `externalToggle` is set, since
 *  tabs reads the returned API through `ctx.use` to drive the grid from the tab
 *  bar's keyboard button.
 *
 *  Sticky-Ctrl is registered as a kernel INPUT TRANSFORM rather than handled in
 *  the toolbar's own click path, so it rewrites a character typed on the soft
 *  keyboard as well as one produced by these buttons. Teardown removes the
 *  toolbar, drops the transform, and clears every subscriber. */
export function mobileToolbar(opts: MobileToolbarOptions = {}): TerminalFeature<MobileToolbarApi> {
  return {
    name: "mobileToolbar",
    setup(ctx) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const toolbar = fromHTML(TOOLBAR_HTML);
      // Externally-driven mode (the tabbed presets): the toolbar hides its own
      // toggle and opens the grid above the mobile tab bar; tabs drives it via
      // the returned API. The class gates both behaviors in CSS.
      if (opts.externalToggle) {
        toolbar.classList.add("wt-toolbar-external");
      }
      ctx.region("bottom-inset-end", "keys").appendChild(toolbar);

      // Fan sticky-Ctrl arm/disarm out to subscribers (the tab bar's keyboard
      // button mirrors it, so a pending Ctrl is visible with the grid closed).
      const armedListeners = new Set<(armed: boolean) => void>();
      const ctrl = bindMobileToolbar({
        toolbar,
        send: (bytes) => {
          ctx.send(encoder.encode(bytes));
        },
        onCtrlChange: (armed) => {
          for (const fn of [...armedListeners]) {
            fn(armed);
          }
        },
      });

      // Sticky-Ctrl as an outbound-byte transform: when armed, a single typed
      // character is rewritten to its Ctrl byte (and disarms). The toolbar's own
      // arrow/Tab/Enter/Esc sends disarm before sending, so they pass through.
      const offTransform = ctx.registerInputTransform((bytes) => {
        if (!ctrl.isCtrlArmed()) {
          return bytes;
        }
        const text = decoder.decode(bytes);
        const mapped = ctrl.applyStickyCtrl(text);
        return mapped === text ? bytes : encoder.encode(mapped);
      });

      // Prime the slide transition off for the first paint (no initial flash),
      // then enable it after two frames.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          toolbar.classList.remove("no-transition");
        });
      });

      return {
        // Expose grid open/close so a peer (tabs) can drive it from the tab bar.
        // Toggling the same `.collapsed` class the engine's own kb-toggle flips
        // keeps a single source of truth for the grid's visibility.
        api: {
          toggle() {
            toolbar.classList.toggle("collapsed");
          },
          isOpen() {
            return !toolbar.classList.contains("collapsed");
          },
          isCtrlArmed() {
            return ctrl.isCtrlArmed();
          },
          onCtrlArmedChange(fn) {
            armedListeners.add(fn);
            return () => armedListeners.delete(fn);
          },
        },
        onDetach() {
          // A tab switch disarms a latched sticky-Ctrl so a pending Ctrl does
          // not fire against the incoming session (e.g. an accidental Ctrl+C to
          // the wrong agent, design 5.1 / ui-ux review D).
          if (ctrl.isCtrlArmed()) {
            ctrl.setCtrlArmed(false);
          }
        },
        teardown() {
          offTransform();
          armedListeners.clear();
          ctrl.dispose();
          toolbar.remove();
        },
      };
    },
  };
}
