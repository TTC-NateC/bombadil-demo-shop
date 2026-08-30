import { NextResponse } from "next/server";
import { priceAndPrune, resolveCartId } from "@/lib/cart";

/** GET /api/cart — specs/01 §7.2. Prunes on every pass (§5.6). */
export async function GET() {
  const cartId = await resolveCartId();
  return NextResponse.json(await priceAndPrune(cartId));
}
