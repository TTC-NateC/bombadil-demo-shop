# coupon-removal-is-reversible

## What led here

Focus 12 (wildcard). `specs/01` §5.6 records the behavior and then defends it:

> "Consequence: removing an exclusive coupon does not restore previously
> superseded codes — the shopper re-enters them. Because §5.3 only ever supersedes
> when the exclusive produces a *lower total*, nothing of value was lost at
> eviction time."

The defence is scoped to the eviction instant, and it is correct there. It does
not cover the sequence that follows. That is claim S8 in `sut-analysis.md` §5,
and the property tests the claim as written.

## Code paths

**Supersession — `src/lib/pricing/engine.ts:268-281`:**

```
269   const winningCodes = new Set(winner.candidateCodes)
270   const winnerIsExclusive = winner.candidateCodes.length === 1 && exclusives.some(...)

274   const superseded: RejectedCoupon[] = eligible
275     .filter((c) => !winningCodes.has(c.code))
276     .map((c) => ({ couponCode: c.code, reason: ... }))
```

**Eviction — `src/lib/cart.ts:117-124`:** the superseded codes are not in
`discountLines`, so `appliedCodes` excludes them, so the prune writes them out of
`Cart.coupons`. They are gone from persisted state, not merely deprioritized.

**Removal — `src/app/api/cart/coupons/route.ts:26-41`:** filters the named code
out of `Cart.coupons` and re-prices. The pricing pass now sees only whatever
remained — which, after a supersession, is nothing.

## Failure scenario

Using the seeded coupon set (`specs/01` §9): `SAVE10` (10% cart, stackable),
`TAKE15` ($15 off, min 5000, stackable), `VIP25` (25%, non-stackable, cap 3000).

Take a cart large enough that `VIP25` beats the stackable pair — `specs/01` §5.7
worked example C is deliberately the case where it *loses* at subtotal 5000, so
the workload needs a larger cart to flip it. At a subtotal where the cap is not
binding, `VIP25` at 25% beats `SAVE10 + TAKE15`.

| Step | Action | `Cart.coupons` after | Total |
|---|---|---|---|
| 1 | apply `SAVE10` | `["SAVE10"]` | T₁ |
| 2 | apply `TAKE15` | `["SAVE10","TAKE15"]` | T₂ ≤ T₁ |
| 3 | apply `VIP25` (wins) | `["VIP25"]` | T₃ ≤ T₂ |
| 4 | remove `VIP25` | `[]` | T₄ = **no-coupon total** |

T₄ > T₂ — and T₄ > T₁. The shopper is worse off than at step 1, having done
nothing but try a code and change their mind. There is no message: the eviction
at step 3 produced `rejectedCoupons` entries, but the UI only reads them when it
just applied a code, and by step 4 they are gone. Nothing tells the shopper their
earlier coupons were dropped rather than suspended.

## Why the spec's defence doesn't cover this

The defence says supersession only happens at a lower total, so the eviction is
value-preserving *at that moment*. True. But the eviction is destructive rather
than a shadowing — the superseded codes leave persisted state entirely — so the
value is only preserved for as long as the superseding coupon is held. The spec
notices the consequence ("the shopper re-enters them") without connecting it to
the total moving in the wrong direction.

Whether that is a defect or an accepted UX trade-off is a product judgment. The
property does not prejudge it; it tests the claim the spec makes.

## Interaction with concurrency

`cart-coupon-set-atomic` makes this worse in a way worth recording: a prune from
a *concurrent* request can evict a coupon another request just applied, producing
the same lossy transition with no removal at all. When triaging a violation here,
check whether a concurrent operation touched the cart — the workload must
serialize its own operations for this check, exactly as in
`applying-coupon-never-raises-total`.

## Relationship to `isBetter`

`isBetter`'s "fewest coupons" tie-break counts `candidateCodes`, which is every
code handed to the pass rather than every code that applied
([engine.ts:219](../../../src/lib/pricing/engine.ts#L219),
[engine.ts:232](../../../src/lib/pricing/engine.ts#L232)). On a tie between a
three-coupon stackable set where one applies and a single exclusive, the exclusive
wins on count. Totals are equal, so `applying-coupon-never-raises-total` is
unaffected — but the *persisted* set differs, and this property is the one that
sees the difference, because what gets evicted determines what a later removal
falls back to.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** capture `totalCents`, apply X, remove X, assert the
  final total ≤ the captured total. Per-cart serialization required.
- **Missing, SUT-side (valuable):** an assertion where `superseded` is built
  ([engine.ts:274](../../../src/lib/pricing/engine.ts#L274)) recording that codes
  were evicted by supersession, and how many. From outside, an eviction and a
  coupon simply not qualifying look identical once the response is gone — this
  marker separates them and anchors replay.

## Open questions

- **Is the documented supersession behavior intended to survive removal of the
  superseding coupon, or is re-entering the pruned codes the accepted UX?** If
  eviction is meant to be recoverable, `Cart.coupons` needs to retain superseded
  codes in a shadow set and this is a real defect. If re-entry is accepted, the
  property should be restated as "the total after apply-then-remove equals the
  no-coupon total" — still checkable, still worth asserting, but a different
  claim, and the spec's "nothing of value was lost" sentence should be narrowed.

### Investigation Log

#### Is supersession intended to survive removal of the superseding coupon?

- Examined: `specs/01` §5.3 (steps 5-6, winner selection and supersession
  reasons), §5.6 (the applied-coupon lifecycle and all three "Consequence"
  bullets), §5.7 worked example C, `src/lib/pricing/engine.ts:268-281`,
  `src/lib/cart.ts:117-124`, `src/app/api/cart/coupons/route.ts`,
  `shopping-cart-demo-spec.md` defect #9 (the defect that produced the §5.6
  prune rule).
- Found: §5.6 states the consequence explicitly and argues it is acceptable. The
  argument given is entirely about the eviction instant. Defect #9's resolution
  text — "`Cart.coupons` holds exactly what applied last pass; everything else is
  pruned" — shows the prune rule was chosen to make four situations behave
  uniformly (stopped qualifying, superseded, deleted, deactivated), so the
  destructiveness is deliberate and not an oversight.
- Not found: any spec text addressing the apply-then-remove sequence, or any
  acceptance criterion covering it. `specs/01` AC 9 covers pruning by quantity
  change; nothing covers pruning by supersession followed by removal.
- Conclusion: tagged `(needs human input)`. The prune rule's destructiveness is
  clearly intentional; whether its interaction with removal was considered is not
  recoverable from the repository. This is a product decision about acceptable
  shopper experience.
