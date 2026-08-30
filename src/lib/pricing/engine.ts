/**
 * The pricing engine. specs/01 §5.
 *
 * Pure: no I/O, no Prisma, no clock except the one injected. The API layer
 * loads data and passes it in.
 */
import { percentOfBps } from "../money";
import { allocate } from "./allocate";
import { REASONS } from "./reasons";
import type {
  DiscountLine,
  EngineCoupon,
  PriceCartInput,
  PricedCart,
  PricingLineInput,
  PricingLineItem,
  RejectedCoupon,
  StoreConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineSubtotal(item: PricingLineInput): number {
  return item.unitPriceCents * item.quantity;
}

/** Shipping before any discount. Tests the PRE-discount subtotal (§5.3 step 1). */
function shippingBaseFor(subtotalCents: number, config: StoreConfig): number {
  return subtotalCents >= config.freeShippingThresholdCents ? 0 : config.shippingFlatCents;
}

/** Indices of the lines a coupon targets. */
function matchedIndices(coupon: EngineCoupon, items: PricingLineInput[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const matches =
      coupon.targetType === "CART" ||
      (coupon.targetType === "CATEGORY" && item.category === coupon.targetValue) ||
      (coupon.targetType === "PRODUCT" && item.productId === coupon.targetValue);
    if (matches) indices.push(i);
  }
  return indices;
}

/** Deterministic order: priority ascending, then code ascending to break ties. */
function inApplyOrder(coupons: EngineCoupon[]): EngineCoupon[] {
  return [...coupons].sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Eligibility (§5.3 step 2)
// ---------------------------------------------------------------------------

interface EligibilityResult {
  eligible: EngineCoupon[];
  rejected: RejectedCoupon[];
}

function filterEligible(
  coupons: EngineCoupon[],
  items: PricingLineInput[],
  subtotalCents: number,
  shippingBaseCents: number,
  config: StoreConfig,
  now: Date,
): EligibilityResult {
  const eligible: EngineCoupon[] = [];
  const rejected: RejectedCoupon[] = [];
  const reject = (couponCode: string, reason: string) => rejected.push({ couponCode, reason });

  for (const coupon of coupons) {
    if (!coupon.active) {
      reject(coupon.code, REASONS.notActive(coupon.code));
      continue;
    }
    if (coupon.startsAt && now < coupon.startsAt) {
      reject(coupon.code, REASONS.notYetAvailable(coupon.code));
      continue;
    }
    if (coupon.endsAt && now > coupon.endsAt) {
      reject(coupon.code, REASONS.expired(coupon.code));
      continue;
    }
    if (coupon.minSubtotalCents !== null && subtotalCents < coupon.minSubtotalCents) {
      reject(coupon.code, REASONS.minSpendNotMet(coupon.minSubtotalCents, config.currency));
      continue;
    }
    if (coupon.type === "FREE_SHIPPING") {
      // Evaluated here rather than at shipping time: shippingBase depends only
      // on the subtotal, which is known in step 1. A shipping discount of zero
      // has no coherent meaning once shipping discounts are their own field.
      if (shippingBaseCents === 0) {
        reject(coupon.code, REASONS.shippingAlreadyFree());
        continue;
      }
    } else if (matchedIndices(coupon, items).length === 0) {
      reject(coupon.code, REASONS.noMatchingItems(coupon.code));
      continue;
    }
    eligible.push(coupon);
  }

  return { eligible, rejected };
}

// ---------------------------------------------------------------------------
// The inner pass (§5.4)
// ---------------------------------------------------------------------------

interface PassResult extends PricedCart {
  /** Codes that were handed to this pass, whether or not they produced a line. */
  candidateCodes: string[];
}

export function priceWithCouponSet(
  items: PricingLineInput[],
  coupons: EngineCoupon[],
  config: StoreConfig,
): PassResult {
  const subtotals = items.map(lineSubtotal);
  const subtotalCents = subtotals.reduce((sum, n) => sum + n, 0);
  const shippingBaseCents = shippingBaseFor(subtotalCents, config);

  const lineDiscounts = new Array<number>(items.length).fill(0);
  const discountLines: DiscountLine[] = [];
  const rejectedCoupons: RejectedCoupon[] = [];
  let shippingDiscountCents = 0;

  for (const coupon of inApplyOrder(coupons)) {
    if (coupon.type === "FREE_SHIPPING") {
      if (shippingDiscountCents > 0 || shippingBaseCents === 0) {
        rejectedCoupons.push({
          couponCode: coupon.code,
          reason: REASONS.shippingAlreadyFree(),
        });
        continue;
      }
      shippingDiscountCents = shippingBaseCents;
      discountLines.push({
        couponCode: coupon.code,
        description: coupon.description ?? coupon.code,
        type: coupon.type,
        amountCents: shippingBaseCents,
        appliedTo: "SHIPPING",
      });
      continue;
    }

    // PERCENT | FIXED — both reduce specific lines. There is no unallocated
    // cart-level discount, so "the running discountable base" has exactly one
    // meaning and the per-line zero floor is enforceable.
    const matched = matchedIndices(coupon, items);
    const weights = matched.map((i) => subtotals[i] - lineDiscounts[i]);
    const base = weights.reduce((sum, n) => sum + n, 0);

    if (base <= 0) {
      rejectedCoupons.push({
        couponCode: coupon.code,
        reason: REASONS.noDiscountableAmount(coupon.code),
      });
      continue;
    }

    const raw =
      coupon.type === "PERCENT" ? percentOfBps(base, coupon.value) : Math.min(coupon.value, base);
    const capped = coupon.maxDiscountCents !== null ? Math.min(raw, coupon.maxDiscountCents) : raw;
    const amountCents = Math.min(capped, base);

    if (amountCents <= 0) {
      rejectedCoupons.push({
        couponCode: coupon.code,
        reason: REASONS.noDiscountableAmount(coupon.code),
      });
      continue;
    }

    const parts = allocate(amountCents, weights);
    matched.forEach((lineIndex, k) => {
      lineDiscounts[lineIndex] += parts[k];
    });

    discountLines.push({
      couponCode: coupon.code,
      description: coupon.description ?? coupon.code,
      type: coupon.type,
      amountCents,
      appliedTo: coupon.targetType,
    });
  }

  const discountTotalCents = lineDiscounts.reduce((sum, n) => sum + n, 0);
  const shippingCents = Math.max(0, shippingBaseCents - shippingDiscountCents);
  const taxableBase =
    subtotalCents - discountTotalCents + (config.taxOnShipping ? shippingCents : 0);
  const taxCents = percentOfBps(Math.max(0, taxableBase), config.taxRateBps);
  const totalCents = Math.max(0, subtotalCents - discountTotalCents + shippingCents + taxCents);

  const pricedItems: PricingLineItem[] = items.map((item, i) => ({
    ...item,
    lineSubtotalCents: subtotals[i],
    lineDiscountCents: lineDiscounts[i],
    lineTotalCents: subtotals[i] - lineDiscounts[i],
  }));

  return {
    items: pricedItems,
    subtotalCents,
    discountLines,
    discountTotalCents,
    shippingDiscountCents,
    shippingCents,
    taxCents,
    totalCents,
    rejectedCoupons,
    currency: config.currency,
    candidateCodes: coupons.map((c) => c.code),
  };
}

// ---------------------------------------------------------------------------
// Top level: best outcome wins (§5.3)
// ---------------------------------------------------------------------------

/** Fewest coupons, then the lexicographically smallest sorted code list. */
function isBetter(candidate: PassResult, incumbent: PassResult): boolean {
  if (candidate.totalCents !== incumbent.totalCents) {
    return candidate.totalCents < incumbent.totalCents;
  }
  if (candidate.candidateCodes.length !== incumbent.candidateCodes.length) {
    return candidate.candidateCodes.length < incumbent.candidateCodes.length;
  }
  const a = [...candidate.candidateCodes].sort().join(",");
  const b = [...incumbent.candidateCodes].sort().join(",");
  return a < b;
}

export function priceCart(input: PriceCartInput): PricedCart {
  const { items, coupons, config } = input;
  const now = input.now ?? new Date();

  const subtotalCents = items.reduce((sum, item) => sum + lineSubtotal(item), 0);
  const shippingBaseCents = shippingBaseFor(subtotalCents, config);

  const { eligible, rejected } = filterEligible(
    coupons,
    items,
    subtotalCents,
    shippingBaseCents,
    config,
    now,
  );

  // Candidate sets: all stackables together, plus each non-stackable alone.
  // An empty stackable set doubles as the "no coupons" baseline.
  const stackables = eligible.filter((c) => c.stackable);
  const exclusives = eligible.filter((c) => !c.stackable);
  const candidateSets: EngineCoupon[][] = [stackables, ...exclusives.map((c) => [c])];

  let winner = priceWithCouponSet(items, candidateSets[0], config);
  for (const set of candidateSets.slice(1)) {
    const candidate = priceWithCouponSet(items, set, config);
    if (isBetter(candidate, winner)) winner = candidate;
  }

  // Anything eligible but absent from the winning set was superseded.
  const winningCodes = new Set(winner.candidateCodes);
  const winnerIsExclusive = winner.candidateCodes.length === 1 && exclusives.some(
    (c) => c.code === winner.candidateCodes[0],
  );

  const superseded: RejectedCoupon[] = eligible
    .filter((c) => !winningCodes.has(c.code))
    .map((c) => ({
      couponCode: c.code,
      reason: winnerIsExclusive
        ? REASONS.supersededByExclusive(winner.candidateCodes[0])
        : REASONS.exclusiveLost(c.code),
    }));

  return {
    items: winner.items,
    subtotalCents: winner.subtotalCents,
    discountLines: winner.discountLines,
    discountTotalCents: winner.discountTotalCents,
    shippingDiscountCents: winner.shippingDiscountCents,
    shippingCents: winner.shippingCents,
    taxCents: winner.taxCents,
    totalCents: winner.totalCents,
    rejectedCoupons: [...rejected, ...winner.rejectedCoupons, ...superseded],
    currency: winner.currency,
  };
}

/** Codes that actually applied — what Cart.coupons is pruned to (§5.6). */
export function appliedCodes(priced: PricedCart): string[] {
  return priced.discountLines.map((line) => line.couponCode);
}
