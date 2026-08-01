import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { apiError, readJson, validationError } from "@/lib/api/errors";
import { bulkDeleteSchema, newCouponSchema } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";

/** GET /api/coupons (admin) — specs/02 §5. */
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const coupons = await prisma.coupon.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ coupons });
}

/** POST /api/coupons (admin) — code normalised to uppercase; duplicate -> 409. */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parsed = newCouponSchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);

  const code = parsed.data.code.trim().toUpperCase();
  if (await prisma.coupon.findUnique({ where: { code }, select: { id: true } })) {
    return apiError("CONFLICT", `Coupon ${code} already exists`);
  }

  const coupon = await prisma.coupon.create({ data: { ...parsed.data, code } });
  return NextResponse.json({ coupon }, { status: 201 });
}

/** DELETE /api/coupons (admin) — { ids } or { codes }, or ?all=true. */
export async function DELETE(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  if (new URL(request.url).searchParams.get("all") === "true") {
    const { count } = await prisma.coupon.deleteMany({});
    return NextResponse.json({ deleted: count });
  }

  const parsed = bulkDeleteSchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);
  const { ids, codes } = parsed.data;

  if (!ids?.length && !codes?.length) {
    return apiError("VALIDATION", "Provide { ids } or { codes }, or ?all=true");
  }

  const { count } = await prisma.coupon.deleteMany({
    where: {
      OR: [
        ...(ids?.length ? [{ id: { in: ids } }] : []),
        ...(codes?.length ? [{ code: { in: codes.map((c) => c.toUpperCase()) } }] : []),
      ],
    },
  });

  return NextResponse.json({ deleted: count });
}
