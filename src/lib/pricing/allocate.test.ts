import { describe, expect, it } from "vitest";
import { allocate } from "./allocate";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocate", () => {
  it("splits proportionally when it divides evenly", () => {
    // Worked example B's second coupon: 8200 across [80000, 2000].
    expect(allocate(8200, [80000, 2000])).toEqual([8000, 200]);
  });

  it("distributes leftover pennies to the largest remainders", () => {
    // 100 / 3 = 33.33 each; the first two indices take the spare cent.
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(sum(allocate(100, [1, 1, 1]))).toBe(100);
  });

  it("breaks remainder ties on the lower index, deterministically", () => {
    const first = allocate(10, [1, 1, 1, 1]);
    for (let i = 0; i < 50; i++) {
      expect(allocate(10, [1, 1, 1, 1])).toEqual(first);
    }
    expect(first).toEqual([3, 3, 2, 2]);
  });

  it("handles amounts smaller than the weight count", () => {
    const parts = allocate(2, [5, 5, 5, 5, 5]);
    expect(sum(parts)).toBe(2);
    expect(parts.filter((p) => p > 0)).toHaveLength(2);
  });

  it("returns zeros for a zero total, zero amount, or no weights", () => {
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
    expect(allocate(0, [10, 20])).toEqual([0, 0]);
    expect(allocate(500, [])).toEqual([]);
  });

  it("gives the whole amount to a single weight", () => {
    expect(allocate(1234, [999])).toEqual([1234]);
  });

  it("ignores zero-weight lines while still summing to the whole", () => {
    const parts = allocate(999, [0, 100, 0, 200]);
    expect(parts[0]).toBe(0);
    expect(parts[2]).toBe(0);
    expect(sum(parts)).toBe(999);
  });

  // The property that everything downstream depends on (§5.2).
  it("always sums to the whole, across randomised inputs", () => {
    let seed = 987654321;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let trial = 0; trial < 3000; trial++) {
      const count = 1 + rand(8);
      const weights = Array.from({ length: count }, () => rand(50_000));
      const amount = rand(200_000);
      const parts = allocate(amount, weights);

      const total = sum(weights);
      expect(parts).toHaveLength(count);
      expect(sum(parts), `amount=${amount} weights=${weights}`).toBe(total === 0 ? 0 : amount);
      parts.forEach((p) => expect(p).toBeGreaterThanOrEqual(0));
    }
  });

  it("never allocates to a line more than its proportional share plus a penny", () => {
    const weights = [1, 1000000];
    const parts = allocate(1000, weights);
    expect(parts[0]).toBeLessThanOrEqual(1);
    expect(sum(parts)).toBe(1000);
  });
});
