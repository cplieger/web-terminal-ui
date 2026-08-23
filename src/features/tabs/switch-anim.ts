// The switch-animation class → keyframe-name map, in one place because two
// unrelated languages have to agree on it and neither compiler checks the other.
//
// `css/40-animations.css` declares the animation on `.term-output` for each of the
// three `wt-switching*` classes the tabs feature toggles, and `features/tabs`
// listens for the `animationend` of the ONE name that belongs to the switch it
// started (a listener accepting any of the three lets a completed animation end the
// NEXT switch a frame in). So the JS holds a copy of three CSS keyframe names, and a
// rename on either side is silent: the listener stops matching, the class comes off
// on the 360 ms fallback timer instead of the animation's own end, and every test
// still passes because the tests dispatch the JS constant.
//
// Living here rather than inside the feature is what lets `css-contract.node.test.ts`
// import it and assert the CSS agrees. Same reason `input-placeholder.ts` and
// `kernel/gesture.ts` exist: a constant two places must keep in lockstep gets its
// own module. NOT part of the package's `exports` map, so it is internal and can
// change without a release note; the PUBLIC name contracts live in
// `kernel/style-contract.ts`.
export const SWITCH_ANIMATIONS = {
  "wt-switching": "wt-switch-in",
  "wt-switching-next": "wt-switch-next",
  "wt-switching-prev": "wt-switch-prev",
} as const;

/** A class the tabs feature puts on the terminal surface to play a switch animation. */
export type SwitchClass = keyof typeof SWITCH_ANIMATIONS;

/** The three classes, for a caller that has to clear whichever one is present. */
export const SWITCH_CLASSES = Object.keys(SWITCH_ANIMATIONS) as SwitchClass[];
