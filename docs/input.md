# Keyboard, mouse and touch input

This page describes how the terminal takes keyboard, mouse and touch input, for a developer embedding it next to other controls or supporting phone users.

## The keyboard target

The terminal output is display-only and is never focused. A hidden `<textarea>` is the single keyboard target, and it also receives IME composition, dictation and autocorrect. Keeping the two apart lets the first touch-drag scroll instead of placing a caret, and lets a text selection survive a redraw.

When a mouse selection leaves focus on the page body, the first key the terminal acts on takes the keyboard back and reaches the terminal. That covers typed characters and the Ctrl, Alt and Cmd combinations the terminal encodes, such as Ctrl+G. A page with its own document-level shortcuts opts out by calling `preventDefault()` on the keys it owns.

On an iPad with a hardware keyboard, a press on the terminal also gives focus to the page body, so that text can be selected natively. The terminal then takes the keys typed on the body itself, as long as the last press landed inside it. A page with its own `keydown` listener on the document, such as a type-ahead into a search field, must leave a key alone when focus is on the body and the last pointer press landed inside the terminal. Otherwise the listener takes keys meant for the terminal. Listen for `pointerdown` in the capture phase to know where the last press landed.

In that state Tab stays with the browser. While the terminal holds a selection, Ctrl+C and Ctrl+Insert copy it, as Cmd+C does. Combinations the terminal does not encode, such as Cmd+V, also stay with the browser.

Every preset adds a scroll-to-bottom button that returns to live output.

## Touch and the key bar

On a touchscreen, `presetTouch()` and the tabbed presets add a key bar with Tab, Esc, the arrow keys, Enter and a sticky Ctrl. A sticky Ctrl applies to the next character typed, and any other input releases it. The terminal also handles the iOS soft keyboard, screen rotation and font-load reflows, so the terminal stays sized to the space left above the keyboard.

A clean tap on the terminal focuses the input and raises the soft keyboard. A tap while text is selected clears the selection instead.

## The context menu and paste

The context menu offers Copy, Select All and Paste. It opens on a right-click and on a touch long-press. Paste is the reason it exists. The keyboard target is a hidden `<textarea>`, so no platform can offer its own paste over the output.

On touch the platform keeps its long-press. Word selection and the system copy menu run untouched, and the terminal's menu appears on release only when the press selected nothing. Paste reads the Clipboard API, which needs a secure context, so touch paste needs HTTPS. The system paste gesture on iOS and Cmd+V from an external keyboard also paste into the focused terminal.

A paste of any size is delivered whole and in order, and keys typed during it reach the program after it. While part of a paste is still waiting to be sent, a toast shows how much is left. Escape or Ctrl+C, from the keyboard or the key bar, drops the rest. The program still receives the closing bracket of a bracketed paste, then the Escape or Ctrl+C itself, so it never stays in paste mode. A cancel cannot recall bytes the server already has.

Input typed while the connection is down, or before a newly shown session has reported its terminal modes, waits and is sent once the modes are known, so keys and pastes follow the modes the program has set. If the server restarted meanwhile, that input is dropped with the rest of what was meant for the old process, and the terminal says it restarted. Each waiting input moves the view when it is sent, in the order typed: a page key the program leaves to the terminal scrolls, and anything else returns to live output. In that window a Ctrl, Alt or Cmd combination that only some modes send, such as Ctrl+= under the kitty keyboard protocol, stays with the browser.

## Predictive echo

The predictive-echo feature moves a ghost cursor as you type, before the server echoes your typing back, which hides network latency. It predicts plain ASCII characters and Backspace only, against the server's screen width. Anything else (an accented letter, Chinese or Japanese text, an emoji, Enter, Tab, an arrow key) and anything at the end of a line stops the prediction until the server's next update, because a wrong prediction is worse than a missing one. It never changes what is sent.

## Mouse reporting

A terminal application that turns on mouse tracking receives the clicks, drags and wheel gestures a user makes in the browser, as SGR reports. The pointer shows it. At rest the terminal carries a text cursor. While an application holds the mouse, the terminal and any links in it carry an arrow instead, because a click goes to that application rather than selecting text or opening the link. Shift-drag still selects and Shift-click still opens a link, following xterm's convention, so nothing becomes unreachable.

Mouse input is best-effort, as in every terminal. A report says where the pointer is at that moment and carries nothing a receiver could use to tell it had gone stale. So a report made while the socket is down is dropped rather than delivered late against a screen that has since been repainted. Typed input keeps its delivery guarantee.

## Focus reporting

The server decides what an application is told about focus. The terminal tells the server whether its own input holds focus, and the server decides what the application hears, so several devices attached to one session cannot contradict each other. A blur that a press causes and the same gesture's click undoes is not reported, because the terminal did not lose focus.
