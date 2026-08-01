# priced-cart-invariants-hold

## What led here

`specs/01` §5.2 lists seven invariants and instructs "assert these in tests."
`specs/01` AC 7 goes further: "Every §5.2 invariant holds on every `GET /api/cart`
response."

The codebase implements them in `src/lib/pricing/invariants.ts`. The file's doc
comment says the helper is "called at the end of EVERY engine test **and on every
API response in the cart-route tests**." The second half of that sentence is not
true at this commit — grep finds no cart-route test file, and no route handler
imports `assertInvariants`. The invariants are enforced against the pure engine
only.

That gap is the property: the invariants are stated as holding on API responses,
and nothing checks API responses.

## Code paths

**`src/lib/pricing/invariants.ts:11-75`** — `assertInvariants(priced, label)`.
Pure, takes a `PricedCart`, throws a labeled `Error` on the first violation:

| # | Check | Line |
|---|---|---|
| 1 | `discountTotalCents === Σ non-SHIPPING discount lines` | 26 |
| 2 | `discountTotalCents === Σ items[].lineDiscountCents` | 33 |
| 3 | `shippingDiscountCents === Σ SHIPPING discount lines` | 40 |
| 4 | `shippingCents >= 0` | 47 |
| 5 | per-line arithmetic, `lineTotal = lineSubtotal - lineDiscount`, both `>= 0` | 50-59 |
| 6 | `subtotalCents === Σ lineSubtotalCents` | 62 |
| 7 | `totalCents === max(0, subtotal - discount + shipping + tax)` and `>= 0` | 67-74 |

**Where a `PricedCart` reaches the wire:** every cart route returns
`await priceAndPrune(cartId)` directly as the JSON body —
`src/app/api/cart/route.ts:7`, `items/route.ts:48, 69, 84`,
`coupons/route.ts:22, 40`. So the workload can check all seven on every one of
those six responses.

## Why Antithesis adds value here beyond Vitest

`src/lib/pricing/engine.test.ts` is thorough: worked examples A, B and C verbatim,
eligibility, clamping, tax, targeting, determinism across 100 shuffled inputs, and
`assertInvariants` at the end of each. That coverage is real, and it means the
*arithmetic* is not where the bug is.

What it does not cover is the engine's **inputs**, all of which arrive from I/O
and all of which other requests can be mutating:

- `unitPriceCents` comes from `CartItem.unitPriceCentsSnapshot`, written by a
  possibly-racing add ([cart.ts:107](../../../src/lib/cart.ts#L107)).
- `quantity` comes from a row a concurrent PATCH may be rewriting.
- `coupons` comes from a `findMany` whose rows an admin may delete between the
  read and the next pass ([cart.ts:98-100](../../../src/lib/cart.ts#L98-L100)).
- `config` is re-read from `process.env` on every pass
  ([cart.ts:114](../../../src/lib/cart.ts#L114)).
- The `now` used for coupon date eligibility is `new Date()` at
  [engine.ts:242](../../../src/lib/pricing/engine.ts#L242).

This property is the tripwire that catches any of those combinations producing an
internally inconsistent cart, and it costs almost nothing to check on every
response.

## What goes wrong

The two invariants with the most history are 1 and 2, which encode the two most
expensive defects in the project's own review table
(`shopping-cart-demo-spec.md`, defects #1 and #2):

- Invariant 1 broken → shipping counted in `discountTotalCents` → the discount is
  subtracted twice and the tax base shrinks. The review notes a `4000` cart came
  out `647` low.
- Invariant 2 broken → per-line allocation drifts from the total → the breakdown
  the shopper reads does not add up to the total they are charged.

Both were fixed at the spec level. Neither has a runtime check on the API path.

## Assertion design

Seven separate `Always` assertions with seven distinct messages, **not** one
assertion wrapping a call to `assertInvariants`. Two reasons:

1. `references/property-catalog.md` requires every assertion message to be unique
   and specific; a single message covering seven unrelated checks is the shape it
   warns against.
2. `assertInvariants` throws on the *first* failure, so a single wrapper would
   report only whichever check happened to be listed earliest. Splitting them
   means a run reports every invariant that broke.

The workload can import the checks' logic directly from `invariants.ts` — it is
pure and dependency-free — but must restructure the single-throw into seven
independent evaluations.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **no Antithesis assertion
exists.** `assertInvariants` exists as a plain throwing helper used only by
Vitest, so this is a case of *partially present* logic with no Antithesis
instrumentation at all.

- **Present (logic only):** `src/lib/pricing/invariants.ts` — reusable, needs
  splitting into seven checks.
- **Missing, workload-side:** the seven `Always` assertions against every cart
  response.
- **Missing, SUT-side:** none required. Calling `assertInvariants` inside
  `priceAndPrune` would catch violations one hop earlier, but the workload sees
  the same object, so it buys little.

## Open questions

None. The invariants are fully specified in `specs/01` §5.2, implemented in
`invariants.ts`, and the response objects are directly observable from the
workload. Nothing about the property's claim is uncertain.
