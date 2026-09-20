# Third-party notices

No third-party code is included in this package. Three designs are followed, and each is named at the line of ours that follows it:

- The IME composition module mirrors [xterm.js](https://github.com/xtermjs/xterm.js)'s `CompositionHelper` (MIT): the `\u200E` marker pair wrapped around the in-progress text (`src/composition.ts:197`) and the deferred finaliser that reads the textarea one tick after `compositionend` instead of trusting the event's `data` property (`src/composition.ts:211`).
- The mobile switcher's flick-to-commit thresholds take [@use-gesture](https://github.com/pmndrs/use-gesture)'s drag defaults (MIT): `SWIPE_VELOCITY` and `SWIPE_DURATION` (`src/features/tabs/switcher.ts:20`, `:21`) carry its `DEFAULT_SWIPE_VELOCITY` and `DEFAULT_SWIPE_DURATION`, and `VELOCITY_STALE_MS` (`src/features/tabs/switcher.ts:25`) answers the stale release velocity reported in its issue 332.
- The composition staleness bound `COMPOSITION_IDLE_MS` (`src/composition.ts:71`) takes the five-second idle value from [Slate](https://github.com/ianstormtaylor/slate)'s `android-input-manager` (MIT), where it bounds a composition that has gone quiet.
