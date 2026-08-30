import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { apiError, readJson, validationError } from "@/lib/api/errors";
import { patchCouponSchema } from "@/lib/api/schemas";
import { prisma } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/coupons/[id] (admin) — partial update. 409 on code collision. */
export async function PATCH(request: Request, { params }: Params) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) return apiError("NOT_FOUND", `No coupon "${id}"`);

  const parsed = patchCouponSchema.safeParse(await readJson(request));
  if (!parsed.success) return validationError(parsed.error);

  const data = { ...parsed.data };
  if (data.code) {
    data.code = data.code.trim().toUpperCase();
    const clash = await prisma.coupon.findUnique({
      where: { code: data.code },
      select: { id: true },
    });
    if (clash && clash.id !== id) {
      return apiError("CONFLICT", `Coupon ${data.code} already exists`);
    }
  }

  const coupon = await prisma.coupon.update({ where: { id }, data });
  return NextResponse.json({ coupon });
}

/**
 * DELETE /api/coupons/[id] (admin).
 *
 * A cart holding the removed code drops it on the next pricing pass — that is
 * just §5.6's prune rule, which needs no special case for deletion.
 */
export async function DELETE(request: Request, { params }: Params) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const existing = await prisma.coupon.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return apiError("NOT_FOUND", `No coupon "${id}"`);

  await prisma.coupon.delete({ where: { id } });
  return NextResponse.json({ deleted: true });
}
