# Keyboard, mouse and touch input

This page describes how the terminal takes keyboard, mouse and touch input, for a developer embedding it next to other controls or supporting phone users.

## The keyboard target

The terminal output is display-only and is never focused. A hidden `<textarea>` is the single keyboard target, and it also receives IME composition, dictation and autocorrect. Keeping the two apart lets the first touch-drag scroll instead of placing a caret, and lets a text selection survive a redraw.

When a mouse selection leaves focus on the page body, the first key that types something takes the keyboard back for the terminal. A page with its own document-level shortcuts opts out by calling `preventDefault()` on the keys it owns. In that state Tab and modified keys such as Ctrl+C stay with the browser, so copying the selection still works.

Every preset adds a scroll-to-bottom button that returns to live output.

## Touch and the key bar

On a touchscreen, `presetTouch()` and the tabbed presets add a key bar with Tab, Esc, the arrow keys, Enter and a sticky Ctrl. The terminal also handles the iOS soft keyboard, screen rotation and font-load reflows, so the terminal stays sized to the space left above the keyboard.

A clean tap on the terminal focuses the input and raises the soft keyboard. A tap while text is selected clears the selection instead.

## The context menu and paste

The context menu offers Copy, Select All and Paste. It opens on a right-click and on a touch long-press. Paste is the reason it exists. The keyboard target is a hidden `<textarea>`, so no platform can offer its own paste over the output.

On touch the platform keeps its long-press. Word selection and the system copy menu run untouched, and the terminal's menu appears on release only when the press selected nothing. Paste reads the Clipboard API, which needs a secure context, so touch paste needs HTTPS. The system paste gesture on iOS and Cmd+V from an external keyboard also paste into the focused terminal.

## Predictive echo

The predictive-echo feature shows typed characters before the server echoes them back, which hides network latency. It stops predicting at any byte it cannot model, because a wrong prediction is worse than a missing one.

## Mouse reporting

A terminal application that turns on mouse tracking receives the clicks, drags and wheel gestures a user makes in the browser, as SGR reports. The pointer shows it. At rest the terminal carries a text cursor. While an application holds the mouse, the terminal and any links in it carry an arrow instead, because a click goes to that application rather than selecting text or opening the link. Shift-drag still selects and Shift-click still opens a link, following xterm's convention, so nothing becomes unreachable.

Mouse input is best-effort, as in every terminal. A report says where the pointer is at that moment and carries nothing a receiver could use to tell it had gone stale. So a report made while the socket is down is dropped rather than delivered late against a screen that has since been repainted. Typed input keeps its delivery guarantee.

## Focus reporting

The server decides what an application is told about focus. The terminal tells the server whether its own input holds focus, and the server decides what the application hears, so several devices attached to one session cannot contradict each other. A blur that a press causes and the same gesture's click undoes is not reported, because the terminal did not lose focus.
