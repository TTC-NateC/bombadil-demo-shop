/**
 * Money helpers. specs/01 §2, §5.5.
 *
 * Everything here is integer cents. The only place a non-integer is allowed to
 * exist is inside `roundHalfUp`, and it leaves as an integer.
 */

/** Half-up rounding: ties go toward +Infinity. roundHalfUp(2.5) === 3, roundHalfUp(-2.5) === -2. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/**
 * `base * bps / 10000`, half-up, computed in integer arithmetic so no float
 * representation error can reach the result.
 *
 * base is cents (<= ~1e9 in any realistic cart) and bps <= 10000, so the
 * intermediate product stays far below Number.MAX_SAFE_INTEGER.
 */
export function percentOfBps(base: number, bps: number): number {
  return Math.floor((base * bps + 5000) / 10000);
}

/** Render cents for display. The ONLY place currency formatting happens. */
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}
