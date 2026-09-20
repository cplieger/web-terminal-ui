import { toolbar } from "@cplieger/web-terminal-engine";
import type { TerminalFeature } from "../kernel/types.js";
import { fromHTML } from "./dom.js";

const { bindMobileToolbar } = toolbar;

/** mobileToolbar's API, so a peer feature (tabs) can drive the key grid from a
 *  button it owns instead of the toolbar's own toggle. */
export interface MobileToolbarApi {
  /** Show/hide the key grid. */
  toggle(): void;
  isOpen(): boolean;
  /** Whether sticky-Ctrl is armed (a pending Ctrl press). */
  isCtrlArmed(): boolean;
  /** Sticky-Ctrl arm/disarm, so a peer can show the pending modifier while the
   *  key grid and its own Ctrl button are closed. */
  onCtrlArmedChange(fn: (armed: boolean) => void): () => void;
}

/** Options for the mobileToolbar feature. */
export interface MobileToolbarOptions {
  /** Hide the toolbar's own toggle and open the grid above the mobile tab bar;
   *  the grid is then driven through the returned API. The tabbed presets set it. */
  externalToggle?: boolean;
}

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

/** Build the mobileToolbar feature. The chrome is always built; only a coarse
 *  pointer makes it visible (`css/23-toolbar.css`). Order it before `tabs` when
 *  `externalToggle` is set, since tabs reads the API through `ctx.use`.
 *  Sticky-Ctrl is a kernel INPUT TRANSFORM rather than a toolbar click path, so
 *  it rewrites a character typed on the soft keyboard as well as one from these
 *  buttons. */
export function mobileToolbar(opts: MobileToolbarOptions = {}): TerminalFeature<MobileToolbarApi> {
  return {
    name: "mobileToolbar",
    scope: "shell",
    setup(ctx) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const toolbar = fromHTML(TOOLBAR_HTML);
      if (opts.externalToggle) {
        toolbar.classList.add("wt-toolbar-external");
      }
      ctx.region("bottom-inset-end", "keys").appendChild(toolbar);

      const armedListeners = new Set<(armed: boolean) => void>();
      const ctrl = bindMobileToolbar({
        toolbar,
        send: (bytes) => {
          ctx.send(encoder.encode(bytes));
        },
        modes: ctx.modes,
        onCtrlChange: (armed) => {
          for (const fn of [...armedListeners]) {
            fn(armed);
          }
        },
      });
      ctx.defer(() => {
        ctrl.dispose();
      });

      // The toolbar's own arrow/Tab/Enter/Esc sends disarm before sending, so
      // they pass through untouched.
      ctx.registerInputTransform((bytes) => {
        if (!ctrl.isCtrlArmed()) {
          return bytes;
        }
        const text = decoder.decode(bytes);
        const mapped = ctrl.applyStickyCtrl(text);
        return mapped === text ? bytes : encoder.encode(mapped);
      });

      // Two frames without the slide transition, so the first paint cannot flash.
      let settleFrame = requestAnimationFrame(() => {
        settleFrame = requestAnimationFrame(() => {
          toolbar.classList.remove("no-transition");
        });
      });
      ctx.defer(() => {
        cancelAnimationFrame(settleFrame);
      });

      return {
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
          // A pending Ctrl must not fire against the incoming session.
          if (ctrl.isCtrlArmed()) {
            ctrl.setCtrlArmed(false);
          }
        },
        teardown() {
          armedListeners.clear();
          toolbar.remove();
        },
      };
    },
  };
}
