import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { apiError, readJson } from "@/lib/api/errors";
import { uniqueSlug } from "@/lib/api/product-payload";
import { bulkProductsSchema, newProductSchema, validateRows } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";

/**
 * POST /api/products/bulk (admin) — specs/02 §4.
 *
 * JSON only; image uploads go through POST /api/uploads first (§8.3).
 * All-or-nothing: every row is validated up front and the writes go in one
 * transaction, so an invalid row leaves ZERO rows created.
 */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await readJson(request);
  const envelope = bulkProductsSchema.safeParse(body);
  if (!envelope.success) {
    // Re-validate row by row so the caller gets per-index errors.
    const rows = (body as { products?: unknown[] })?.products;
    if (Array.isArray(rows)) {
      const result = validateRows(rows, newProductSchema);
      if (!result.ok) {
        return apiError("VALIDATION", "One or more products are invalid", result.errors);
      }
    }
    return apiError("VALIDATION", "Expected { products: NewProduct[] }");
  }

  const prepared = [];
  for (const row of envelope.data.products) {
    const { relatedIds, slug, ...rest } = row;
    prepared.push({
      ...rest,
      slug: await uniqueSlug(rest.name, slug),
      relatedIds: JSON.stringify(relatedIds ?? []),
    });
  }

  const products = await prisma.$transaction(
    prepared.map((data) => prisma.product.create({ data })),
  );

  return NextResponse.json({ created: products.length, products }, { status: 201 });
}
