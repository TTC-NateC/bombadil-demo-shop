/**
 * Recommendations. specs/03 §2.
 *
 * Pure, like the pricing engine: the API route loads the catalog and passes it
 * in. Layered with a deterministic fallback so the section is never empty.
 */

export interface RecommendableProduct {
  id: string;
  category: string | null;
  /** Already parsed from the JSON column by the caller. */
  relatedIds: string[];
  createdAt: Date;
}

export interface RecommendInput<T extends RecommendableProduct> {
  /** One id for the PDP, many for the cart. */
  sourceProductIds: string[];
  /** Active products only. */
  catalog: T[];
  limit?: number;
}

interface Candidate {
  id: string;
  /** How many source products recommended it — multi-hit items rank first. */
  hits: number;
  /** First appearance, so a single source preserves its curated ordering. */
  firstSeen: number;
}

function collect(): {
  add: (id: string, order: number) => void;
  ranked: () => string[];
} {
  const map = new Map<string, Candidate>();
  return {
    add(id, order) {
      const existing = map.get(id);
      if (existing) existing.hits += 1;
      else map.set(id, { id, hits: 1, firstSeen: order });
    },
    ranked() {
      return [...map.values()]
        .sort((a, b) => b.hits - a.hits || a.firstSeen - b.firstSeen || a.id.localeCompare(b.id))
        .map((c) => c.id);
    },
  };
}

export function recommend<T extends RecommendableProduct>(input: RecommendInput<T>): T[] {
  const limit = input.limit ?? 4;
  if (limit <= 0) return [];

  const byId = new Map(input.catalog.map((product) => [product.id, product]));
  const sources = input.sourceProductIds
    .map((id) => byId.get(id))
    .filter((product): product is T => Boolean(product));

  // Everything already in the source set (the viewed product, or the cart) is
  // excluded from every layer.
  const excluded = new Set(input.sourceProductIds);

  // --- Layer 1: manual overrides, highest priority, in the order listed ------
  const manual = collect();
  let order = 0;
  for (const source of sources) {
    for (const id of source.relatedIds) {
      if (!excluded.has(id) && byId.has(id)) manual.add(id, order++);
    }
  }

  // --- Layer 2: same category ----------------------------------------------
  const sameCategory = collect();
  const sourceCategories = new Set(
    sources.map((s) => s.category).filter((c): c is string => Boolean(c)),
  );
  // Iterate a stable, catalog-order-independent list so shuffling the input
  // cannot change the output.
  const stableCatalog = [...input.catalog].sort((a, b) => a.id.localeCompare(b.id));
  for (const product of stableCatalog) {
    if (excluded.has(product.id) || !product.category) continue;
    if (sourceCategories.has(product.category)) {
      const hits = sources.filter((s) => s.category === product.category).length;
      for (let i = 0; i < hits; i++) sameCategory.add(product.id, order);
      order++;
    }
  }

  // --- Layer 3: fallback, newest first --------------------------------------
  const fallback = [...input.catalog]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((product) => product.id)
    .filter((id) => !excluded.has(id));

  // --- Assemble -------------------------------------------------------------
  const seen = new Set<string>();
  const result: T[] = [];

  for (const id of [...manual.ranked(), ...sameCategory.ranked(), ...fallback]) {
    if (result.length >= limit) break;
    if (seen.has(id) || excluded.has(id)) continue;
    const product = byId.get(id);
    if (!product) continue;
    seen.add(id);
    result.push(product);
  }

  return result;
}

export const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 24;

/**
 * Parses a `?limit=` query parameter.
 *
 * Note the explicit null/blank check: `Number(null)` is 0, not NaN, so a
 * `Number.isFinite` guard alone silently turns "no limit supplied" into
 * "return nothing".
 */
export function parseLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.trunc(value)));
}

/** Parses Prisma's JSON `relatedIds` column defensively. */
export function parseRelatedIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}
