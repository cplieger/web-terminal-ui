/** A session alias that has passed `parseTabAlias`: 1 to 64 characters of
 *  `[A-Za-z0-9_-]`, the grammar the engine's `SessionInfo.alias` documents. */
export type TabAlias = string & {
  // deadset:ignore DS1003 -- the brand only makes TabAlias nominal; nothing reads it
  readonly __brand: "TabAlias";
};

// A fragment rather than a path: only a fragment edit navigates without a reload,
// and a library mounted in someone else's page must not claim its path.
/** What a fragment shows: one tab, or the split with a tab (or nothing) in each
 *  pane. A split route names at least one side, and never one alias twice. */
export type TabRoute =
  | { readonly kind: "single"; readonly tab: TabAlias }
  | { readonly kind: "split"; readonly left: TabAlias | null; readonly right: TabAlias | null };

const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
// Two maximal aliases and the separator.
const MAX_ROUTE_LENGTH = 129;

/** The value as an alias, or null for anything outside the grammar, including a
 *  non-string. */
export function parseTabAlias(raw: unknown): TabAlias | null {
  return typeof raw === "string" && ALIAS.test(raw) ? (raw as TabAlias) : null;
}

/** Parse `location.hash` (with or without its `#`): `#<alias>` is one tab and
 *  `#<left>,<right>` the split, either side possibly empty. Null for no fragment
 *  and for any malformed one. Nothing is percent-decoded: the alias alphabet
 *  needs no escaping, so an escape is malformed. */
export function parseTabRoute(hash: string): TabRoute | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (body === "" || body.length > MAX_ROUTE_LENGTH) {
    return null;
  }
  const parts = body.split(",");
  if (parts.length === 1) {
    const tab = parseTabAlias(body);
    return tab === null ? null : { kind: "single", tab };
  }
  if (parts.length !== 2) {
    return null;
  }
  const [rawLeft = "", rawRight = ""] = parts;
  const left = rawLeft === "" ? null : parseTabAlias(rawLeft);
  const right = rawRight === "" ? null : parseTabAlias(rawRight);
  if ((rawLeft !== "" && left === null) || (rawRight !== "" && right === null)) {
    return null;
  }
  if ((left === null && right === null) || left === right) {
    return null;
  }
  return { kind: "split", left, right };
}

/** The fragment for `route`, `#` included, or `""` (no fragment) for null. The
 *  inverse of `parseTabRoute`. */
export function formatTabRoute(route: TabRoute | null): string {
  if (route === null) {
    return "";
  }
  if (route.kind === "single") {
    return `#${route.tab}`;
  }
  return `#${route.left ?? ""},${route.right ?? ""}`;
}
