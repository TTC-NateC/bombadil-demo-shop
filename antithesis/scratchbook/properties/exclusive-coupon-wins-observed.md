# exclusive-coupon-wins-observed

## What led here

Every property in category B that touches coupon selection depends on the
workload actually constructing carts where the exclusive branch of the N+1
comparison wins. If it never does, those properties pass vacuously and the run
report looks clean for the wrong reason.

This marker exists to make that distinction visible.

## Code paths

**`src/lib/pricing/engine.ts:256-266`:**

```
256   // Candidate sets: all stackables together, plus each non-stackable alone.
257   // An empty stackable set doubles as the "no coupons" baseline.
258   const stackables = eligible.filter((c) => c.stackable)
259   const exclusives = eligible.filter((c) => !c.stackable)
260   const candidateSets: EngineCoupon[][] = [stackables, ...exclusives.map((c) => [c])]

262   let winner = priceWithCouponSet(items, candidateSets[0], config)
263   for (const set of candidateSets.slice(1)) {
264     const candidate = priceWithCouponSet(items, set, config)
265     if (isBetter(candidate, winner)) winner = candidate
266   }
```

**The observable signature — `src/lib/pricing/engine.ts:268-281`:** when an
exclusive wins, every eligible stackable is added to `rejectedCoupons` with
`REASONS.supersededByExclusive(winner.candidateCodes[0])`. So the response shows:

- exactly one code in `discountLines`, and
- one or more `rejectedCoupons` entries naming that code as the reason.

The workload knows which seeded codes are non-stackable (it created or read them
via `GET /api/coupons`), so it can confirm the winner was an exclusive rather
than a lone stackable.

## Why this branch is hard to reach by accident

`specs/01` §5.7 worked example C is deliberately constructed as the case where
the exclusive **loses**: at subtotal 5000, `SAVE10 + TAKE15` beat `VIP25`. A
workload that adds a few seeded items and applies the seeded codes will most
often land in the losing case, because that is the case the seed data was
designed to demonstrate.

Reaching the winning case requires the workload to build a cart where 25% capped
at 3000 beats 10% plus $15 — which means driving the subtotal into a specific
band. The workload has to understand the coupon set well enough to do that
deliberately. This marker confirms it did.

## Assertion design

`Reachable("exclusive coupon set won the N+1 selection")`.

`Reachable` rather than `Sometimes`: there is no additional semantic condition
worth encoding beyond "we got here." `references/property-catalog.md` is explicit
that `Sometimes(true, ...)` is a smell that should be `Reachable`, and dressing
this up with a trivially-true condition would be exactly that.

The counterpart case — an exclusive that *loses* — is already covered
deterministically by `engine.test.ts`'s worked example C, so it needs no marker.

## Detection

From the workload, on any cart response:

- `discountLines` contains exactly one code, and
- that code is one the workload knows is non-stackable, and
- `rejectedCoupons` is non-empty (or was, on the apply that produced this state).

## Note on `isBetter`'s tie-break

`isBetter` breaks total-ties on `candidateCodes.length`, which counts codes
*handed to* the pass rather than codes that applied
([engine.ts:219](../../../src/lib/pricing/engine.ts#L219),
[engine.ts:232](../../../src/lib/pricing/engine.ts#L232)). On a tie, a
three-coupon stackable set where only one applies loses to a single exclusive
that also applies one.

This does not affect the marker — a tie still produces an exclusive winner, which
is what the marker records. It affects `coupon-removal-is-reversible`, where the
identity of the persisted set determines what a later removal falls back to. Noted
here because a reader tracing `isBetter` will arrive at this file first.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the `Reachable` marker, fired on detecting the
  signature above.
- **Missing, SUT-side (strictly better):** a `Reachable` inside the winner loop
  at [engine.ts:265](../../../src/lib/pricing/engine.ts#L265) firing when the
  winner changes to an exclusive set. The N+1 comparison is entirely internal —
  the response shows only the winner, so from outside there is no way to
  distinguish "the exclusive beat three other candidate sets" from "only one
  candidate set existed." Shares its rationale with the SUT-side note in
  `applying-coupon-never-raises-total.md`; one instrumentation point serves both.

## Open questions

None. This is a reachability marker with a directly observable signature and no
uncertain claims.
