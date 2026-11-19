/** Counts the history entries pushed since the call. Chromium keeps at most 50
 *  entries per tab and every test file shares the tab, so `history.length` stops
 *  moving; a replace keeps the current entry's navigation key and a push makes a
 *  new one (https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-navigationhistoryentry-key). */
export function pushesSince(): () => number {
  const start = navigation.currentEntry;
  if (start === null) {
    throw new Error("no current history entry");
  }
  return () => {
    const at = navigation.entries().find((e) => e.key === start.key);
    const now = navigation.currentEntry;
    if (at === undefined || now === null) {
      throw new Error("the marked history entry is gone");
    }
    return now.index - at.index;
  };
}
