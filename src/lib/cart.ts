/**
 * Cart persistence and cookie handling. specs/01 §5.6, §7.2, §7.4, §7.5.
 */
import { cookies } from "next/headers";
import { prisma } from "./db";
import { loadConfig } from "./pricing/config";
import { appliedCodes, priceCart } from "./pricing/engine";
import { REASONS } from "./pricing/reasons";
import {
  couponTypeSchema,
  targetTypeSchema,
  type EngineCoupon,
  type PricedCart,
  type PricingLineInput,
} from "./pricing/types";

export const CART_COOKIE = "cartId";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

/**
 * The cookie is deliberately UNSIGNED. Next's App Router provides no signing
 * primitive, the cartId is an unguessable cuid, and specs/01 §1 rules out
 * accounts, PII and payments — so signing would defend nothing while adding a
 * dependency and a secret to configure. Documented in the README.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: THIRTY_DAYS_SECONDS,
    secure: process.env.NODE_ENV === "production",
  };
}

/** Reads the cart from the cookie, creating one (and setting the cookie) if absent. */
export async function resolveCartId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(CART_COOKIE)?.value;

  if (existing) {
    const found = await prisma.cart.findUnique({ where: { id: existing }, select: { id: true } });
    if (found) return found.id;
  }

  const cart = await prisma.cart.create({ data: {} });
  jar.set(CART_COOKIE, cart.id, cookieOptions());
  return cart.id;
}

function toEngineCoupon(row: {
  code: string;
  description: string | null;
  type: string;
  value: number;
  targetType: string;
  targetValue: string | null;
  minSubtotalCents: number | null;
  maxDiscountCents: number | null;
  stackable: boolean;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}): EngineCoupon {
  return {
    ...row,
    // String columns narrowed at the boundary (§4.3) — an invalid value can
    // never reach the engine.
    type: couponTypeSchema.parse(row.type),
    targetType: targetTypeSchema.parse(row.targetType),
  };
}

/**
 * The one load -> price -> prune -> persist sequence. Every cart route goes
 * through here; a route that skipped the prune would be a silent bug with no
 * failing test anywhere else (§5.6).
 *
 * `applyingCode` is set only by POST /api/cart/coupons. rejectedCoupons in the
 * response is scoped to that code, so the field means exactly one thing:
 * *this* apply attempt failed and was not persisted. Coupons that merely stop
 * qualifying are pruned silently — nothing to toast about (slice 3 §4.1).
 */
export async function priceAndPrune(
  cartId: string,
  applyingCode?: string,
): Promise<PricedCart> {
  const cart = await prisma.cart.findUnique({
    where: { id: cartId },
    include: { items: { include: { product: true }, orderBy: { id: "asc" } } },
  });
  if (!cart) throw new Error(`Cart ${cartId} not found`);

  const held: string[] = JSON.parse(cart.coupons);
  const candidateCodes = Array.from(new Set([...held, ...(applyingCode ? [applyingCode] : [])]));

  const couponRows = candidateCodes.length
    ? await prisma.coupon.findMany({ where: { code: { in: candidateCodes } } })
    : [];

  const items: PricingLineInput[] = cart.items.map((line) => ({
    productId: line.productId,
    name: line.product.name,
    category: line.product.category ?? undefined,
    // The snapshot, never Product.priceCents (§4.1).
    unitPriceCents: line.unitPriceCentsSnapshot,
    quantity: line.quantity,
  }));

  const priced = priceCart({
    items,
    coupons: couponRows.map(toEngineCoupon),
    config: loadConfig(),
  });

  // Prune: Cart.coupons holds exactly what applied on this pass, nothing else.
  const applied = appliedCodes(priced);
  if (JSON.stringify(applied) !== cart.coupons) {
    await prisma.cart.update({
      where: { id: cartId },
      data: { coupons: JSON.stringify(applied) },
    });
  }

  let rejectedCoupons = priced.rejectedCoupons.filter((r) => r.couponCode === applyingCode);
  if (applyingCode && !couponRows.some((c) => c.code === applyingCode)) {
    rejectedCoupons = [{ couponCode: applyingCode, reason: REASONS.unknownCode(applyingCode) }];
  }

  return { ...priced, rejectedCoupons };
}
