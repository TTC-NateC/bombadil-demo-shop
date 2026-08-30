import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { apiError, readJson, validationError } from "@/lib/api/errors";
import { readProductPayload, uniqueSlug } from "@/lib/api/product-payload";
import { bulkDeleteSchema, newProductSchema } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";

/** GET /api/products — public. specs/01 §7.1. Active only unless ?all=true. */
export async function GET(request: Request) {
  const includeInactive = new URL(request.url).searchParams.get("all") === "true";

  const products = await prisma.product.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ products });
}

/** POST /api/products (admin) — JSON or multipart with an `image` part. specs/02 §4. */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const read = await readProductPayload(request);
  if (!read.ok) return apiError(read.code, read.message);

  const parsed = newProductSchema.safeParse(read.payload);
  if (!parsed.success) return validationError(parsed.error);
  const { relatedIds, slug, ...rest } = parsed.data;

  const product = await prisma.product.create({
    data: {
      ...rest,
      slug: await uniqueSlug(rest.name, slug),
      relatedIds: JSON.stringify(relatedIds ?? []),
    },
  });

  return NextResponse.json({ product }, { status: 201 });
}

/** DELETE /api/products (admin) — { ids } or ?all=true. Used by staging --reset. */
export async function DELETE(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  if (new URL(request.url).searchParams.get("all") === "true") {
    // Cascades out of every cart via CartItem.product onDelete: Cascade
    // (specs/01 §4.2). Without that this throws P2003 the moment anyone has
    // used the demo — i.e. exactly when you want to reset.
    const { count } = await prisma.product.deleteMany({});
    return NextResponse.json({ deleted: count });
  }

  const parsed = bulkDeleteSchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);
  if (!parsed.data.ids?.length) {
    return apiError("VALIDATION", "Provide { ids: string[] } or ?all=true");
  }

  const { count } = await prisma.product.deleteMany({ where: { id: { in: parsed.data.ids } } });
  return NextResponse.json({ deleted: count });
}
