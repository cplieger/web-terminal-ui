// Single source of truth for the hidden-textarea placeholder shared by
// mount.ts and composition.ts.
//
// A single-character placeholder is kept in the hidden textarea so iOS soft
// keyboards have something to "delete" when the user holds Backspace. iOS only
// fires repeating `input` events with inputType="deleteContentBackward" when
// the textarea has content to delete; with a perpetually empty textarea,
// holding Backspace deletes one char and stops because iOS sees nothing more to
// remove. The placeholder itself is invisible (textarea has opacity:0) and is
// stripped out of every send. NBSP is chosen specifically so screen-reader
// announcement of the input state stays empty-ish rather than "space".
//
// The constant AND the reset routine must stay in lockstep across the two
// modules (mount.ts seeds + re-pads it; composition.ts restores it on
// compositionend / paste) or the iOS held-Backspace key-repeat silently breaks
// with no compile error — which is why they live here in one place.
export const INPUT_PLACEHOLDER = "\u00A0";

// Restore the placeholder and put the cursor at the end, so the next typed
// character appends after it rather than before.
export function resetToPlaceholder(textarea: HTMLTextAreaElement): void {
  textarea.value = INPUT_PLACEHOLDER;
  try {
    textarea.setSelectionRange(INPUT_PLACEHOLDER.length, INPUT_PLACEHOLDER.length);
  } catch {
    // Some older WebKit builds throw on setSelectionRange against a
    // visually-hidden textarea; ignore.
  }
}
