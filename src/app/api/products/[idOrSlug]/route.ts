import { unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { apiError, validationError } from "@/lib/api/errors";
import { readProductPayload } from "@/lib/api/product-payload";
import { patchProductSchema } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";
import { STORED_NAME, uploadDir } from "@/lib/uploads";

/**
 * specs/01 §7.1 names this route `[slug]` for GET; specs/02 §4 names it `[id]`
 * for PATCH/DELETE. The App Router allows only ONE dynamic segment name per
 * path level, so the segment is `[idOrSlug]` and each method resolves the way
 * its spec describes, falling back to the other.
 *
 * Next 15: params is a Promise (specs/01 §7.5).
 */
type Params = { params: Promise<{ idOrSlug: string }> };

async function findProduct(idOrSlug: string) {
  return (
    (await prisma.product.findUnique({ where: { slug: idOrSlug } })) ??
    (await prisma.product.findUnique({ where: { id: idOrSlug } }))
  );
}

/** GET — public, by slug. */
export async function GET(_request: Request, { params }: Params) {
  const { idOrSlug } = await params;

  const product = await findProduct(idOrSlug);
  if (!product || !product.active) {
    return apiError("NOT_FOUND", `No product "${idOrSlug}"`);
  }

  return NextResponse.json({ product });
}

/** PATCH (admin) — partial update. Changing priceCents does NOT reprice carts (§4.1). */
export async function PATCH(request: Request, { params }: Params) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { idOrSlug } = await params;
  const existing = await findProduct(idOrSlug);
  if (!existing) return apiError("NOT_FOUND", `No product "${idOrSlug}"`);

  const read = await readProductPayload(request);
  if (!read.ok) return apiError(read.code, read.message);

  const parsed = patchProductSchema.safeParse(read.payload);
  if (!parsed.success) return validationError(parsed.error);
  const { relatedIds, ...rest } = parsed.data;

  const product = await prisma.product.update({
    where: { id: existing.id },
    data: {
      ...rest,
      ...(relatedIds ? { relatedIds: JSON.stringify(relatedIds) } : {}),
    },
  });

  return NextResponse.json({ product });
}

/** DELETE (admin) — cascades out of carts, and removes an owned upload. */
export async function DELETE(request: Request, { params }: Params) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { idOrSlug } = await params;
  const existing = await findProduct(idOrSlug);
  if (!existing) return apiError("NOT_FOUND", `No product "${idOrSlug}"`);

  await prisma.product.delete({ where: { id: existing.id } });

  const filename = existing.imageUrl?.startsWith("/uploads/")
    ? existing.imageUrl.slice("/uploads/".length)
    : null;
  if (filename && STORED_NAME.test(filename)) {
    await unlink(path.join(uploadDir(), filename)).catch(() => undefined);
  }

  return NextResponse.json({ deleted: true });
}
