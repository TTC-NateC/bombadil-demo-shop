/**
 * Seeded RNG. specs/02 §9.5.
 *
 * Every helper takes the generator as a parameter — nothing here calls global
 * Math.random, which is what makes `--seed` reproducible at all.
 */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() called with an empty pool");
  return items[Math.floor(rng() * items.length)];
}

export function intBetween(rng: Rng, min: number, max: number): number {
  if (max < min) [min, max] = [max, min];
  return min + Math.floor(rng() * (max - min + 1));
}

/** Sample without replacement until exhausted, then start over (§9.3 step 6). */
export function cyclingSampler<T>(rng: Rng, items: readonly T[]): () => T | undefined {
  if (items.length === 0) return () => undefined;
  let pool: T[] = [];
  return () => {
    if (pool.length === 0) pool = [...items];
    const index = Math.floor(rng() * pool.length);
    return pool.splice(index, 1)[0];
  };
}
