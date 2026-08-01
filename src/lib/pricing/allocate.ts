/**
 * Largest-remainder allocation. specs/01 §5.5.
 *
 * Splits `amount` across `weights` so the parts sum to the whole EXACTLY.
 * Naive per-line half-up rounding drifts by a cent or two and breaks the
 * `discountTotalCents === Σ lineDiscountCents` invariant (§5.2).
 *
 * All arithmetic is integer: the fractional part is kept as a remainder
 * numerator rather than a float, so no representation error can reach a result.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const parts = new Array<number>(weights.length).fill(0);
  if (amount === 0 || weights.length === 0) return parts;

  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) return parts;

  // Exact share = amount * weight / total. Keep floor and remainder separately.
  const remainders: { index: number; numerator: number }[] = [];
  let distributed = 0;

  for (let i = 0; i < weights.length; i++) {
    const numerator = amount * weights[i];
    const floor = Math.floor(numerator / total);
    parts[i] = floor;
    distributed += floor;
    remainders.push({ index: i, numerator: numerator % total });
  }

  // Hand the leftover pennies to the largest fractional parts. Ties break on
  // the lower index so the result is deterministic across runs — never rely on
  // sort stability for this.
  let leftover = amount - distributed;
  remainders.sort((a, b) => b.numerator - a.numerator || a.index - b.index);

  for (let i = 0; i < remainders.length && leftover > 0; i++) {
    parts[remainders[i].index] += 1;
    leftover -= 1;
  }

  return parts;
}
