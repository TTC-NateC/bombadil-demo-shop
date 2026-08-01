import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { apiError, readJson } from "@/lib/api/errors";
import { bulkCouponsSchema, newCouponSchema, validateRows } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";

/** POST /api/coupons/bulk (admin) — same all-or-nothing validation as products. */
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const body = await readJson(request);
  const envelope = bulkCouponsSchema.safeParse(body);
  if (!envelope.success) {
    const rows = (body as { coupons?: unknown[] })?.coupons;
    if (Array.isArray(rows)) {
      const result = validateRows(rows, newCouponSchema);
      if (!result.ok) {
        return apiError("VALIDATION", "One or more coupons are invalid", result.errors);
      }
    }
    return apiError("VALIDATION", "Expected { coupons: NewCoupon[] }");
  }

  const prepared = envelope.data.coupons.map((row) => ({
    ...row,
    code: row.code.trim().toUpperCase(),
  }));

  const duplicatesInBatch = prepared
    .map((c) => c.code)
    .filter((code, index, all) => all.indexOf(code) !== index);
  if (duplicatesInBatch.length) {
    return apiError("CONFLICT", `Duplicate codes in batch: ${[...new Set(duplicatesInBatch)].join(", ")}`);
  }

  const existing = await prisma.coupon.findMany({
    where: { code: { in: prepared.map((c) => c.code) } },
    select: { code: true },
  });
  if (existing.length) {
    return apiError("CONFLICT", `Already exists: ${existing.map((c) => c.code).join(", ")}`);
  }

  const coupons = await prisma.$transaction(
    prepared.map((data) => prisma.coupon.create({ data })),
  );

  return NextResponse.json({ created: coupons.length, coupons }, { status: 201 });
}
