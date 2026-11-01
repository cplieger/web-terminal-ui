/** True when `ev` is the shortcut letter `letter` (lowercase a-z): its `key`, either
 *  case, when the key types an ASCII letter (Dvorak's C is on KeyI), else its physical
 *  `Key<letter>` (Russian С on KeyC, or a non-ASCII Latin letter such as é). */
export function isShortcutLetter(ev: KeyboardEvent, letter: string): boolean {
  if (ev.key.toLowerCase() === letter) {
    return true;
  }
  return ev.code === `Key${letter.toUpperCase()}` && !/^[a-z]$/i.test(ev.key);
}
