/**
 * Rejection reasons. specs/01 §5.3.
 *
 * One table, so the engine, the API and the UI can never render text that has
 * drifted from each other. These strings are shown to the shopper verbatim —
 * no client-side prettifying.
 */
import { formatCents } from "../money";

export const REASONS = {
  notActive: (code: string) => `Coupon ${code} is not active`,
  expired: (code: string) => `Coupon ${code} has expired`,
  notYetAvailable: (code: string) => `Coupon ${code} is not yet available`,
  minSpendNotMet: (minCents: number, currency: string) =>
    `Minimum spend of ${formatCents(minCents, currency)} not met`,
  noMatchingItems: (code: string) => `Coupon ${code} doesn't apply to anything in your cart`,
  shippingAlreadyFree: () => `Shipping is already free on this order`,
  noDiscountableAmount: (code: string) => `No discountable amount remaining for coupon ${code}`,
  unknownCode: (code: string) => `Coupon ${code} is not a valid code`,

  /** The winner is a single exclusive coupon; everything else was dropped. */
  supersededByExclusive: (winnerCode: string) =>
    `Coupon ${winnerCode} can't be combined with other coupons`,

  /** The stackable set won; this exclusive coupon would have cost the shopper more. */
  exclusiveLost: (code: string) =>
    `Coupon ${code} can't be combined with your other coupons, which give a better price`,
} as const;
