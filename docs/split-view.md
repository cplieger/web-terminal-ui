# Split view

This page describes the `split: true` option, which shows two tabs side by side, for a developer deciding whether to turn it on and what it changes in the page.

## What it needs and what it changes

The split view needs the tabs feature, because the tab row, the split button, the snap items and the layout record all live there. Pass `tabs()` or a tabbed preset in `features`. A terminal without the tabs feature fails at `kernel-init`, and so does a `split` value other than `true` or `false`. Under `presetSingle()` or `presetTouch()` the option is unavailable, and `css/32-split.css` ships only in `css/MANIFEST` and `css/MANIFEST.tabbed`.

With the option on, your root becomes the shell root. It holds the shared chrome and one root per pane. Each pane is a complete terminal with its own engine, so an open split holds up to two WebSocket connections, one per shown pane. A terminal built without the option keeps the single-pane DOM.

Closing and resizing the split only rearranges the display. No tab or session is created or closed by it, and a tab that leaves a pane stays in the row as an ordinary tab. Opening it is the same, except with a single tab. Then the split button, a snap or a drop that opens the split creates the second tab.

## Opening the split

Three tab-chrome actions open the split, and none is a key chord.

### The split button

The split button sits at the right edge of the tab row, and in the mobile switcher bar on a touchscreen. It toggles the split and never opens an empty pane. The current tab stays in the left pane and selected. The right pane shows the tab used before it, or with no such tab the next tab in the row, else the previous one.

With a single tab, the button creates a new tab and shows it on the right, selected. The split opens once the new tab exists. Closing keeps the selected pane's tab and hides the other pane.

Opening slides the divider in from the right edge, and closing slides it toward the hidden side. Both are instant under reduced motion. It is an ordinary button: Tab reaches it, Enter or Space toggles it, and `aria-expanded` is its state.

### Snap to left and Snap to right

**Snap to left** and **Snap to right** are in a tab's context menu. The menu opens on a right-click, a touch long-press, or from the keyboard with the context-menu key or Shift+F10 on the focused tab, where the browser raises the menu event. Safari binds no key to it, so a keyboard-only user there reaches the menu through an assistive technology's own command.

A snapped tab shows on the named side, and its pane is selected. When the snap opens the split, the other pane keeps the tab the single view showed. When that tab is the one being moved, the other pane keeps its split partner instead, so neither pane opens empty.

With a single tab, a snap that opens the split creates a new tab for the other pane, and the split opens once that tab exists. A failed create leaves the single view as it was.

In an open split, a tab the other pane shows trades places with the tab on the named side, so both stay on screen. Into an empty pane, the tab moves without displacing another tab. Any other tab on the named side becomes an ordinary tab. Snapping a tab onto the side that already shows it changes nothing.

### Dragging a tab

Drag a tab out of the row onto either pane of the terminal area. The same rule as a snap applies. By touch or pen, hold the tab still for a moment before moving it, because a swipe that moves at once scrolls the row instead.

While the drag lasts, the pane under the pointer is highlighted. Each highlight covers that pane's terminal area at the divider's position, or the two halves while the split is closed. It is inset a little, with the tab chips' rounded border. A release decides by the divider's center.

## Which pane a tab opens in

A tab click follows one rule. An empty pane fills first, otherwise the selected pane's tab is replaced.

A new tab from **+** also fills an empty pane first. With both panes showing a tab, it replaces the unselected pane's tab and that pane becomes selected, so the tab you typed in stays on screen. A session created in another browser lands the same way while the split is open. With the split closed it joins the row as an ordinary tab.

Closing a shown tab closes the split. The other pane's tab fills the view and is selected. When the other pane was empty, the neighboring tab is shown with one pane.

## The selected pane

The selected pane is the one that receives typing, the last one clicked, touched or typed in. The divider shows it. It is an 8 px bar in the 10 px gutter, holding a short accent pill that sits against the selected pane's side. The pill slides across when the selection changes, and jumps under reduced motion.

The selected pane keeps the filled blinking cursor, and the other pane's cursor is hollow and steady. In the tab row both shown tabs render active, the selected pane's a step brighter. A screen reader hears "Left terminal selected" or "Right terminal selected" as a polite announcement. Each pane's tabpanel is described by its side and whether it is selected.

While the split is open, each shown pane's input is a stop in the Tab order. Tab runs through the left pane, the divider, the right pane, then the tab row. An empty pane adds no stop. With the split closed, the one pane is entered by typing or a click, and Tab from outside the terminal lands on the tab row.

## Resizing

The divider handle is a focusable `role="separator"` whose `aria-valuenow`, `aria-valuemin` and `aria-valuemax` are percentages of the left share. Drag it with a mouse or by touch. Its hit area is 24 px wide for a fine pointer and 44 px for a coarse one, overlapping the pane edges. Both panes resize as the pointer moves. The terminals are told their new size at most every 100 ms, and once on release.

A pane has a 360 px minimum. Past it, the pane holds at exactly 360 px for 120 px of further pointer travel, and a release there leaves it at 360 px. Beyond that, the pane follows the pointer again and dims, and a release there closes it. Coming back above 360 px after such a trip and releasing snaps the handle back to where the drag started.

From the keyboard, ArrowLeft and ArrowRight move the divider by 16 px, and Home and End take it to the bounds. Every key stops at the 360 px minimum rather than closing a pane. The layout is saved when the key is released. The default split is 50/50.

## Narrow screens

Under 730 px of pane-row width, which is two minimum panes and the gutter, the split buttons hide, the snap items are disabled and a drop does nothing. An open split collapses to the selected pane and restores itself when the row is wide again.

At 730 px or wider, a window resize keeps both panes at 360 px or more by clamping the displayed share. The share the user chose is remembered and comes back when the row is wide enough for it.

## Where the layout is saved

The server keeps the arrangement beside the tab order, through `GET` and `PUT /api/sessions/layout`. The record holds the session in each pane, the divider share, the selected pane and whether the split is open. It is read once at load, written on every change, and lives as long as the session list. A reload or another device therefore restores the same panes, and the active tab is the selected pane's session.

Against a server without that route, the split still works and nothing is saved. One console warning says so.

## Writing features for a split

Two rules apply to a `features` function under `split: true`, and both are checked at `kernel-init`.

- It is called once per pane and must return new feature objects every time, because a feature object's `api` and its `ctx.use` identity belong to one pane. A saved array, such as `const f = presetTabbed(); features: () => f`, is refused with an error naming the reused feature.
- A feature that must exist once per terminal rather than once per pane declares `scope: "shell"`. The built-in tabs, key bar, activity monitor and animations do. Such a feature is set up once, from the first call. Its context's `surface`, `render`, `scroll`, `modes`, `session`, `send` and `paste` resolve to the selected pane at call time, and `ctx.shell.pane(side)` reaches one pane explicitly.

## The split controller

With `split: true`, the handle's `split` member is a `SplitController`. It has `enabled`, `state()`, `isOpen()`, `canOpen()`, `open()`, `close()`, `closeSide(side)`, `setRatio(ratio, commit)` and `onChange(callback)`. `state()` returns `open`, `collapsed`, `ratio`, `committedRatio` and `selected`. A terminal built without `split` has no `split` member on its handle.
