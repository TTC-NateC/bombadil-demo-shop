/**
 * Pure staging helpers. specs/02 §9.3, §9.4, §9.6.
 *
 * No fetch, no filesystem — the script wires these to I/O. That is what makes
 * them testable.
 */
import { slugify } from "@/lib/api/schemas";
import { intBetween, pick, type Rng } from "./rng";

export interface PriceConfig {
  minCents: number;
  maxCents: number;
  roundTo?: number;
  perCategory?: Record<string, { minCents: number; maxCents: number }>;
}

export interface Pools {
  productNames: string[];
  descriptions: string[];
  categories: string[];
  adjectives: string[];
  couponTemplates: CouponTemplate[];
  priceConfig: PriceConfig;
}

export interface CouponTemplate {
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  value?: number;
  valueRange?: [number, number];
  minSubtotalCents?: number;
  minSubtotalRange?: [number, number];
  maxDiscountCents?: number;
  stackable?: boolean;
  priority?: number;
  targetType?: "CART" | "CATEGORY" | "PRODUCT";
}

export interface GeneratedProduct {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
}

export interface GeneratedCoupon {
  code: string;
  description: string;
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  value: number;
  targetType: "CART" | "CATEGORY" | "PRODUCT";
  targetValue?: string;
  minSubtotalCents?: number;
  maxDiscountCents?: number;
  stackable: boolean;
  priority: number;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function composeName(rng: Rng, names: string[], adjectives: string[]): string {
  const base = pick(rng, names);
  if (adjectives.length === 0) return base;
  // Roughly half get an adjective, so the pool stretches further.
  return rng() < 0.5 ? `${pick(rng, adjectives)} ${base}` : base;
}

/**
 * Charm rounding: force the price to end in `roundTo` (e.g. 99). Rounds DOWN to
 * the hundred then adds the ending, and bumps up a hundred if that would fall
 * below the floor.
 */
export function charmRound(cents: number, roundTo: number | undefined, minCents: number): number {
  if (roundTo === undefined) return cents;
  const hundreds = Math.floor(cents / 100) * 100;
  const candidate = hundreds + roundTo;
  if (candidate < minCents) return candidate + 100;
  return candidate;
}

export function pickPrice(rng: Rng, config: PriceConfig, category: string): number {
  const bounds = config.perCategory?.[category] ?? config;
  const raw = intBetween(rng, bounds.minCents, bounds.maxCents);
  return charmRound(raw, config.roundTo, bounds.minCents);
}

/**
 * Slug de-duplicator. Seeded with the slugs already in the catalog so a second
 * `npm run stage` without --reset appends cleanly instead of colliding on
 * `slug @unique` for most rows (§9.3 step 2).
 */
export function makeSlugFactory(taken: Iterable<string>) {
  const used = new Set(taken);
  return (name: string): string => {
    const base = slugify(name) || "product";
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    return candidate;
  };
}

export function generateProducts(
  rng: Rng,
  pools: Pools,
  count: number,
  existingSlugs: Iterable<string> = [],
): GeneratedProduct[] {
  const nextSlug = makeSlugFactory(existingSlugs);
  const products: GeneratedProduct[] = [];

  for (let i = 0; i < count; i++) {
    const name = composeName(rng, pools.productNames, pools.adjectives);
    const category = pick(rng, pools.categories);
    const description =
      rng() < 0.4
        ? `${pick(rng, pools.descriptions)} ${pick(rng, pools.descriptions)}`
        : pick(rng, pools.descriptions);

    products.push({
      slug: nextSlug(name),
      name,
      description,
      priceCents: pickPrice(rng, pools.priceConfig, category),
      category,
    });
  }

  return products;
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

const CODE_WORDS = ["SAVE", "DEAL", "SUMMER", "FLASH", "EXTRA", "BONUS", "VIP", "MEGA", "FREESHIP"];

/**
 * The five interesting cases, guaranteed so the demo always exercises the whole
 * pricing engine (§9.4).
 */
export const GUARANTEED_TEMPLATES: CouponTemplate[] = [
  { type: "PERCENT", valueRange: [500, 2500], stackable: true },
  { type: "FIXED", valueRange: [500, 2000], minSubtotalRange: [3000, 8000], stackable: true },
  { type: "FREE_SHIPPING", stackable: true },
  { type: "PERCENT", value: 2500, stackable: false, maxDiscountCents: 3000 },
  { type: "PERCENT", valueRange: [1000, 2000], targetType: "CATEGORY", stackable: true },
];

export function resolveTemplate(
  rng: Rng,
  template: CouponTemplate,
  categories: string[],
  taken: Set<string>,
): GeneratedCoupon | null {
  const targetType = template.targetType ?? "CART";

  let targetValue: string | undefined;
  if (targetType === "CATEGORY") {
    // With --products 0 the catalog may be empty; fall back to the pool, and
    // skip the template entirely if that is empty too (§9.4).
    if (categories.length === 0) return null;
    targetValue = pick(rng, categories);
  }

  const value =
    template.value ??
    (template.valueRange ? intBetween(rng, template.valueRange[0], template.valueRange[1]) : 0);

  const minSubtotalCents =
    template.minSubtotalCents ??
    (template.minSubtotalRange
      ? intBetween(rng, template.minSubtotalRange[0], template.minSubtotalRange[1])
      : undefined);

  let code = `${pick(rng, CODE_WORDS)}${intBetween(rng, 5, 40)}`;
  while (taken.has(code)) code = `${code}${intBetween(rng, 0, 9)}`;
  taken.add(code);

  return {
    code,
    description: describe(template.type, value, targetValue, minSubtotalCents),
    type: template.type,
    value,
    targetType,
    targetValue,
    minSubtotalCents,
    maxDiscountCents: template.maxDiscountCents,
    stackable: template.stackable ?? true,
    priority: template.priority ?? 100,
  };
}

function describe(
  type: CouponTemplate["type"],
  value: number,
  targetValue?: string,
  minSubtotalCents?: number,
): string {
  const scope = targetValue ? ` on ${targetValue}` : "";
  const gate = minSubtotalCents ? ` over $${(minSubtotalCents / 100).toFixed(0)}` : "";
  if (type === "FREE_SHIPPING") return "Free shipping";
  if (type === "PERCENT") return `${value / 100}% off${scope}${gate}`;
  return `$${(value / 100).toFixed(0)} off${scope}${gate}`;
}

export function generateCoupons(
  rng: Rng,
  templates: CouponTemplate[],
  count: number,
  categories: string[],
  existingCodes: Iterable<string> = [],
): GeneratedCoupon[] {
  const taken = new Set(existingCodes);
  const coupons: GeneratedCoupon[] = [];

  // Guaranteed cases first, then sample from the supplied templates.
  const queue: CouponTemplate[] = [];
  for (let i = 0; i < count; i++) {
    queue.push(
      i < GUARANTEED_TEMPLATES.length
        ? GUARANTEED_TEMPLATES[i]
        : templates.length
          ? pick(rng, templates)
          : pick(rng, GUARANTEED_TEMPLATES),
    );
  }

  for (const template of queue) {
    const coupon = resolveTemplate(rng, template, categories, taken);
    if (coupon) coupons.push(coupon);
  }

  return coupons;
}
