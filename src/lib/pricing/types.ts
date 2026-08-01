/**
 * The shared contract. specs/01 §4.3, §5.1.
 *
 * Everything in this file is the interface boundary between the engine, the API
 * layer and the UI. Changing it is a spec edit, not a refactor.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// String-backed enums (§4.3)
//
// Prisma's SQLite connector does not support `enum`, so `Coupon.type` and
// `Coupon.targetType` are String columns. These constants are the single source
// of truth: the TS unions and the Zod schemas both derive from them.
// ---------------------------------------------------------------------------

export const COUPON_TYPES = ["PERCENT", "FIXED", "FREE_SHIPPING"] as const;
export const TARGET_TYPES = ["CART", "CATEGORY", "PRODUCT"] as const;

export type CouponType = (typeof COUPON_TYPES)[number];
export type TargetType = (typeof TARGET_TYPES)[number];

export const couponTypeSchema = z.enum(COUPON_TYPES);
export const targetTypeSchema = z.enum(TARGET_TYPES);

// ---------------------------------------------------------------------------
// Store configuration (§6)
// ---------------------------------------------------------------------------

export interface StoreConfig {
  currency: string;
  taxRateBps: number;
  taxOnShipping: boolean;
  shippingFlatCents: number;
  freeShippingThresholdCents: number;
}

// ---------------------------------------------------------------------------
// Engine input
//
// The engine is pure and must not depend on Prisma. This is the coupon shape it
// consumes; the API layer maps Prisma rows onto it.
// ---------------------------------------------------------------------------

export interface EngineCoupon {
  code: string;
  description: string | null;
  type: CouponType;
  value: number;
  targetType: TargetType;
  targetValue: string | null;
  minSubtotalCents: number | null;
  maxDiscountCents: number | null;
  stackable: boolean;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Engine output (§5.1)
// ---------------------------------------------------------------------------

export interface PricingLineItem {
  productId: string;
  name: string;
  category?: string;
  /** From CartItem.unitPriceCentsSnapshot — never Product.priceCents (§4.1). */
  unitPriceCents: number;
  quantity: number;
  /** unitPriceCents * quantity, pre-discount. */
  lineSubtotalCents: number;
  /** This line's allocated share of all item discounts. */
  lineDiscountCents: number;
  /** lineSubtotalCents - lineDiscountCents, never < 0. */
  lineTotalCents: number;
}

/** What the engine is handed: a line without its computed discount fields. */
export type PricingLineInput = Omit<
  PricingLineItem,
  "lineSubtotalCents" | "lineDiscountCents" | "lineTotalCents"
>;

export interface DiscountLine {
  couponCode: string;
  description: string;
  type: CouponType;
  /** Positive number representing the amount removed. */
  amountCents: number;
  appliedTo: TargetType | "SHIPPING";
}

export interface RejectedCoupon {
  couponCode: string;
  /** Human-readable, rendered to the shopper verbatim. */
  reason: string;
}

export interface PricedCart {
  items: PricingLineItem[];
  subtotalCents: number;
  /** Every applied coupon, item and shipping alike. */
  discountLines: DiscountLine[];
  /** ITEM discounts only — excludes appliedTo: 'SHIPPING' (§5.2). */
  discountTotalCents: number;
  /** Shipping discounts only. */
  shippingDiscountCents: number;
  /** shippingBase - shippingDiscountCents, never < 0. */
  shippingCents: number;
  taxCents: number;
  /** Final amount, never below 0. */
  totalCents: number;
  /**
   * Transient, per-response: THIS apply attempt failed and was not persisted.
   * Coupons that stop qualifying later are pruned from Cart.coupons (§5.6),
   * so they never appear here.
   */
  rejectedCoupons: RejectedCoupon[];
  currency: string;
}

export interface PriceCartInput {
  items: PricingLineInput[];
  coupons: EngineCoupon[];
  config: StoreConfig;
  /** Injected so pricing is deterministic under test. Defaults to now. */
  now?: Date;
}
