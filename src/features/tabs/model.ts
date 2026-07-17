// tabs/model.ts — the session MODEL half of the tabs feature: the wire type,
// the per-tab record, the session REST client, the close-tombstone set, and the
// input-derived-title state machine. No DOM, no chrome, no kernel context —
// everything here is factory/pure and unit-testable in isolation. The chrome
// halves are strip.ts (desktop) and switcher.ts (mobile); index.ts wires all
// three over the kernel context.

import type { LineStore } from "@cplieger/web-terminal-engine";
import type { SessionInfo } from "@cplieger/web-terminal-engine";
import type { TabHandle } from "../../kernel/types.js";

// One session's wire shape (SessionInfo) is the ENGINE's exported type — the
// same repo as the Go terminal.SessionInfo it mirrors, so the cross-language
// contract has one home. Type-only import: erases at compile, no runtime dep.
export type { SessionInfo };

// The server-side status of a session whose process has exited (mirrors the
// engine's terminal.StatusExited). Such a session is viewable history — its
// final screen replays and the kernel shows "Session ended" — but it can never
// produce output again, so session selection prefers live sessions everywhere.
export const STATUS_EXITED = "exited";

// localStorage key for the last active session id, so a page reload reopens the
// tab the user left on rather than always defaulting to the oldest one.
export const ACTIVE_TAB_KEY = "wt-active-session";

// One-time "swipe to switch" hint, remembered across loads.
export const SWIPE_HINT_KEY = "wt-swipe-hint-seen";

export interface Tab {
  id: string;
  /** The raw server title (the OSC 0/2 window title the process set), possibly
   *  empty before the process sets one. The displayed label is derived from it
   *  with a numbered fallback and de-duplication (see relabelAll in index.ts). */
  title: string;
  /** The computed, de-duplicated label actually shown in the chrome. */
  display: string;
  createdAt: string;
  store: LineStore;
  el: HTMLElement;
  label: HTMLElement;
  dot: HTMLElement;
  aria: TabHandle;
  scrollTop: number;
  following: boolean;
  /** Sticky: true once this session emitted a genuine activity signal (OSC 9;4).
   *  Its activity dot is shown only while true; a session that never reports
   *  activity (a plain shell) keeps a clean, dot-less tab. Fed from the server's
   *  reportsActivity via applyStatus. */
  reports: boolean;
  /** A fallback title derived from the LAST non-empty line the user submitted
   *  into this tab (updated on every Enter). Used only when the process sets no
   *  window title of its own: the OSC 0/2 title (`title` above) takes precedence
   *  when present and keeps updating, and this is what the tab reads as when it
   *  does not — a plain shell with no PROMPT_COMMAND title, or kiro-cli with its
   *  cwd-only title disabled. Undefined until the first non-empty submission; see
   *  baseLabel. */
  derived?: string;
  /** The persisted client title reported by the server (its `clientTitle` wire
   *  field): the last derived title pushed via PUT .../title, surviving reloads.
   *  In `preferInputTitle` mode this is the reload-recovery source (the live
   *  `derived` is lost on reload, and `title` is the unreliable OSC value there).
   *  In the default mode it is the lowest-priority fallback after title/derived. */
  clientTitle?: string | undefined;
}

/** baseLabel is a tab's label before de-duplication. Preference order: the
 *  process window title (OSC 0/2, e.g. a shell's PROMPT_COMMAND title), which
 *  takes precedence whenever the program sets one and keeps updating as it
 *  changes (the status SSE re-pushes it); then a fallback derived from the last
 *  line the user submitted, for a program that sets no title (a bare shell, or
 *  kiro-cli with its cwd-only title disabled); then a plain "New tab".
 *  fallback=true marks that last case so relabelAll leaves untitled tabs as
 *  "New tab" with no numeric suffix.
 *
 *  preferInputTitle (agent shell with an unreliable OSC title): show the live
 *  submitted line, then the persisted client title on reload — the process OSC
 *  `title` is ignored. Default: OSC title first, then the live derived line,
 *  then the persisted client title (the latter two are the "latest user
 *  message" fallback when the program sets no OSC title). */
export function baseLabel(
  tab: Tab,
  preferInputTitle: boolean,
): { text: string; fallback: boolean } {
  const derived = tab.derived?.trim() ?? "";
  const persisted = tab.clientTitle?.trim() ?? "";
  const real = preferInputTitle ? derived || persisted : tab.title.trim() || derived || persisted;
  return real ? { text: real, fallback: false } : { text: "New tab", fallback: true };
}

/** The session REST client (GET/POST/DELETE /api/sessions + PUT .../title),
 *  bound to an apiBase. Every call is timeout-bounded: fetch has no default
 *  timeout, and a stalled-but-open server would otherwise leave a bootstrap
 *  list/create await pending forever (the old permanent-loading-overlay wedge;
 *  under the v4 session-owner contract the kernel would eventually see nothing,
 *  but a bounded call recovers into the retry chrome MUCH sooner). */
export interface SessionAPI {
  list(): Promise<SessionInfo[]>;
  create(): Promise<SessionInfo>;
  close(id: string): Promise<void>;
  /** Best-effort and fire-and-forget: a failure never disrupts the terminal —
   *  the locally-derived title still displays, it just is not persisted. */
  setTitle(id: string, title: string): Promise<void>;
}

const SESSION_API_TIMEOUT_MS = 15000;

export function createSessionAPI(apiBase: string): SessionAPI {
  return {
    async list(): Promise<SessionInfo[]> {
      const r = await fetch(apiBase, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw new Error(`web-terminal-ui: session list failed (${String(r.status)})`);
      }
      const data: unknown = await r.json();
      // A 200 with a non-array body -- a proxy error object, or a Go server
      // marshaling a nil session slice as JSON `null` -- must not reach the
      // bootstrap's `sessions.length` / `for...of` (or the poll's `list.map`)
      // uncaught. Reject a non-array so the callers' existing catch paths
      // recover (bootstrap -> [], poll -> skip the tick).
      if (!Array.isArray(data)) {
        throw new Error("web-terminal-ui: session list returned a non-array body");
      }
      return data as SessionInfo[];
    },
    async create(): Promise<SessionInfo> {
      const r = await fetch(apiBase, {
        method: "POST",
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw new Error(`web-terminal-ui: session create failed (${String(r.status)})`);
      }
      return (await r.json()) as SessionInfo;
    },
    async close(id: string): Promise<void> {
      const r = await fetch(`${apiBase}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
      });
      if (!r.ok) {
        throw new Error(`web-terminal-ui: session close failed (${String(r.status)})`);
      }
    },
    // Persist the input-derived tab title server-side so it survives a page
    // reload and shows on other devices. The engine stores it as the session's
    // fallback title and uses it only when the program emits no OSC title.
    async setTitle(id: string, title: string): Promise<void> {
      try {
        await fetch(`${apiBase}/${encodeURIComponent(id)}/title`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
          signal: AbortSignal.timeout(SESSION_API_TIMEOUT_MS),
        });
      } catch {
        /* best-effort persistence; ignore network/timeout errors */
      }
    },
  };
}

/** Close tombstones: ids the user closed within the TTL, so a stale server
 *  listing (the SSE re-open snapshot, or the poll's GET /api/sessions) that
 *  predates the server reaping the session does not re-adopt (flash back) the
 *  closed tab. */
export interface Tombstones {
  add(id: string): void;
  /** True while `id` is tombstoned (within the TTL). A hit past the TTL clears
   *  the entry and reports false (the adopt may proceed). */
  active(id: string): boolean;
}

const CLOSE_TOMBSTONE_MS = 15000;

export function createTombstones(ttlMs: number = CLOSE_TOMBSTONE_MS): Tombstones {
  const recentlyClosed = new Map<string, number>();
  return {
    add(id: string): void {
      const now = Date.now();
      // Sweep entries whose window already elapsed (active() treats them as
      // untombstoned anyway) so the map cannot grow without bound over a long
      // session of opens/closes; then record this close.
      for (const [k, t] of recentlyClosed) {
        if (now - t >= ttlMs) {
          recentlyClosed.delete(k);
        }
      }
      recentlyClosed.set(id, now);
    },
    active(id: string): boolean {
      const closedAt = recentlyClosed.get(id);
      if (closedAt === undefined) {
        return false;
      }
      if (Date.now() - closedAt < ttlMs) {
        return true;
      }
      recentlyClosed.delete(id);
      return false;
    },
  };
}

// A generous storage bound for the fallback (input-derived) title. The tab
// label truncates it visually with max-width + ellipsis in EVERY view — the
// desktop strip, the mobile active bar, and the mobile list — so this is only a
// guard against storing a huge paste, not a display cut.
const MAX_DERIVED = 512;

/** The input-derived-title state machine: a tiny line editor over the kernel's
 *  accepted outbound bytes. It tracks the current input line (handling
 *  backspace and skipping the escape sequences arrow keys and bracketed paste
 *  emit) and reports every non-empty submitted line through `submit`. The
 *  caller owns what a submission means (update the active tab's derived title,
 *  persist it, refresh chrome). Best-effort: an odd editing sequence just
 *  yields no derived title. */
export interface InputTitleDeriver {
  /** Feed one accepted outbound byte chunk (a ctx.registerInputObserver hook). */
  observe(bytes: Uint8Array): void;
  /** Drop the partial line (a tab switch: a line typed in the old tab must not
   *  carry over). */
  reset(): void;
}

export function createInputTitleDeriver(submit: (line: string) => void): InputTitleDeriver {
  let lineBytes: number[] = [];
  let escState = 0; // 0 normal, 1 saw ESC, 2 in CSI, 3 in SS3 (one more byte)
  let csiParams = ""; // accumulated CSI parameter bytes, to spot paste guards
  let inPaste = false; // inside a bracketed paste (ESC[200~ … ESC[201~)
  return {
    reset(): void {
      lineBytes = [];
      escState = 0;
      csiParams = "";
      inPaste = false;
    },
    observe(bytes: Uint8Array): void {
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b === undefined) {
          continue;
        }
        if (escState === 1) {
          escState = b === 0x5b ? 2 : b === 0x4f ? 3 : 0; // ESC [ = CSI, ESC O = SS3
          continue;
        }
        if (escState === 2) {
          if (b >= 0x40 && b <= 0x7e) {
            // CSI final byte. Recognize the bracketed-paste guards ESC[200~
            // (start) and ESC[201~ (end) so embedded newlines in a pasted,
            // often multi-line, message are not read as line submissions.
            if (b === 0x7e) {
              if (csiParams === "200") {
                inPaste = true;
              } else if (csiParams === "201") {
                inPaste = false;
              }
            }
            csiParams = "";
            escState = 0; // CSI final byte
          } else if (b >= 0x30 && b <= 0x3f) {
            csiParams += String.fromCharCode(b); // parameter byte (digits, ; ? etc.)
          }
          continue;
        }
        if (escState === 3) {
          escState = 0; // SS3 final byte
          continue;
        }
        if (b === 0x1b) {
          escState = 1; // ESC: start of an escape sequence
        } else if (b === 0x0d || b === 0x0a) {
          // A newline is a line SUBMIT only when it terminates the input. It is
          // folded to a single space (keeping the current line going) when it is
          // instead a paste-internal break, so a multi-line message becomes one
          // logical line whose title reflects its START rather than only its
          // LAST line. Two cases fold:
          //   - inside a bracketed paste (ESC[200~ … ESC[201~), and
          //   - a newline FOLLOWED by more printable input in this SAME chunk:
          //     a human pressing Enter sends the newline as the end of its own
          //     input event, whereas a paste (even one sent WITHOUT bracketed-
          //     paste guards — e.g. an agent shell like kiro-cli that keeps a
          //     pasted multi-line message as one prompt) delivers
          //     text + newline + text together, so trailing content marks the
          //     newline as a soft break, not a submit. Without this, such a
          //     paste left only its last line as the title (the reported
          //     "the title cut off the start of my message").
          let softBreak = inPaste;
          if (!softBreak) {
            for (let j = i + 1; j < bytes.length; j++) {
              const nb = bytes[j];
              if (nb !== undefined && nb >= 0x20) {
                softBreak = true;
                break;
              }
            }
          }
          if (softBreak) {
            if (lineBytes.length > 0 && lineBytes[lineBytes.length - 1] !== 0x20) {
              lineBytes.push(0x20);
            }
            continue;
          }
          const line = new TextDecoder().decode(new Uint8Array(lineBytes)).trim();
          lineBytes = [];
          // Every non-empty submitted line updates the fallback title (the
          // last one wins); a leading "/" counts, since it is a valid shell
          // command path.
          if (line) {
            submit(line.slice(0, MAX_DERIVED));
          }
        } else if (b === 0x7f || b === 0x08) {
          // Backspace: drop one codepoint (pop UTF-8 continuation bytes + lead).
          while (lineBytes.length > 0) {
            const last = lineBytes[lineBytes.length - 1];
            if (last === undefined || (last & 0xc0) !== 0x80) {
              break;
            }
            lineBytes.pop();
          }
          lineBytes.pop();
        } else if (b === 0x03) {
          lineBytes = []; // Ctrl-C: cancel the current line
        } else if (b >= 0x20) {
          lineBytes.push(b); // printable ASCII or a UTF-8 byte
        }
      }
    },
  };
}
