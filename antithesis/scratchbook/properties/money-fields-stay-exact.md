# money-fields-stay-exact

## What led here

Focus 11 (unproven assumptions). `src/lib/money.ts:16-19` states the assumption
the entire money layer rests on, in a comment:

> "base is cents (<= ~1e9 in any realistic cart) and bps <= 10000, so the
> intermediate product stays far below `Number.MAX_SAFE_INTEGER`."

Nothing enforces the antecedent. The word doing the work is "realistic."

## Code paths

**Unbounded inputs, both reachable:**

```
src/app/api/cart/items/route.ts:12-15
  const setSchema = z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(0),      // no .max() — PATCH, unauthenticated
  })

src/app/api/cart/items/route.ts:7-10
  quantity: z.number().int().positive().default(1)   // no .max() — POST, unauthenticated

src/lib/api/schemas.ts:23
  priceCents: z.number().int().positive(),           // no .max() — admin only
```

The `PATCH` path is the one that matters most: it needs no admin key. A shopper
can set any quantity on any product already in their cart.

**Where the product is computed:**

```
src/lib/pricing/engine.ts:26
  function lineSubtotal(item) { return item.unitPriceCents * item.quantity }

src/lib/money.ts:21
  return Math.floor((base * bps + 5000) / 10000)     // percentOfBps

src/lib/pricing/allocate.ts:23
  const numerator = amount * weights[i]              // amount and weight both large
```

`allocate.ts`'s header comment claims "All arithmetic is integer: the fractional
part is kept as a remainder numerator rather than a float, so no representation
error can reach a result." That is true of the *algorithm* — it holds for exact
integers. JavaScript numbers stop being exact integers above 2^53, and
`amount * weights[i]` is the product of two quantities that are each already the
product of a price and a quantity.

## Failure scenario

1. Cart contains one line: a seeded product at `priceCents: 12999`.
2. `PATCH /api/cart/items {productId, quantity: 1_000_000_000_000}` — accepted,
   `z.number().int().min(0)` passes.
3. `lineSubtotalCents = 12999 × 1e12 ≈ 1.3e16` — above
   `Number.MAX_SAFE_INTEGER` (≈9.007e15). Arithmetic is now inexact.
4. Apply a percent coupon. `percentOfBps(base, 1000)` computes
   `base * 1000 + 5000` ≈ 1.3e19 — far past exact range; the result is a rounded
   double.
5. `allocate(amount, weights)` computes `amount * weights[i]` — larger still.

The invariants most likely to break first are 2
(`discountTotalCents === Σ lineDiscountCents`, because `allocate`'s floor/remainder
bookkeeping stops summing exactly) and 7 (`totalCents === max(0, subtotal -
discount + shipping + tax)`, because the two sides round differently). So this
property and `priced-cart-invariants-hold` will usually fire together — this one
identifies *why*.

A second, subtler variant: `quantity` need not be absurd if `priceCents` is. An
admin-created product at `priceCents: 9_000_000_000_000_000` with quantity 2
reaches the same place.

## Why this is an Antithesis property and not just a unit test

Honest accounting: the core of this is input-space exploration, not fault timing.
A fuzzer with no fault injection would find the overflow. Two things still argue
for keeping it here:

- The interesting failures need a *combination*: a large line subtotal **and** a
  coupon set that forces multi-line allocation **and** a percentage that pushes
  the intermediate product highest. Antithesis's search explores that combination
  space; a hand-written test explores whichever case the author imagined.
- The assertion is nearly free once `priced-cart-invariants-hold` is in place —
  same responses, same loop.

It is scored P1 rather than P0 for this reason, and the Antithesis Fit lens
flagged it explicitly (`evaluation/antithesis-fit.md`).

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** `Always(Number.isSafeInteger(v))` over every money
  field in every `PricedCart` — `subtotalCents`, `discountTotalCents`,
  `shippingDiscountCents`, `shippingCents`, `taxCents`, `totalCents`, plus each
  item's three line fields and each discount line's `amountCents`.
- **Missing, SUT-side (would sharpen it):** an assertion inside
  [allocate.ts:23](../../../src/lib/pricing/allocate.ts#L23) that
  `Number.isSafeInteger(amount * weights[i])`. This is the innermost point where
  precision is lost and it is invisible from the response, which only shows the
  already-rounded result. Good replay anchor.

## Open questions

- **Is there an intended upper bound on cart quantity or product price?** If yes,
  the fix is a `.max()` on the Zod schemas and this property becomes a check that
  the bound is enforced (a much easier assertion, and the overflow becomes
  unreachable). If no bound is intended, the property stands as written and the
  engine needs to handle values that exceed exact-integer range. The distinction
  changes both the assertion and where the defect lives.

### Investigation Log

#### Is there an intended upper bound on cart quantity or product price?

- Examined: `src/lib/api/schemas.ts` (all Zod schemas), `src/app/api/cart/items/route.ts`
  (`addSchema`, `setSchema`), `specs/01` §5.1 and §7.2-7.3, `specs/02` §4 and §6,
  `prisma/schema.prisma` (`Int` columns), `src/lib/money.ts` comments,
  `staging/price-config.json`.
- Found: no `.max()`, `.lte()`, or equivalent on any quantity or price schema.
  `prisma/schema.prisma` declares `priceCents Int` and `quantity Int`, which in
  SQLite is a 64-bit integer — wider than JavaScript's exact-integer range, so the
  database will happily store values the engine cannot compute on.
  `staging/price-config.json` bounds *generated* prices (`minCents`/`maxCents`),
  but that constrains the staging script only, not the endpoint.
  `src/lib/money.ts:18` states the ~1e9 expectation as a comment.
- Not found: any spec statement of a maximum quantity, maximum price, or maximum
  cart value. `specs/01` §5 discusses clamping discounts to the base and flooring
  totals at zero, but never an upper bound.
- Conclusion: tagged `(needs human input)`. The repository shows the bound was
  assumed rather than decided; choosing one is a design call.
