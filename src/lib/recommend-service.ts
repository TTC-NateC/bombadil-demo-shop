/**
 * The I/O half of recommendations. specs/03 §2.2.
 *
 * Loads the catalog and hands it to the pure function — recommend.ts never
 * touches Prisma.
 */
import { prisma } from "./db";
import { parseRelatedIds, recommend } from "./recommend";

export { DEFAULT_LIMIT, parseLimit } from "./recommend";

export async function recommendationsFor(sourceProductIds: string[], limit: number) {
  const catalog = await prisma.product.findMany({ where: { active: true } });

  const recommended = recommend({
    sourceProductIds,
    limit,
    catalog: catalog.map((product) => ({
      ...product,
      relatedIds: parseRelatedIds(product.relatedIds),
    })),
  });

  // Re-serialise relatedIds so the API shape matches every other product
  // response.
  return recommended.map((product) => ({
    ...product,
    relatedIds: JSON.stringify(product.relatedIds),
  }));
}
