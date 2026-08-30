import { NextResponse } from "next/server";
import { parseLimit, recommendationsFor } from "@/lib/recommend-service";

/**
 * GET /api/recommendations?productIds=a,b,c — specs/03 §2.3. Public.
 * Unknown ids are ignored rather than an error.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  const sourceProductIds = (url.searchParams.get("productIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const limit = parseLimit(url.searchParams.get("limit"));
  return NextResponse.json({ products: await recommendationsFor(sourceProductIds, limit) });
}
