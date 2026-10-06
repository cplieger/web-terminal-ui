# Keeping scrollback across a reload

This page covers the `persistScrollback` option, for a developer whose users reopen the terminal after the browser discarded the page, which is the normal case on iOS.

## What it does

A page that is discarded and reloaded comes back holding nothing, so it asks the server for everything and refills its whole buffer over the wire. Safari on iOS evicts backgrounded tabs under memory pressure, and returning to one runs the page again. With a snapshot restored, the resume asks only for what was printed while the tab was gone.

It helps the fresh-load case only. A warm reconnect and an in-page tab switch already replay nothing. It applies to a single terminal and to every tab alike.

## Turning it on

The option takes the storage, not a switch, and it is off until you pass one. `localScrollbackStorage()` is the ready-made storage. It is one import, and it handles the quota sweep, the age bound and an unavailable `localStorage`:

```ts
import { createTerminal, localScrollbackStorage, presetTabbed } from "@cplieger/web-terminal-ui";

createTerminal("#terminal", {
  features: presetTabbed,
  persistScrollback: localScrollbackStorage(),
});
```

web-terminal-kiro, web-terminal-server and marotte's shell panel all turn it on this way. web-terminal-server also gives its operator a switch to turn it off, because it runs a command its operator chooses.

## Why it is off by default

Storage is a decision this library leaves to the application. Chrome's page-lifecycle guidance is to close IndexedDB connections when a page freezes, because a held connection costs the page its back-forward cache entry. This terminal relies on that cache, so it must not own a database.

`localStorage` is also a shared, origin-wide resource of about 5 MB. This package is embedded in applications that keep their own state there, and taking space uninvited could make the host's own writes fail. When the library's storage fails, nothing is restored and the terminal is unaffected. The snapshots also hold terminal output, which the browser can then read without the server.

## Supplying your own storage

Supply your own storage when the snapshots belong somewhere else, such as a shared IndexedDB, a server round-trip or an in-memory cache for a test:

```ts
import { createTerminal } from "@cplieger/web-terminal-ui";
import type { PersistedScrollback } from "@cplieger/web-terminal-ui";

// Read your snapshots into memory BEFORE mounting. See the note below.
const cache = new Map<string, PersistedScrollback>(await loadAllFromIndexedDB());

createTerminal("#terminal", {
  features: presetTabbed,
  persistScrollback: {
    load: (sessionId) => cache.get(sessionId) ?? null,
    save: (sessionId, entry) => {
      cache.set(sessionId, entry);
      void writeToIndexedDB(sessionId, entry); // fire and forget
    },
    drop: (sessionId) => {
      cache.delete(sessionId);
      void deleteFromIndexedDB(sessionId);
    },
  },
});
```

`load` is synchronous. A restore has to be in place before the resume tells the server what the client already holds, and a resume cannot be taken back. So read an asynchronous store into memory first, which also holds no database connection open.

`sessionId` is a real session id, never a key you invent. It is the id the tabs feature uses, or the engine's own per-tab id for a single terminal. The same id is what the saved server boot marker is checked against. Prefix it however you like inside your storage.

## Settings

All of these are optional.

| Setting | Default | Purpose |
| --- | --- | --- |
| `lines` | `200` | How much of each session's tail is written |
| `maxAgeMs` | 7 days | How long an entry may be used |
| `saveIntervalMs` | 10 seconds | The background save interval |
| `prefix` | `"wt.scrollback."` | The key prefix, `localScrollbackStorage` only |
| `maxBytes` | 512 KiB of characters | The total budget, `localScrollbackStorage` only |

The first three go on the `persistScrollback` storage object. `prefix` and `maxBytes` are options of `localScrollbackStorage()`.

`maxBytes` is about 1 MiB of quota, since `localStorage` counts UTF-16 code units. That is about a fifth of a 5 MiB quota, leaving the rest to the host application.

The 200-line default is measured. VS Code's `terminal.integrated.persistentSessionScrollback` restores 100 lines by default. At 200 lines a colored session serializes to about 60 K characters in under a millisecond, against about 300 K and about 4 ms at 1000 lines. A write happens on every backgrounding and on a timer while output advances, so that cost is paid often, on the device this exists for.

## When it writes

The library writes when the page becomes hidden, on `pagehide`, on `destroy()` and on the timer. In every case it writes only a session whose content has advanced since its last save. That check matters because two pages of the same app hold the same session ids, and an unconditional write would let a background page roll back a foreground page's newer entry. `pagehide` is not guaranteed to fire, which is why the timer exists.

## What it refuses

Every storage callback may throw or return nonsense without consequence. A failure means nothing was restored, exactly as if the option were absent.

An entry is also discarded and dropped when it is too old, unreadable, or from a different server process. Line positions only mean anything within one server boot, so an entry that cannot be checked against the live server is thrown away rather than shown. A slow restore is a better failure than a terminal that shows the wrong content.

## No permission prompt

No permission prompt is involved. `localStorage` is not in the Permissions API, so there is nothing for a user to grant or refuse. `navigator.storage.persist()` is the call that can prompt, and this library never makes it. The snapshots are disposable, so asking a user to protect them from eviction would ask for the wrong thing.

Storage can still be unavailable without a prompt, and the failures differ by browser:

- A browser set to block site data throws on access to `window.localStorage`, in Chrome and Firefox.
- Safari has allowed access in private browsing and thrown on the write.
- Firefox can clear storage when it closes.
- Safari's tracking prevention evicts script-writable storage after seven days without interaction.
- A cross-origin iframe embed gets partitioned, short-lived storage rather than the top-level origin's. All three engines partition, and Safari keeps it for the shortest time.

`localScrollbackStorage` guards access as well as writes, so the read side always falls back to nothing restored and the terminal is unaffected. A refused write is reported instead, so the library never records a save that did not happen.

## Cleanup

A store that only writes fills up, so four mechanisms remove entries:

- The terminal calls `drop` when a session closes, so a tab the user closes takes its entry with it. So does a session the server removes while the page is open. This is the one that matters day to day.
- An entry past `maxAgeMs` is deleted when it is next read.
- `localScrollbackStorage` sweeps at construction and after every write. It removes expired entries first, then the oldest until the byte budget fits.
- A rejected entry is always dropped rather than left to be read again.

No mechanism can promptly catch a session that disappeared while the page was closed. Nothing runs then, and no reliable event says a tab is closing for good. That case is the sweep's, which is why a byte budget exists beside the age bound.

The budget is in bytes because an entry count bounds the wrong thing. At the 200-line default, a plain 80-column session is about 24 K characters and a wide colored one about 112 K. A 20-entry allowance would have permitted over 4 MiB of a 5 MiB quota. A single snapshot larger than the whole budget is refused outright, rather than evicting everything for something that still would not fit.
