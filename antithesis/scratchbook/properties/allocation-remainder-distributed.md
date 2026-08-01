# allocation-remainder-distributed

## What led here

Invariant 2 (`discountTotalCents === Σ lineDiscountCents`) is the one that encodes
spec defect #2, and it is only meaningfully exercised when a discount is split
across multiple lines *and* the split does not divide evenly. On a single-line
cart, or a cart where every share is a whole cent, the invariant holds trivially.

This marker distinguishes "invariant 2 held" from "invariant 2 was never
meaningfully tested."

## Code paths

**`src/lib/pricing/allocate.ts:11-42`:**

```
22   for (let i = 0; i < weights.length; i++) {
23     const numerator = amount * weights[i]
24     const floor = Math.floor(numerator / total)
25     parts[i] = floor
26     distributed += floor
27     remainders.push({ index: i, numerator: numerator % total })
28   }

33   let leftover = amount - distributed
34   remainders.sort((a, b) => b.numerator - a.numerator || a.index - b.index)

36   for (let i = 0; i < remainders.length && leftover > 0; i++) {
37     parts[remainders[i].index] += 1
38     leftover -= 1
39   }
```

Lines 36-39 are the branch this marker targets. They execute only when
`leftover > 0`, i.e. when the floor shares do not sum to the whole.

**Where it is called — `src/lib/pricing/engine.ts:180-183`:**

```
180   const parts = allocate(amountCents, weights)
181   matched.forEach((lineIndex, k) => {
182     lineDiscounts[lineIndex] += parts[k]
183   })
```

`weights` is the *running* base per matched line
([engine.ts:156](../../../src/lib/pricing/engine.ts#L156)) —
`subtotals[i] - lineDiscounts[i]` — so a second coupon allocates over bases
already reduced by the first. That is what makes worked example B's uneven
`[8000, 200]` split arise.

## Honest scoping: what this does and does not add

`src/lib/pricing/allocate.test.ts` already contains a randomized property test —
"always sums to the whole, across randomised inputs" — plus explicit cases for
leftover distribution and tie-breaking on the lower index. The arithmetic is
covered. This marker is **not** looking for a new bug in `allocate`.

What it confirms is that the *integration* path reaches multi-line uneven
allocation with real inputs: snapshots written by the cart routes, weights
computed from a running base after a prior coupon, and coupon combinations the
workload discovered rather than a test author chose.

The Antithesis Fit lens flagged this explicitly
(`evaluation/antithesis-fit.md`, finding AF-2) as the property in the catalog
closest to unit-test territory. It survives as a P2 reachability marker rather
than a safety property for exactly that reason — it costs almost nothing and it
qualifies the meaning of invariant 2's result.

## Detection

From the workload, on any cart response:

- at least two items have `lineDiscountCents > 0`, and
- for some discount line with `appliedTo !== "SHIPPING"`, the floor shares do not
  sum to `amountCents`.

The workload can compute the second condition from the response alone: it has
each line's `lineSubtotalCents` and `lineDiscountCents`, and each discount line's
`amountCents`. For a single-coupon cart the weights are the line subtotals
directly. For multi-coupon carts the running base is not recoverable from the
response, so the simplest reliable trigger is a **single** percent coupon on a
multi-line cart whose subtotals do not divide the discount evenly — for instance
worked example B's `[100000, 2000]` shape, where a 10% cart-wide coupon produces
`[8000, 200]` only after `ELECTRO20` has already reduced the first line.

That recoverability limit is the reason the assertion is a coarse marker rather
than a precise check.

## Assertion design

`Reachable("largest-remainder leftover pennies distributed across 2+ lines")`.

`Reachable` for the same reason as the other two markers in this category: it
records that a code path executed, with no further semantic condition.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists** as an
Antithesis assertion. The *logic* exists as Vitest coverage in
`src/lib/pricing/allocate.test.ts`, which is why this is scoped as a marker
rather than a check.

- **Missing, workload-side:** the `Reachable` marker on the response-observable
  signature above.
- **Missing, SUT-side (strictly better, and cheap):** a `Reachable` at
  [allocate.ts:36](../../../src/lib/pricing/allocate.ts#L36) inside the leftover
  loop, guarded on `weights.length >= 2`. From inside, `leftover > 0` is directly
  known — no reconstruction needed and no ambiguity from multi-coupon running
  bases. This is the better placement if any SUT instrumentation is added at all.
  It pairs naturally with the `Number.isSafeInteger(amount * weights[i])`
  assertion that `money-fields-stay-exact.md` asks for at
  [allocate.ts:23](../../../src/lib/pricing/allocate.ts#L23) — one small file,
  two markers, both useful.

## Open questions

None. The branch, its trigger condition, and the existing Vitest coverage are all
directly verifiable, and the property makes no claim beyond "this path was
reached."
