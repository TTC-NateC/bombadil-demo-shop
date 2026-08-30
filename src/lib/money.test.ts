import { describe, expect, it } from "vitest";
import { formatCents, percentOfBps, roundHalfUp } from "./money";

describe("roundHalfUp", () => {
  it("rounds halves toward +Infinity", () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(-2.5)).toBe(-2);
  });

  it("leaves integers alone", () => {
    expect(roundHalfUp(3)).toBe(3);
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(-7)).toBe(-7);
  });

  it("rounds non-halves normally", () => {
    expect(roundHalfUp(2.4)).toBe(2);
    expect(roundHalfUp(2.6)).toBe(3);
  });
});

describe("percentOfBps", () => {
  it("computes basis points of a base", () => {
    expect(percentOfBps(102000, 1000)).toBe(10200); // 10% — worked example B
    expect(percentOfBps(5000, 2500)).toBe(1250); // 25% — worked example C
    expect(percentOfBps(82000, 1000)).toBe(8200);
  });

  it("rounds halves up", () => {
    // 1005 * 5000 / 10000 = 502.5 -> 503
    expect(percentOfBps(1005, 5000)).toBe(503);
  });

  it("is exact where float math would drift", () => {
    // The classic float trap: 0.1 + 0.2 !== 0.3. Integer math must not care.
    expect(percentOfBps(3, 1000)).toBe(0); // 0.3 -> 0
    expect(percentOfBps(5, 1000)).toBe(1); // 0.5 -> 1
    expect(percentOfBps(1000000000, 833)).toBe(83300000);
  });

  it("returns zero for a zero base or zero rate", () => {
    expect(percentOfBps(0, 2000)).toBe(0);
    expect(percentOfBps(5000, 0)).toBe(0);
  });
});

describe("formatCents", () => {
  it("formats USD", () => {
    expect(formatCents(123456, "USD")).toBe("$1,234.56");
    expect(formatCents(0, "USD")).toBe("$0.00");
    expect(formatCents(599, "USD")).toBe("$5.99");
  });

  it("takes the currency as a parameter rather than reading config", () => {
    expect(formatCents(123456, "EUR")).toContain("1,234.56");
  });
});
