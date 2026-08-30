/**
 * Request schemas. specs/02 §6.
 *
 * Coupon type/target enums derive from the §4.3 constants rather than being
 * re-listed here, so there is one source of truth.
 */
import { z } from "zod";
import { couponTypeSchema, targetTypeSchema } from "@/lib/pricing/types";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const newProductSchema = z.object({
  slug: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  priceCents: z.number().int().positive(),
  currency: z.string().min(3).max(3).optional(),
  category: z.string().optional(),
  imageUrl: z.string().optional(),
  active: z.boolean().optional(),
  relatedIds: z.array(z.string()).optional(),
});

export const patchProductSchema = newProductSchema.partial();

export const bulkProductsSchema = z.object({
  products: z.array(newProductSchema).min(1),
});

export const newCouponSchema = z.object({
  code: z.string().min(1),
  description: z.string().optional(),
  type: couponTypeSchema,
  value: z.number().int().min(0).default(0),
  targetType: targetTypeSchema.default("CART"),
  targetValue: z.string().nullish(),
  minSubtotalCents: z.number().int().positive().nullish(),
  maxDiscountCents: z.number().int().positive().nullish(),
  stackable: z.boolean().default(true),
  priority: z.number().int().default(100),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  usageLimit: z.number().int().positive().nullish(),
  active: z.boolean().default(true),
});

export const patchCouponSchema = newCouponSchema.partial();

export const bulkCouponsSchema = z.object({
  coupons: z.array(newCouponSchema).min(1),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.string()).optional(),
  codes: z.array(z.string()).optional(),
});

/** Validates every row up front and reports per-index errors (all-or-nothing). */
export function validateRows<T>(
  rows: unknown[],
  schema: z.ZodType<T>,
): { ok: true; data: T[] } | { ok: false; errors: { index: number; issues: unknown }[] } {
  const data: T[] = [];
  const errors: { index: number; issues: unknown }[] = [];

  rows.forEach((row, index) => {
    const parsed = schema.safeParse(row);
    if (parsed.success) data.push(parsed.data);
    else errors.push({ index, issues: parsed.error.flatten() });
  });

  return errors.length ? { ok: false, errors } : { ok: true, data };
}
