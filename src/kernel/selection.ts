/**
 * The document selection's text when EVERY range has both ends inside
 * `container`, else "". A range dragged out into the host page, a Firefox
 * Ctrl+drag multi-range selection with one range outside, and a bare caret
 * (no text) all answer "". Range ends are in document order whichever way the
 * user dragged. Known limitation: a container inside a host's shadow root never
 * matches, because getSelection() does not reach into shadow trees.
 */
export function selectionTextWithin(container: Element): string {
  const sel = container.ownerDocument.defaultView?.getSelection() ?? null;
  if (sel === null) {
    return "";
  }
  const text = sel.toString();
  if (text.length === 0) {
    return "";
  }
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      return "";
    }
  }
  return text;
}
