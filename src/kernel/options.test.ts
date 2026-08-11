// One validation policy for every numeric consumer option: reject out of range,
// warn naming the option the consumer wrote, apply the library default. Never
// clamp — clamping hides a typo that silently reconfigures durability.
//
// These exist because the policy was implemented three times and one copy did
// not warn, so the SAME mistake was reported or swallowed depending only on
// which option bag carried it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { optionalPositiveIntOption, positiveIntOption } from "./options.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("numeric option validation", () => {
  it("passes a positive integer through, both shapes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(positiveIntOption(42, 7, "a.b")).toBe(42);
    expect(optionalPositiveIntOption(42, "c")).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an omitted value as no opinion, silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(positiveIntOption(undefined, 7, "a.b")).toBe(7);
    // Omitted is a DIFFERENT statement from any value this library could pick, so
    // the optional shape must preserve it rather than substitute a default.
    expect(optionalPositiveIntOption(undefined, "c")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects and NAMES every out-of-range shape", () => {
    // Zero is the case that motivates the policy: it is a plausible typo and it
    // means "persist nothing" or "expire everything instantly".
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(positiveIntOption(bad, 7, "persistScrollback.lines")).toBe(7);
      expect(optionalPositiveIntOption(bad, "scrollbackLines")).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain("persistScrollback.lines");
      expect(String(warn.mock.calls[1]?.[0])).toContain("scrollbackLines");
      warn.mockRestore();
    }
  });

  it("never clamps: an out-of-range value does not become the nearest valid one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(positiveIntOption(0, 200, "persistScrollback.lines")).toBe(200);
    expect(positiveIntOption(-5, 200, "persistScrollback.lines")).toBe(200);
  });
});
