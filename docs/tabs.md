# Tabs, activity dots and notifications

This page describes what `presetTabbed()` and `presetAgentTabbed()` show on each tab and when they notify, for a developer choosing between the two or theming them.

## What the tabbed presets need

Both presets need a server that serves the engine's session API: `/api/sessions`, `/ws?session=` and the status stream `/api/sessions/events`. web-terminal-server and web-terminal-kiro serve it. The server also keeps the tab order and, for the split view, the pane layout, so both travel between devices.

## Tabs on a phone

On a wide screen the tabs sit in a strip along the bottom edge. When the terminal is 600 px wide or less, or 500 px tall or less, the strip becomes a switcher bar that shows the current tab. Swipe the bar sideways to change tab. Swipe it up or tap it to open a list of your other tabs.

## Tab titles

A tab's title is whatever the server reports for the session. The program's own window title, set through OSC 0 or OSC 2, comes first and stays current while the program changes it. Without one, the server infers a name from the foreground process or the working directory. A user can rename a tab from its menu, and the server keeps that name.

A full-page terminal also names the browser tab after the active tab, the selected pane's tab in a split, followed by the title the page was served with: `fix build · Web Terminal`. The tab comes first, so a browser that shortens a long title cuts the page title, not the tab. The name follows every switch and rename, and the `(N)` count stays in front of it. With no tab open the browser tab shows the served title alone, and so does a page after `destroy()`.

## Each tab's address

A full-page terminal (`layout: "viewport"`) puts the shown tab in the page address, after a `#`. The name is the session's alias, which the server reports with each session: a random 8-character name on web-terminal-server, and the kiro-cli session id on web-terminal-kiro. Opening that address, reloading it or pasting it into another browser tab shows that tab. The address needs engine 6.2 or later on the server. With an older server the address carries no fragment.

Switching tabs adds a history entry, so the browser's back and forward buttons move between the tabs you looked at. Editing the fragment by hand shows the tab it names without reloading the page. A change of alias, such as kiro-cli starting a new session in the same tab, rewrites the current entry instead of adding one. The address only shows tabs that are already open. It never opens or closes a terminal.

An address naming a tab that is no longer open keeps what is shown and rewrites the address to match. A fresh load or a hand-edited address also shows "That tab is no longer open". A reload and the back and forward buttons correct the address without a message. While a live tab is open, a fresh load naming a tab whose program has ended opens on a live tab instead, also without a message. An embedded terminal (`layout: "container"`) leaves the page address to its host. [Split view](split-view.md#the-splits-address) describes the address of two panes.

## The activity dot

Each tab can carry a status dot that the activity monitor drives from the server's status stream. Under `presetTabbed()` the dot appears only once a session reports `OSC 9;4` progress, so a plain shell keeps clean, label-only tabs. Under `presetAgentTabbed()` the idle dot shows from the moment the tab opens.

The dot has eight states:

- three animated progress states from `OSC 9;4`, for working, warning and error
- a still, ringed dot for a program waiting on the user
- a green disc for a finished turn and a red disc for a crashed process
- two hollow dots, one for idle and a dim one for an ended session

When a program reports a percentage, the chip also draws a 2px progress bar. It shows only while one of the three progress states is current. The number itself is announced in the tab's accessible name and drawn nowhere. A chip that shrinks toward a 100px minimum has no room for it. It is never written to the browser's document title either, since one page title cannot represent several sessions.

## The background-activity mark

Beside the dot, every chip can carry a second mark for a host-reported background task that outlives a turn. web-terminal-kiro uses it for a workflow run. The mark is a rounded-square ring, so it does not read as a second status dot. The width of its band carries three states:

- While a task runs, a 2px band whose center closes and reopens on each beat.
- While a task is paused and resumable, a 1px band with a halo.
- While a task is blocked on the user, a 2px band with the same halo.

The state and the count are announced in the tab's accessible name and repeated as the mark's tooltip. The mark is independent of the dot, so a tab can show one and not the other. With no background activity it takes no width, so the chip measures the same as a chip without it. It draws from `--status-working` and `--status-input`, so theming the dot palette themes the mark too.

## Browser notifications

When a program raises an OSC 9 notification and the user is not looking at that terminal, the tabs feature posts a browser notification. Permission is requested on a user gesture. A denied permission leaves the tab dots as the only signal.

Clicking a notification switches to the session that raised it. These are non-persistent notifications. A browser that does not offer the Notification constructor, or refuses it, leaves the tab dots as the signal. iOS Safari outside an installed web app is one such browser.

## Cues outside the page

While a background tab wants the user, the tabs feature puts a `(N)` count at the start of the document title. It also sets the app badge with `navigator.setAppBadge`. A cue the user has already seen stays dismissed across a reload.

With `attentionIcons: true`, passed as `features: () => presetTabbed({ attentionIcons: true })`, it also swaps the page's icon links to a status variant. It is off by default, because the variant images are files your page must serve.
