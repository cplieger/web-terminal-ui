/** The window of a document that has one; a document with no browsing context
 *  (a parsed or created document) cannot lay out or focus a terminal. */
export function windowOf(doc: Document): Window {
  const win = doc.defaultView;
  if (win === null) {
    throw new Error("web-terminal-ui: the mount target's document has no window");
  }
  return win;
}
