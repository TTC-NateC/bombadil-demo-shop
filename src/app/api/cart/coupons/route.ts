import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, readJson, validationError } from "@/lib/api/errors";
import { priceAndPrune, resolveCartId } from "@/lib/cart";
import { prisma } from "@/lib/db";

const applySchema = z.object({ code: z.string().min(1) });

/**
 * POST /api/cart/coupons — apply. specs/01 §7.2.
 *
 * The code joins the candidate set. If it lands in the winning set the prune
 * persists it; otherwise it comes back under rejectedCoupons and is not stored.
 */
export async function POST(request: Request) {
  const parsed = applySchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);

  const code = parsed.data.code.trim().toUpperCase();
  const cartId = await resolveCartId();

  return NextResponse.json(await priceAndPrune(cartId, code));
}

/** DELETE /api/cart/coupons?code=... */
export async function DELETE(request: Request) {
  const raw = new URL(request.url).searchParams.get("code");
  if (!raw) return apiError("VALIDATION", "code query parameter is required");
  const code = raw.trim().toUpperCase();

  const cartId = await resolveCartId();
  const cart = await prisma.cart.findUniqueOrThrow({ where: { id: cartId } });

  const held: string[] = JSON.parse(cart.coupons);
  await prisma.cart.update({
    where: { id: cartId },
    data: { coupons: JSON.stringify(held.filter((c) => c !== code)) },
  });

  return NextResponse.json(await priceAndPrune(cartId));
}
