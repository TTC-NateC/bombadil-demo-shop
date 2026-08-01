/**
 * Baseline seed. specs/01 §9.
 *
 * Idempotent: upserts by slug/code, so the container entrypoint can run it on
 * every start without duplicating rows.
 */
import { PrismaClient } from "@prisma/client";
import { COUPON_FIXTURES, PRODUCT_FIXTURES } from "./fixtures";

export async function seed(prisma: PrismaClient): Promise<void> {
  // --- Pass 1: products ------------------------------------------------------
  // relatedIds is deliberately NOT set here; the ids it references don't exist
  // until every product row does.
  for (const product of PRODUCT_FIXTURES) {
    const data = {
      name: product.name,
      description: product.description,
      priceCents: product.priceCents,
      category: product.category,
      active: true,
    };
    await prisma.product.upsert({
      where: { slug: product.slug },
      create: { slug: product.slug, ...data },
      update: data,
    });
  }

  // --- Pass 2: curated relatedIds -------------------------------------------
  // Resolved from slugs now that the rows exist, so every id is real.
  const bySlug = new Map(
    (await prisma.product.findMany({ select: { id: true, slug: true } })).map((p) => [p.slug, p.id]),
  );

  for (const product of PRODUCT_FIXTURES) {
    if (!product.relatedSlugs?.length) continue;
    const relatedIds = product.relatedSlugs
      .map((slug) => bySlug.get(slug))
      .filter((id): id is string => Boolean(id));
    await prisma.product.update({
      where: { slug: product.slug },
      data: { relatedIds: JSON.stringify(relatedIds) },
    });
  }

  // --- Coupons ---------------------------------------------------------------
  for (const coupon of COUPON_FIXTURES) {
    const data = {
      description: coupon.description,
      type: coupon.type,
      value: coupon.value,
      targetType: coupon.targetType,
      targetValue: coupon.targetValue ?? null,
      minSubtotalCents: coupon.minSubtotalCents ?? null,
      maxDiscountCents: coupon.maxDiscountCents ?? null,
      stackable: coupon.stackable,
      priority: coupon.priority,
      active: true,
    };
    await prisma.coupon.upsert({
      where: { code: coupon.code },
      create: { code: coupon.code, ...data },
      update: data,
    });
  }
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seed(prisma);
    const [products, coupons] = await Promise.all([prisma.product.count(), prisma.coupon.count()]);
    console.log(`Seeded: ${products} products, ${coupons} coupons.`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (`prisma db seed`), not when imported by tests.
if (process.argv[1] && process.argv[1].includes("seed")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
