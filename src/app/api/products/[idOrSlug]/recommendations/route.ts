import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db";
import { parseLimit, recommendationsFor } from "@/lib/recommend-service";

/**
 * GET /api/products/[idOrSlug]/recommendations — specs/03 §2.3. Public.
 * Next 15: params is a Promise (specs/01 §7.5).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ idOrSlug: string }> },
) {
  const { idOrSlug } = await params;

  const source =
    (await prisma.product.findUnique({ where: { slug: idOrSlug } })) ??
    (await prisma.product.findUnique({ where: { id: idOrSlug } }));

  if (!source) return apiError("NOT_FOUND", `No product "${idOrSlug}"`);

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  return NextResponse.json({ products: await recommendationsFor([source.id], limit) });
}
