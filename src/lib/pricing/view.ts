/**
 * View-layer helpers over PricedCart. specs/01 §8.3, §8.4.
 *
 * The client never computes money — these only *select* and *format* fields
 * that the engine already produced.
 */
import { formatCents } from "../money";
import type { DiscountLine, PricedCart } from "./types";

/** Discount rows the breakdown renders. Shipping is NOT one of them (§8.3). */
export function itemDiscountLines(priced: PricedCart): DiscountLine[] {
  return priced.discountLines.filter((line) => line.appliedTo !== "SHIPPING");
}

/** The coupon that made shipping free, if a coupon did it (rather than the threshold). */
export function shippingDiscountCode(priced: PricedCart): string | null {
  return priced.discountLines.find((line) => line.appliedTo === "SHIPPING")?.couponCode ?? null;
}

/**
 * The shipping row. Renders "FREE" for both the coupon and the threshold path,
 * attributing the coupon when there is one — the two paths must not look
 * different (§8.3).
 */
export function shippingLabel(priced: PricedCart): string {
  if (priced.shippingCents > 0) return formatCents(priced.shippingCents, priced.currency);
  const code = shippingDiscountCode(priced);
  return code ? `FREE (${code})` : "FREE";
}

/** Applied-coupon chips come straight from discountLines — there is no separate field (§5.6). */
export function appliedChips(priced: PricedCart): DiscountLine[] {
  return priced.discountLines;
}

export function itemCount(priced: PricedCart): number {
  return priced.items.reduce((sum, item) => sum + item.quantity, 0);
}
