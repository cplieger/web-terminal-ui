import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  formatTabRoute,
  parseTabAlias,
  parseTabRoute,
  type TabAlias,
  type TabRoute,
} from "./route.js";

const alias = (s: string): TabAlias => s as TabAlias;

describe("parseTabAlias", () => {
  // The same table as the engine's TestSetSessionAlias (terminal/session_alias_test.go):
  // the grammar is a cross-language contract.
  it.each([
    ["sess_6f1c2b9e-0d4a-4e7b-9a51-3c2d1e0f9a8b", true],
    ["k3q7m2xa", true],
    ["x".repeat(64), true],
    ["x".repeat(65), false],
    ["", false],
    ["a%41", false],
    ["a b", false],
    ["a,b", false],
    ["a/b", false],
    ["café", false],
    ["a\n", false],
  ])("parseTabAlias(%j) accepts: %s", (raw, ok) => {
    expect(parseTabAlias(raw)).toBe(ok ? raw : null);
  });

  it.each([[42], [null], [undefined], [{ toString: () => "abc" }]])(
    "refuses the non-string %j",
    (raw) => {
      expect(parseTabAlias(raw)).toBeNull();
    },
  );
});

describe("parseTabRoute", () => {
  it.each<[string, TabRoute]>([
    ["#k3q7m2xa", { kind: "single", tab: alias("k3q7m2xa") }],
    ["k3q7m2xa", { kind: "single", tab: alias("k3q7m2xa") }],
    ["#aaaa,bbbb", { kind: "split", left: alias("aaaa"), right: alias("bbbb") }],
    ["aaaa,bbbb", { kind: "split", left: alias("aaaa"), right: alias("bbbb") }],
    ["#aaaa,", { kind: "split", left: alias("aaaa"), right: null }],
    ["#,bbbb", { kind: "split", left: null, right: alias("bbbb") }],
    ["#constructor", { kind: "single", tab: alias("constructor") }],
    [
      `#${"a".repeat(64)},${"b".repeat(64)}`,
      { kind: "split", left: alias("a".repeat(64)), right: alias("b".repeat(64)) },
    ],
  ])("parseTabRoute(%j)", (hash, want) => {
    expect(parseTabRoute(hash)).toEqual(want);
  });

  it.each([
    "",
    "#",
    "#,",
    "#a,a",
    "#a,b,c",
    `#${"x".repeat(65)}`,
    `#${"a".repeat(64)},${"b".repeat(65)}`,
    "#%41",
    "#a b",
    "#a/b",
    "#a?b",
    "#a.b",
    "#café",
    "#abc\n",
    "#a,%41",
    "##a",
  ])("parseTabRoute(%j) is null", (hash) => {
    expect(parseTabRoute(hash)).toBeNull();
  });
});

describe("formatTabRoute", () => {
  it.each<[TabRoute | null, string]>([
    [null, ""],
    [{ kind: "single", tab: alias("k3q7m2xa") }, "#k3q7m2xa"],
    [{ kind: "split", left: alias("aaaa"), right: alias("bbbb") }, "#aaaa,bbbb"],
    [{ kind: "split", left: alias("aaaa"), right: null }, "#aaaa,"],
    [{ kind: "split", left: null, right: alias("bbbb") }, "#,bbbb"],
  ])("formatTabRoute(%j) = %j", (route, want) => {
    expect(formatTabRoute(route)).toBe(want);
  });
});

const aliasArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/).map(alias);
const routeArb: fc.Arbitrary<TabRoute> = fc.oneof(
  aliasArb.map((tab): TabRoute => ({ kind: "single", tab })),
  fc
    .tuple(fc.option(aliasArb, { nil: null }), fc.option(aliasArb, { nil: null }))
    .filter(([l, r]) => (l !== null || r !== null) && l !== r)
    .map(([left, right]): TabRoute => ({ kind: "split", left, right })),
);

describe("round trip", () => {
  it("parses every formatted route back to itself", () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        expect(parseTabRoute(formatTabRoute(route))).toEqual(route);
      }),
    );
  });

  it("formats every accepted fragment back to the same text", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom("a", "B", "7", "_", "-", ",", "%", ".", " ", "é") }),
        (body) => {
          const route = parseTabRoute(`#${body}`);
          expect(route === null || formatTabRoute(route) === `#${body}`).toBe(true);
        },
      ),
    );
  });
});
