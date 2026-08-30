# applying-coupon-never-raises-total

## What led here

`shopping-cart-demo-spec.md`'s defect table, entry #3:

> "Any exclusive coupon won unconditionally, so a shopper entering a valid code
> could **pay $8.10 more** on the spec's own seed data — and the acceptance
> criteria certified it."

The fix was to evaluate N+1 candidate coupon sets and take the lowest total.
`specs/01` §5.3 states the resulting guarantee: "Evaluating each candidate set and
taking the lowest total means the shopper is never penalised."

That is claim S5 in `sut-analysis.md` §5 — a claimed guarantee, and therefore a
property to test rather than a fact to record.

## Code paths

**`src/lib/pricing/engine.ts:240-295`** — `priceCart`:

```
258   const stackables = eligible.filter((c) => c.stackable)
259   const exclusives = eligible.filter((c) => !c.stackable)
260   const candidateSets = [stackables, ...exclusives.map((c) => [c])]

262   let winner = priceWithCouponSet(items, candidateSets[0], config)
263   for (const set of candidateSets.slice(1)) {
264     const candidate = priceWithCouponSet(items, set, config)
265     if (isBetter(candidate, winner)) winner = candidate
266   }
```

`candidateSets[0]` is the all-stackables set, which doubles as the no-coupon
baseline when empty ([engine.ts:256-257](../../../src/lib/pricing/engine.ts#L256-L257)
comment says so explicitly).

**`src/lib/pricing/engine.ts:228-238`** — `isBetter`: lowest `totalCents`, then
fewest `candidateCodes`, then lexicographically smallest sorted code list.

**The apply path:** `POST /api/cart/coupons`
([coupons/route.ts:15-23](../../../src/app/api/cart/coupons/route.ts#L15-L23))
uppercases the code and passes it as `applyingCode` to `priceAndPrune`, which
adds it to the candidate set ([cart.ts:96](../../../src/lib/cart.ts#L96)) — it
does not persist it unless it lands in the winning set.

## The property, stated carefully

For a **fixed set of cart items**, `total(cart + coupon C) <= total(cart)`.

The precondition matters. The guarantee is about the engine's choice among
candidate sets given one set of items. It is not a claim that the total never
rises — a quantity increase raises it legitimately. So the workload must
serialize its own operations against a given cart while performing this check:
capture the total, apply, compare, with nothing else in flight for that cart.

## Where a violation could come from

The pure engine is well covered here — `engine.test.ts` encodes worked example C
verbatim and both directions of the exclusive/stackable contest. So the
interesting failures are at the boundary, not in the arithmetic:

1. **Candidate set construction from stale coupon rows.** `priceAndPrune` reads
   coupon rows at [cart.ts:98-100](../../../src/lib/cart.ts#L98-L100) for exactly
   the codes in `held ∪ {applyingCode}`. If a concurrent admin `PATCH` changed a
   held coupon's `value`, `stackable`, or `minSubtotalCents` between the shopper's
   two observations, the "fixed items" precondition holds but the coupon set
   changed underneath. Whether that counts as a violation is a definitional
   question the workload resolves by not mutating coupons during this check —
   but Antithesis will do it anyway on other timelines, so the assertion needs
   the guard.
2. **Threshold crossings.** `shippingBaseFor` tests the *pre-discount* subtotal
   against `freeShippingThresholdCents`
   ([engine.ts:30-32](../../../src/lib/pricing/engine.ts#L30-L32)), and
   `minSubtotalCents` gates on the same pre-discount subtotal
   ([engine.ts:87](../../../src/lib/pricing/engine.ts#L87)). A concurrent quantity
   change moving the cart across either boundary between the two observations
   breaks the precondition.
3. **The `isBetter` tie-break.** `candidateCodes` is
   `coupons.map((c) => c.code)` ([engine.ts:219](../../../src/lib/pricing/engine.ts#L219))
   — every code *handed to* the pass, including ones that produced no discount
   line. So the "fewest coupons" tie-break counts candidates, not applications.
   A three-coupon stackable set where only one applies loses a tie to a single
   exclusive that also applies one. On a tie the totals are equal by definition,
   so this cannot violate the `<=` property directly — but it can change which
   set is persisted, which changes what a *subsequent* removal restores. Recorded
   here because it is the same code; see `coupon-removal-is-reversible`.

## What goes wrong

The original defect, restored: a shopper enters a valid code and their total goes
up. `specs/01` §5.3 calls this out as the thing the redesign exists to prevent,
and notes the original acceptance criteria certified the broken behavior — which
is a useful reminder that a passing test suite already failed to catch this once.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** capture `totalCents`, `POST` the coupon, assert
  `newTotal <= oldTotal`. Requires per-cart serialization in the workload.
- **Missing, SUT-side (valuable):** an assertion inside the winner loop at
  [engine.ts:265](../../../src/lib/pricing/engine.ts#L265) recording each
  candidate set's total alongside the winner's. The N+1 comparison is entirely
  internal — the response shows only the winner, so from outside there is no way
  to tell "the best set won" from "only one set was ever considered." This is the
  clearest case in the catalog for SUT-side instrumentation.

## Scope decision (2026-08-01): unchanged priority, precondition simplified

The user confirmed multi-shopper access is out of scope. This property is
unaffected in substance — it was always a single-shopper sequence (observe total,
apply code, compare) — and the scope decision makes its precondition easier to
guarantee rather than harder.

"No other operation touched that cart" now follows from the workload running one
shopper per cart, which it must do anyway. The only remaining threat to the
precondition is an **admin** coupon edit landing between the two observations,
which is a separate question and remains open below.

Threat 2 in the list above (a concurrent quantity change crossing
`minSubtotalCents` or the free-shipping threshold) is retired: with one shopper per
cart and the workload controlling its own request ordering, no quantity change can
land between the two observations.

## Open questions

- **Does an admin coupon edit landing between the two observations void the
  guarantee or violate it?** The workload can serialize its own operations, but
  Antithesis will generate timelines where an admin `PATCH` changes a candidate's
  `value`, `stackable`, or `minSubtotalCents` mid-comparison — and admin-vs-shopper
  concurrency is explicitly still in scope. If the SUT is expected to hold the
  comparison regardless, it needs a snapshot mechanism the code does not have. If
  the guarantee is scoped to a stable coupon definition, the workload must freeze
  admin coupon writes for the duration of the check, which constrains workload
  design. `(partial: the shopper-concurrency half is resolved by the scope
  decision; only the admin-edit case remains)`

### Investigation Log

#### Under concurrency, is the property still well-defined?

- Examined: `src/lib/pricing/engine.ts` (`priceCart`, `filterEligible`,
  `isBetter`), `src/lib/cart.ts:85-132` (`priceAndPrune`, coupon row loading),
  `specs/01` §5.3 (the guarantee's own statement and its "why N+1 passes"
  rationale), `specs/02` §5 (admin coupon mutation and its interaction with the
  prune rule).
- Found: `specs/01` §5.3 states the guarantee in terms of a single pricing call —
  "evaluating each candidate set and taking the lowest total" — which is
  unambiguous *within* one `priceCart` invocation and says nothing about two
  invocations separated in time. The workload-serialization half is resolvable:
  the workload owns its own request ordering per cart, so the "fixed items"
  precondition is enforceable.
- Not found: any spec text addressing what the guarantee means when the coupon
  definitions themselves change between passes. `specs/02` §5 addresses coupon
  deletion (deferring to §5.6's prune) but not coupon *edits* during an active
  shopping session.
- Conclusion: tagged `(partial: ...)`. The workload-side half is settled — the
  workload serializes per cart. The remaining open part is whether admin coupon
  edits mid-comparison void the guarantee or violate it, which the specs do not
  address.

**Second pass, 2026-08-01 (after the user's scope decision):**

- Answered by the user: multi-shopper access is not in scope, so one shopper per
  cart is now a property of the deployment rather than a workload convention.
- Effect: the shopper-concurrency half of the question is fully resolved — a
  concurrent quantity change from another shopper can no longer break the
  precondition, and the workload's own serialization covers the rest.
- Unchanged: the admin-edit case. `specs/02` §5 still addresses only coupon
  *deletion* mid-session (deferring to §5.6's prune), not coupon *edits*, and
  admin-vs-shopper concurrency remains in scope by the same decision.
- Conclusion: question narrowed and restated to the admin-edit case only; tag
  remains `(partial: ...)` with the resolved half named in the tag.
