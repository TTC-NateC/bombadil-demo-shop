/**
 * Phase 3 tasks 3.2-3.6 — the full specs/01 §5.8 matrix.
 *
 * Every test ends with assertInvariants (§5.2). Money assertions are literal
 * expected cents from §5.7's worked examples, never numbers the test recomputes.
 */
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "./config";
import { appliedCodes, priceCart } from "./engine";
import { assertInvariants } from "./invariants";
import { REASONS } from "./reasons";
import type { EngineCoupon, PriceCartInput, PricedCart, PricingLineInput, StoreConfig } from "./types";

// --- builders ---------------------------------------------------------------

function item(over: Partial<PricingLineInput> & { unitPriceCents: number }): PricingLineInput {
  return {
    productId: over.productId ?? "p1",
    name: over.name ?? "Product",
    category: over.category,
    quantity: over.quantity ?? 1,
    unitPriceCents: over.unitPriceCents,
  };
}

function coupon(over: Partial<EngineCoupon> & { code: string }): EngineCoupon {
  return {
    code: over.code,
    description: over.description ?? over.code,
    type: over.type ?? "PERCENT",
    value: over.value ?? 1000,
    targetType: over.targetType ?? "CART",
    targetValue: over.targetValue ?? null,
    minSubtotalCents: over.minSubtotalCents ?? null,
    maxDiscountCents: over.maxDiscountCents ?? null,
    stackable: over.stackable ?? true,
    priority: over.priority ?? 100,
    startsAt: over.startsAt ?? null,
    endsAt: over.endsAt ?? null,
    active: over.active ?? true,
  };
}

/** Prices, then asserts every §5.2 invariant before handing the result back. */
function price(input: Omit<PriceCartInput, "config"> & { config?: StoreConfig }): PricedCart {
  const result = priceCart({ ...input, config: input.config ?? CONFIG_DEFAULTS });
  assertInvariants(result);
  return result;
}

const reasonFor = (priced: PricedCart, code: string) =>
  priced.rejectedCoupons.find((r) => r.couponCode === code)?.reason;

// --- baseline ---------------------------------------------------------------

describe("baseline", () => {
  it("empty cart prices to zeros", () => {
    const priced = price({ items: [], coupons: [] });
    expect(priced.subtotalCents).toBe(0);
    expect(priced.discountTotalCents).toBe(0);
    expect(priced.taxCents).toBe(0);
    // Below the free-shipping threshold, but an empty cart still shows flat
    // shipping — the cart page never renders this state (§8.3 empty state).
    expect(priced.totalCents).toBe(CONFIG_DEFAULTS.shippingFlatCents);
  });

  it("single item, no coupon", () => {
    const priced = price({ items: [item({ unitPriceCents: 2000, quantity: 2 })], coupons: [] });
    expect(priced.subtotalCents).toBe(4000);
    expect(priced.discountLines).toHaveLength(0);
    expect(priced.shippingCents).toBe(599);
    expect(priced.taxCents).toBe(320); // 8% of 4000
    expect(priced.totalCents).toBe(4919);
  });

  it("free-shipping threshold zeroes shipping with no coupon and no discount line", () => {
    const priced = price({ items: [item({ unitPriceCents: 5000 })], coupons: [] });
    expect(priced.shippingCents).toBe(0);
    expect(priced.shippingDiscountCents).toBe(0);
    expect(priced.discountLines).toHaveLength(0);
  });
});

// --- worked example A (§5.7A, defect #1) ------------------------------------

describe("worked example A — free shipping is subtracted once", () => {
  it("matches the spec exactly", () => {
    const priced = price({
      items: [item({ unitPriceCents: 4000 })],
      coupons: [coupon({ code: "FREESHIP", type: "FREE_SHIPPING", value: 0 })],
    });

    expect(priced.discountTotalCents).toBe(0);
    expect(priced.shippingDiscountCents).toBe(599);
    expect(priced.shippingCents).toBe(0);
    expect(priced.taxCents).toBe(320);
    expect(priced.totalCents).toBe(4320); // NOT 3673 — that would be defect #1
  });

  it("keeps the shipping discount out of discountTotalCents", () => {
    const priced = price({
      items: [item({ unitPriceCents: 4000 })],
      coupons: [coupon({ code: "FREESHIP", type: "FREE_SHIPPING", value: 0 })],
    });
    const shippingLine = priced.discountLines.find((l) => l.appliedTo === "SHIPPING");
    expect(shippingLine?.amountCents).toBe(599);
    expect(priced.discountTotalCents).toBe(0);
  });

  it("rejects FREE_SHIPPING when shipping is already free", () => {
    const priced = price({
      items: [item({ unitPriceCents: 6000 })],
      coupons: [coupon({ code: "FREESHIP", type: "FREE_SHIPPING", value: 0 })],
    });
    expect(reasonFor(priced, "FREESHIP")).toBe(REASONS.shippingAlreadyFree());
    expect(priced.discountLines).toHaveLength(0);
  });
});

// --- worked example B (§5.7B, defect #2) ------------------------------------

describe("worked example B — allocation and stacking", () => {
  const laptop = item({
    productId: "laptop",
    name: "Laptop",
    category: "Electronics",
    unitPriceCents: 100000,
  });
  const tshirt = item({
    productId: "tshirt",
    name: "T-shirt",
    category: "Apparel",
    unitPriceCents: 2000,
  });

  it("produces the exact per-line discounts from the spec", () => {
    const priced = price({
      items: [laptop, tshirt],
      coupons: [
        coupon({ code: "SAVE10", value: 1000 }),
        coupon({
          code: "ELECTRO20",
          value: 2000,
          targetType: "CATEGORY",
          targetValue: "Electronics",
        }),
      ],
    });

    expect(priced.subtotalCents).toBe(102000);
    expect(priced.items.map((i) => i.lineDiscountCents)).toEqual([28000, 200]);
    expect(priced.discountTotalCents).toBe(28200);
  });

  it("is unaffected by the order the coupons arrive in", () => {
    const forwards = price({
      items: [laptop, tshirt],
      coupons: [
        coupon({ code: "SAVE10", value: 1000 }),
        coupon({ code: "ELECTRO20", value: 2000, targetType: "CATEGORY", targetValue: "Electronics" }),
      ],
    });
    const backwards = price({
      items: [laptop, tshirt],
      coupons: [
        coupon({ code: "ELECTRO20", value: 2000, targetType: "CATEGORY", targetValue: "Electronics" }),
        coupon({ code: "SAVE10", value: 1000 }),
      ],
    });
    expect(backwards.discountTotalCents).toBe(forwards.discountTotalCents);
    expect(backwards.items.map((i) => i.lineDiscountCents)).toEqual([28000, 200]);
  });

  it("breaks priority ties on code, deterministically across 100 shuffles", () => {
    const coupons = [
      coupon({ code: "SAVE10", value: 1000 }),
      coupon({ code: "ELECTRO20", value: 2000, targetType: "CATEGORY", targetValue: "Electronics" }),
      coupon({ code: "ALPHA05", value: 500 }),
      coupon({ code: "ZULU05", value: 500 }),
    ];
    const expected = price({ items: [laptop, tshirt], coupons }).discountTotalCents;

    let seed = 42;
    for (let i = 0; i < 100; i++) {
      const shuffled = [...coupons];
      for (let j = shuffled.length - 1; j > 0; j--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const k = seed % (j + 1);
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      expect(price({ items: [laptop, tshirt], coupons: shuffled }).discountTotalCents).toBe(expected);
    }
  });
});

// --- worked example C (§5.7C, defect #3) ------------------------------------

describe("worked example C — the exclusive coupon loses when it is worse", () => {
  const coupons = [
    coupon({ code: "SAVE10", value: 1000 }),
    coupon({ code: "TAKE15", type: "FIXED", value: 1500, minSubtotalCents: 5000 }),
    coupon({ code: "FREESHIP", type: "FREE_SHIPPING", value: 0 }),
    coupon({ code: "VIP25", value: 2500, stackable: false, maxDiscountCents: 3000, priority: 50 }),
  ];

  it("lets the stackable pair win", () => {
    const priced = price({ items: [item({ unitPriceCents: 5000 })], coupons });

    expect(priced.totalCents).toBe(3240); // NOT 4050 — that would be defect #3
    expect(priced.discountTotalCents).toBe(2000);
    expect(appliedCodes(priced).sort()).toEqual(["SAVE10", "TAKE15"]);
  });

  it("rejects the exclusive coupon with the better-price reason", () => {
    const priced = price({ items: [item({ unitPriceCents: 5000 })], coupons });
    expect(reasonFor(priced, "VIP25")).toBe(REASONS.exclusiveLost("VIP25"));
  });

  it("rejects FREESHIP because shipping is already free at this subtotal", () => {
    const priced = price({ items: [item({ unitPriceCents: 5000 })], coupons });
    expect(reasonFor(priced, "FREESHIP")).toBe(REASONS.shippingAlreadyFree());
  });

  it("mirror case: an exclusive that beats the stackable set applies alone", () => {
    const priced = price({
      items: [item({ unitPriceCents: 5000 })],
      coupons: [
        coupon({ code: "SAVE10", value: 1000 }),
        coupon({ code: "VIP25", value: 2500, stackable: false, maxDiscountCents: 3000 }),
      ],
    });

    expect(appliedCodes(priced)).toEqual(["VIP25"]);
    expect(priced.discountTotalCents).toBe(1250);
    expect(priced.totalCents).toBe(4050);
    expect(reasonFor(priced, "SAVE10")).toBe(REASONS.supersededByExclusive("VIP25"));
  });

  it("picks the best of several exclusives", () => {
    const priced = price({
      items: [item({ unitPriceCents: 10000 })],
      coupons: [
        coupon({ code: "EXCL10", value: 1000, stackable: false }),
        coupon({ code: "EXCL30", value: 3000, stackable: false }),
        coupon({ code: "EXCL20", value: 2000, stackable: false }),
      ],
    });
    expect(appliedCodes(priced)).toEqual(["EXCL30"]);
    expect(priced.discountTotalCents).toBe(3000);
  });
});

// --- targeting --------------------------------------------------------------

describe("targeting", () => {
  it("applies a CATEGORY coupon only to matching lines", () => {
    const priced = price({
      items: [
        item({ productId: "a", category: "Electronics", unitPriceCents: 10000 }),
        item({ productId: "b", category: "Apparel", unitPriceCents: 10000 }),
      ],
      coupons: [
        coupon({ code: "ELEC", value: 2000, targetType: "CATEGORY", targetValue: "Electronics" }),
      ],
    });
    expect(priced.items.map((i) => i.lineDiscountCents)).toEqual([2000, 0]);
  });

  it("applies a PRODUCT coupon only to that product", () => {
    const priced = price({
      items: [
        item({ productId: "a", unitPriceCents: 10000 }),
        item({ productId: "b", unitPriceCents: 10000 }),
      ],
      coupons: [coupon({ code: "JUSTB", value: 5000, targetType: "PRODUCT", targetValue: "b" })],
    });
    expect(priced.items.map((i) => i.lineDiscountCents)).toEqual([0, 5000]);
  });

  it("rejects a targeted coupon that matches nothing in the cart", () => {
    const priced = price({
      items: [item({ category: "Apparel", unitPriceCents: 10000 })],
      coupons: [
        coupon({ code: "ELEC", value: 2000, targetType: "CATEGORY", targetValue: "Electronics" }),
      ],
    });
    expect(reasonFor(priced, "ELEC")).toBe(REASONS.noMatchingItems("ELEC"));
    expect(priced.discountLines).toHaveLength(0);
  });
});

// --- eligibility ------------------------------------------------------------

describe("eligibility", () => {
  const items = [item({ unitPriceCents: 4000 })];

  it("rejects an inactive coupon", () => {
    const priced = price({ items, coupons: [coupon({ code: "OFF", active: false })] });
    expect(reasonFor(priced, "OFF")).toBe(REASONS.notActive("OFF"));
  });

  it("rejects an expired coupon", () => {
    const priced = price({
      items,
      coupons: [coupon({ code: "OLD", endsAt: new Date("2020-01-01") })],
      now: new Date("2026-01-01"),
    });
    expect(reasonFor(priced, "OLD")).toBe(REASONS.expired("OLD"));
  });

  it("rejects a coupon that has not started", () => {
    const priced = price({
      items,
      coupons: [coupon({ code: "SOON", startsAt: new Date("2030-01-01") })],
      now: new Date("2026-01-01"),
    });
    expect(reasonFor(priced, "SOON")).toBe(REASONS.notYetAvailable("SOON"));
  });

  it("gates on minSubtotalCents — not met", () => {
    const priced = price({
      items,
      coupons: [coupon({ code: "TAKE15", type: "FIXED", value: 1500, minSubtotalCents: 5000 })],
    });
    expect(reasonFor(priced, "TAKE15")).toBe(REASONS.minSpendNotMet(5000, "USD"));
    expect(reasonFor(priced, "TAKE15")).toContain("$50.00");
  });

  it("gates on minSubtotalCents — met", () => {
    const priced = price({
      items: [item({ unitPriceCents: 5000 })],
      coupons: [coupon({ code: "TAKE15", type: "FIXED", value: 1500, minSubtotalCents: 5000 })],
    });
    expect(priced.discountTotalCents).toBe(1500);
    expect(priced.rejectedCoupons).toHaveLength(0);
  });
});

// --- clamping and caps ------------------------------------------------------

describe("clamping", () => {
  it("clamps a FIXED discount larger than the subtotal and never goes negative", () => {
    const priced = price({
      items: [item({ unitPriceCents: 1000 })],
      coupons: [coupon({ code: "HUGE", type: "FIXED", value: 999999 })],
    });
    expect(priced.discountTotalCents).toBe(1000);
    expect(priced.items[0].lineTotalCents).toBe(0);
    expect(priced.taxCents).toBe(0);
    expect(priced.totalCents).toBe(599); // shipping only
  });

  it("applies maxDiscountCents", () => {
    const priced = price({
      items: [item({ unitPriceCents: 100000 })],
      coupons: [coupon({ code: "CAPPED", value: 5000, maxDiscountCents: 3000 })],
    });
    expect(priced.discountTotalCents).toBe(3000);
  });

  it("rejects a second coupon with nothing left to discount", () => {
    const priced = price({
      items: [item({ unitPriceCents: 1000 })],
      coupons: [
        coupon({ code: "AAA", type: "FIXED", value: 999999, priority: 1 }),
        coupon({ code: "BBB", type: "FIXED", value: 500, priority: 2 }),
      ],
    });
    expect(priced.discountTotalCents).toBe(1000);
    expect(reasonFor(priced, "BBB")).toBe(REASONS.noDiscountableAmount("BBB"));
  });

  it("keeps every line at or above zero when coupons overlap", () => {
    const priced = price({
      items: [
        item({ productId: "a", category: "X", unitPriceCents: 1000 }),
        item({ productId: "b", category: "Y", unitPriceCents: 9000 }),
      ],
      coupons: [
        coupon({ code: "AONLY", type: "FIXED", value: 900, targetType: "PRODUCT", targetValue: "a", priority: 1 }),
        coupon({ code: "WHOLE", value: 9000, priority: 2 }),
      ],
    });
    priced.items.forEach((i) => expect(i.lineTotalCents).toBeGreaterThanOrEqual(0));
  });
});

// --- tax --------------------------------------------------------------------

describe("tax", () => {
  it("is computed on the discounted subtotal, pre-shipping by default", () => {
    const priced = price({
      items: [item({ unitPriceCents: 4000 })],
      coupons: [coupon({ code: "SAVE10", value: 1000 })],
    });
    expect(priced.discountTotalCents).toBe(400);
    expect(priced.taxCents).toBe(288); // 8% of 3600, not of 4000 and not including shipping
  });

  it("includes shipping when TAX_ON_SHIPPING is true", () => {
    const config: StoreConfig = { ...CONFIG_DEFAULTS, taxOnShipping: true };
    const priced = price({
      items: [item({ unitPriceCents: 4000 })],
      coupons: [],
      config,
    });
    expect(priced.shippingCents).toBe(599);
    expect(priced.taxCents).toBe(368); // 8% of 4599
  });
});

// --- §5.6 applied-coupon lifecycle -----------------------------------------

describe("appliedCodes", () => {
  it("returns exactly the codes that produced a discount line", () => {
    const priced = price({
      items: [item({ unitPriceCents: 4000 })],
      coupons: [
        coupon({ code: "SAVE10", value: 1000 }),
        coupon({ code: "TAKE15", type: "FIXED", value: 1500, minSubtotalCents: 999999 }),
      ],
    });
    expect(appliedCodes(priced)).toEqual(["SAVE10"]);
  });
});
