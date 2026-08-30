/**
 * Phase 9 task 9.1. specs/02 §9.6 — pure helpers, fixed seed, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  charmRound,
  composeName,
  generateCoupons,
  generateProducts,
  makeSlugFactory,
  pickPrice,
  resolveTemplate,
  type Pools,
} from "./generate";
import { cyclingSampler, makeRng } from "./rng";

const POOLS: Pools = {
  productNames: ["Mug", "Lamp", "Chair", "Notebook"],
  descriptions: ["Sturdy and plain.", "Made to last."],
  categories: ["Home", "Office"],
  adjectives: ["Matte", "Ceramic"],
  couponTemplates: [],
  priceConfig: { minCents: 1000, maxCents: 9000, roundTo: 99 },
};

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const a = Array.from({ length: 10 }, makeRng(1234));
    const b = Array.from({ length: 10 }, makeRng(1234));
    expect(a).toEqual(b);
  });

  it("differs between seeds", () => {
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });
});

describe("cyclingSampler", () => {
  it("exhausts the pool before repeating", () => {
    const next = cyclingSampler(makeRng(7), ["a", "b", "c"]);
    const first = [next(), next(), next()];
    expect([...first].sort()).toEqual(["a", "b", "c"]);
    expect(next()).toBeDefined(); // starts a new cycle
  });

  it("returns undefined for an empty pool", () => {
    expect(cyclingSampler(makeRng(1), [])()).toBeUndefined();
  });
});

describe("composeName", () => {
  it("is deterministic at a fixed seed", () => {
    expect(composeName(makeRng(99), POOLS.productNames, POOLS.adjectives)).toBe(
      composeName(makeRng(99), POOLS.productNames, POOLS.adjectives),
    );
  });

  it("works with no adjectives", () => {
    const name = composeName(makeRng(5), POOLS.productNames, []);
    expect(POOLS.productNames).toContain(name);
  });
});

describe("charmRound", () => {
  it("forces the price to end in roundTo", () => {
    // Rounds to the containing hundred, then applies the ending — so a price
    // can rise by up to 99 cents, never fall below its own hundred.
    expect(charmRound(4523, 99, 1000)).toBe(4599);
    expect(charmRound(4599, 99, 1000)).toBe(4599);
    expect(charmRound(2000, 99, 1000)).toBe(2099);
    expect(charmRound(4400, 99, 1000)).toBe(4499);
  });

  it("bumps up rather than falling below the floor", () => {
    expect(charmRound(1010, 99, 1050)).toBe(1099);
  });

  it("is a no-op when roundTo is absent", () => {
    expect(charmRound(4523, undefined, 0)).toBe(4523);
  });
});

describe("pickPrice", () => {
  it("respects the bounds and the charm ending", () => {
    const rng = makeRng(2024);
    for (let i = 0; i < 200; i++) {
      const price = pickPrice(rng, POOLS.priceConfig, "Home");
      expect(price % 100).toBe(99);
      expect(price).toBeGreaterThanOrEqual(1000);
      expect(price).toBeLessThanOrEqual(9099);
    }
  });

  it("honours perCategory overrides", () => {
    const config = { ...POOLS.priceConfig, perCategory: { Office: { minCents: 20000, maxCents: 21000 } } };
    const price = pickPrice(makeRng(3), config, "Office");
    expect(price).toBeGreaterThanOrEqual(20000);
  });
});

describe("makeSlugFactory", () => {
  it("suffixes on collision within a run", () => {
    const next = makeSlugFactory([]);
    expect(next("Matte Mug")).toBe("matte-mug");
    expect(next("Matte Mug")).toBe("matte-mug-2");
    expect(next("Matte Mug")).toBe("matte-mug-3");
  });

  it("avoids slugs already in the catalog", () => {
    // This is what makes a second `npm run stage` without --reset append
    // cleanly instead of 409ing on most rows.
    const next = makeSlugFactory(["matte-mug", "matte-mug-2"]);
    expect(next("Matte Mug")).toBe("matte-mug-3");
  });
});

describe("generateProducts", () => {
  it("produces exactly the requested count with unique slugs", () => {
    const products = generateProducts(makeRng(11), POOLS, 50);
    expect(products).toHaveLength(50);
    expect(new Set(products.map((p) => p.slug)).size).toBe(50);
  });

  it("is byte-identical at a fixed seed", () => {
    expect(JSON.stringify(generateProducts(makeRng(77), POOLS, 20))).toBe(
      JSON.stringify(generateProducts(makeRng(77), POOLS, 20)),
    );
  });

  it("only uses categories from the pool", () => {
    for (const product of generateProducts(makeRng(3), POOLS, 30)) {
      expect(POOLS.categories).toContain(product.category);
    }
  });
});

describe("resolveTemplate", () => {
  it("returns null for a CATEGORY template with no categories available", () => {
    // --products 0 leaves the catalog empty; the run must not fail.
    const coupon = resolveTemplate(
      makeRng(1),
      { type: "PERCENT", valueRange: [1000, 2000], targetType: "CATEGORY" },
      [],
      new Set(),
    );
    expect(coupon).toBeNull();
  });

  it("resolves a CATEGORY template against a real category", () => {
    const coupon = resolveTemplate(
      makeRng(1),
      { type: "PERCENT", valueRange: [1000, 2000], targetType: "CATEGORY" },
      ["Home"],
      new Set(),
    );
    expect(coupon?.targetType).toBe("CATEGORY");
    expect(coupon?.targetValue).toBe("Home");
  });

  it("fills valueRange and minSubtotalRange from the seed", () => {
    const coupon = resolveTemplate(
      makeRng(9),
      { type: "FIXED", valueRange: [500, 2000], minSubtotalRange: [3000, 8000] },
      [],
      new Set(),
    );
    expect(coupon!.value).toBeGreaterThanOrEqual(500);
    expect(coupon!.value).toBeLessThanOrEqual(2000);
    expect(coupon!.minSubtotalCents).toBeGreaterThanOrEqual(3000);
    expect(coupon!.minSubtotalCents).toBeLessThanOrEqual(8000);
  });
});

describe("generateCoupons", () => {
  it("guarantees one of each interesting case", () => {
    const coupons = generateCoupons(makeRng(5), [], 12, ["Home", "Office"]);

    expect(coupons.some((c) => c.type === "PERCENT" && c.stackable)).toBe(true);
    expect(coupons.some((c) => c.type === "FIXED" && c.minSubtotalCents)).toBe(true);
    expect(coupons.some((c) => c.type === "FREE_SHIPPING")).toBe(true);
    expect(coupons.some((c) => !c.stackable)).toBe(true);
    expect(coupons.some((c) => c.targetType === "CATEGORY")).toBe(true);
  });

  it("produces unique codes", () => {
    const coupons = generateCoupons(makeRng(21), [], 40, ["Home"]);
    expect(new Set(coupons.map((c) => c.code)).size).toBe(coupons.length);
  });

  it("avoids codes already in the catalog", () => {
    const existing = generateCoupons(makeRng(4), [], 10, ["Home"]).map((c) => c.code);
    const next = generateCoupons(makeRng(4), [], 10, ["Home"], existing);
    for (const coupon of next) expect(existing).not.toContain(coupon.code);
  });

  it("is byte-identical at a fixed seed", () => {
    expect(JSON.stringify(generateCoupons(makeRng(31), [], 15, ["Home", "Office"]))).toBe(
      JSON.stringify(generateCoupons(makeRng(31), [], 15, ["Home", "Office"]))
    );
  });

  it("still produces coupons when there is no catalog at all", () => {
    // --products 0 --coupons 15 must not fail; the CATEGORY template is skipped.
    const coupons = generateCoupons(makeRng(8), [], 15, []);
    expect(coupons.length).toBeGreaterThan(0);
    expect(coupons.every((c) => c.targetType !== "CATEGORY")).toBe(true);
  });
});
