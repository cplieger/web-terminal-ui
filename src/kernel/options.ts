// Validation for the consumer's numeric options, in ONE place.
//
// The policy is a product decision, not a formatting choice: an out-of-range
// numeric option is REJECTED with a warning and the library default applies. It
// is deliberately not clamped, because clamping hides the mistake — and every
// one of these knobs has a plausible typo that would silently reconfigure
// durability rather than fail (a zero `lines` persists nothing; a zero
// `maxAgeMs` expires everything instantly; a zero `scrollbackLines` would zero
// the scrollback budget).
//
// It lives here because three modules were enforcing it independently and one of
// them did not warn, so the SAME typo was reported or swallowed depending on
// which option carried it — `localScrollbackStorage({ maxAgeMs: 0 })` silently
// took the default while `persistScrollback: { maxAgeMs: 0 }` said so out loud.
// One class of mistake cannot have two reporting policies.

/**
 * A positive integer, or `fallback` with a warning naming `path`.
 *
 * `path` is the full option path as the consumer wrote it
 * (`"persistScrollback.maxAgeMs"`, `"localScrollbackStorage.maxBytes"`), so the
 * warning points at their code rather than at ours.
 */
export function positiveIntOption(
  value: number | undefined,
  fallback: number,
  path: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`web-terminal-ui: ignoring invalid ${path} ${String(value)}`);
    return fallback;
  }
  return value;
}

/**
 * A positive integer, or `undefined` with a warning naming `path`.
 *
 * The same policy for a knob whose absence is meaningful: `scrollbackLines`
 * omitted means "the engine's choice", which is a different statement from any
 * value this library could substitute, so an invalid one must read as omitted.
 */
export function optionalPositiveIntOption(
  value: number | undefined,
  path: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`web-terminal-ui: ignoring invalid ${path} ${String(value)}`);
    return undefined;
  }
  return value;
}
