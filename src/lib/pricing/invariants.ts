/**
 * The seven invariants from specs/01 §5.2.
 *
 * Called at the end of EVERY engine test and on every API response in the
 * cart-route tests. This helper is what stops defects #1 and #2 creeping back:
 * shipping leaking into discountTotalCents, or per-line allocation drifting
 * away from the total.
 */
import type { PricedCart } from "./types";

export function assertInvariants(priced: PricedCart, label = "PricedCart"): void {
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };

  const itemDiscountLines = priced.discountLines
    .filter((l) => l.appliedTo !== "SHIPPING")
    .reduce((sum, l) => sum + l.amountCents, 0);
  const shippingDiscountLines = priced.discountLines
    .filter((l) => l.appliedTo === "SHIPPING")
    .reduce((sum, l) => sum + l.amountCents, 0);
  const sumLineDiscounts = priced.items.reduce((sum, i) => sum + i.lineDiscountCents, 0);
  const sumLineSubtotals = priced.items.reduce((sum, i) => sum + i.lineSubtotalCents, 0);

  // 1. discountTotalCents counts item discount lines only — never shipping.
  if (priced.discountTotalCents !== itemDiscountLines) {
    fail(
      `discountTotalCents (${priced.discountTotalCents}) !== sum of non-SHIPPING discount lines (${itemDiscountLines})`,
    );
  }

  // 2. Allocation is exact — the parts sum to the whole.
  if (priced.discountTotalCents !== sumLineDiscounts) {
    fail(
      `discountTotalCents (${priced.discountTotalCents}) !== Σ lineDiscountCents (${sumLineDiscounts})`,
    );
  }

  // 3. Shipping discounts are tracked separately.
  if (priced.shippingDiscountCents !== shippingDiscountLines) {
    fail(
      `shippingDiscountCents (${priced.shippingDiscountCents}) !== sum of SHIPPING discount lines (${shippingDiscountLines})`,
    );
  }

  // 4. Shipping never goes negative.
  if (priced.shippingCents < 0) fail(`shippingCents is negative (${priced.shippingCents})`);

  // 5. Per-line arithmetic and the zero floor.
  for (const item of priced.items) {
    if (item.lineSubtotalCents !== item.unitPriceCents * item.quantity) {
      fail(`${item.productId}: lineSubtotalCents !== unitPriceCents * quantity`);
    }
    if (item.lineTotalCents !== item.lineSubtotalCents - item.lineDiscountCents) {
      fail(`${item.productId}: lineTotalCents !== lineSubtotalCents - lineDiscountCents`);
    }
    if (item.lineTotalCents < 0) fail(`${item.productId}: lineTotalCents is negative`);
    if (item.lineDiscountCents < 0) fail(`${item.productId}: lineDiscountCents is negative`);
  }

  // 6. Subtotal is the sum of the lines.
  if (priced.subtotalCents !== sumLineSubtotals) {
    fail(`subtotalCents (${priced.subtotalCents}) !== Σ lineSubtotalCents (${sumLineSubtotals})`);
  }

  // 7. The total, and it never goes negative.
  const expectedTotal = Math.max(
    0,
    priced.subtotalCents - priced.discountTotalCents + priced.shippingCents + priced.taxCents,
  );
  if (priced.totalCents !== expectedTotal) {
    fail(`totalCents (${priced.totalCents}) !== max(0, subtotal - discount + shipping + tax) (${expectedTotal})`);
  }
  if (priced.totalCents < 0) fail(`totalCents is negative (${priced.totalCents})`);
}
