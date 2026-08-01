import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, readJson, validationError } from "@/lib/api/errors";
import { priceAndPrune, resolveCartId } from "@/lib/cart";
import { prisma } from "@/lib/db";

const addSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive().default(1),
});

const setSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(0),
});

/** POST /api/cart/items — add. Captures the price snapshot on create (§4.1). */
export async function POST(request: Request) {
  const parsed = addSchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { productId, quantity } = parsed.data;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.active) return apiError("NOT_FOUND", "Unknown product");

  const cartId = await resolveCartId();
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
  });

  if (existing) {
    // Quantity change only — the snapshot is NOT refreshed (§4.1).
    await prisma.cartItem.update({
      where: { id: existing.id },
      data: { quantity: existing.quantity + quantity },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId,
        productId,
        quantity,
        unitPriceCentsSnapshot: product.priceCents,
      },
    });
  }

  return NextResponse.json(await priceAndPrune(cartId));
}

/** PATCH /api/cart/items — set quantity. 0 removes. Never refreshes the snapshot. */
export async function PATCH(request: Request) {
  const parsed = setSchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { productId, quantity } = parsed.data;

  const cartId = await resolveCartId();
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
  });
  if (!existing) return apiError("NOT_FOUND", "That product is not in your cart");

  if (quantity === 0) {
    await prisma.cartItem.delete({ where: { id: existing.id } });
  } else {
    await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } });
  }

  return NextResponse.json(await priceAndPrune(cartId));
}

/** DELETE /api/cart/items?productId=... */
export async function DELETE(request: Request) {
  const productId = new URL(request.url).searchParams.get("productId");
  if (!productId) return apiError("VALIDATION", "productId query parameter is required");

  const cartId = await resolveCartId();
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
  });
  if (!existing) return apiError("NOT_FOUND", "That product is not in your cart");

  await prisma.cartItem.delete({ where: { id: existing.id } });
  return NextResponse.json(await priceAndPrune(cartId));
}
