# coupon-mutation-leaves-cart-consistent

## What led here

`specs/02` §5 makes a claim in one sentence and defers the whole problem to
another spec:

> "A cart holding a deleted or deactivated code drops it on the next pricing pass
> — this is just slice 1 §5.6's prune rule, which needs no special case for
> deletion."

The claim is that one mechanism handles four distinct situations uniformly. That
is a strong, testable assertion about a mechanism that runs without a transaction
while an admin is mutating the rows it reads.

## Code paths

**The read the claim depends on — `src/lib/cart.ts:95-100`:**

```
95   const held: string[] = JSON.parse(cart.coupons)
96   const candidateCodes = Array.from(new Set([...held, ...(applyingCode ? [applyingCode] : [])]))
98   const couponRows = candidateCodes.length
99     ? await prisma.coupon.findMany({ where: { code: { in: candidateCodes } } })
100    : []
```

A held code whose row no longer exists simply produces no row, so it cannot
appear in `discountLines`, so the prune drops it. That much is sound by
construction.

**Where deactivation is handled — `src/lib/pricing/engine.ts:75-78`:**

```
75   if (!coupon.active) {
76     reject(coupon.code, REASONS.notActive(coupon.code))
77     continue
78   }
```

Note what this does: an inactive held coupon produces a `rejectedCoupons` entry.
`priceAndPrune` then filters that list down to the code currently being applied
([cart.ts:126](../../../src/lib/cart.ts#L126)):

```
126  let rejectedCoupons = priced.rejectedCoupons.filter((r) => r.couponCode === applyingCode)
```

On a `GET` or a quantity change, `applyingCode` is `undefined`, so the filter
yields an empty array. That is the mechanism that makes `specs/03` §4.1's toast
design safe, and it is the thing this property checks holds under mutation.

**Admin mutation paths:**

- `DELETE /api/coupons/[id]` — [route.ts:43-53](../../../src/app/api/coupons/[id]/route.ts#L43-L53)
- `PATCH /api/coupons/[id]` — [route.ts:10-35](../../../src/app/api/coupons/[id]/route.ts#L10-L35), can set `active: false`, change `value`, `stackable`, `minSubtotalCents`, `startsAt`, `endsAt`
- `DELETE /api/coupons?all=true` — [coupons/route.ts:38-41](../../../src/app/api/coupons/route.ts#L38-L41)

**The clock dependency — `src/lib/pricing/engine.ts:79-86, 242`:**

```
242  const now = input.now ?? new Date()
...
79   if (coupon.startsAt && now < coupon.startsAt) { reject(...notYetAvailable...) }
83   if (coupon.endsAt && now > coupon.endsAt)     { reject(...expired...) }
```

`now` is injected for testability but defaults to wall-clock time in production.
This is the only clock dependency anywhere in the SUT, which makes clock-jitter
faults surgical: they can flip a coupon's eligibility mid-session and affect
nothing else.

## Failure scenarios

**A — deletion mid-session:** shopper holds `SAVE10`. Admin deletes it. The
shopper's next request: `findMany` returns no row for `SAVE10`, it produces no
discount line, the prune writes `[]`, the chip disappears, the total rises. This
should be silent — `rejectedCoupons` must be empty because `applyingCode` is
undefined.

**B — deactivation mid-session:** same, except the row still exists with
`active: false`, so `filterEligible` pushes a `notActive` rejection into
`priced.rejectedCoupons`. The filter at line 126 must remove it. If a future
change to that filter — or a request where `applyingCode` happens to equal the
deactivated code — lets it through, the UI fires
`Coupon SAVE10 not applied: ...` ([cart/page.tsx:67-72](../../../src/app/cart/page.tsx#L67-L72))
on a quantity click the shopper made for unrelated reasons.

**C — clock jump expires a held coupon:** `endsAt` passes because the clock
jumped, not because time elapsed. Same shape as B. **[needs clock-jitter]**

**D — the value changes underneath a comparison:** admin `PATCH`es `value` while
the shopper is mid-apply. Interacts with `applying-coupon-never-raises-total`'s
open question.

## What goes wrong

The sharp failure is a spurious warning toast. `specs/03` §4.1 is an entire
section written to prevent exactly this, and `specs/03` AC 6 tests it — but only
for the single-threaded quantity-change case, with no admin mutation and no
concurrency.

The softer failure is an invariant break: a `discountLine` for a coupon that no
longer justifies it, or totals that don't reconcile after the prune.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** `Always(rejectedCoupons.length === 0)` on every
  response to a request that was not a `POST /api/cart/coupons`. This is the
  sharpest single check in the category and needs no extra requests. Shared with
  `persisted-coupons-match-discount-lines`.
- **Missing, workload-side:** the seven §5.2 invariant assertions (shared with
  `priced-cart-invariants-hold`) applied to responses observed during admin
  coupon mutation.
- **Missing, SUT-side (optional):** an assertion at
  [cart.ts:126](../../../src/lib/cart.ts#L126) recording how many rejections were
  filtered out and why, which would distinguish "no rejections were produced"
  from "rejections were produced and correctly suppressed" — indistinguishable
  from the response.

## Open questions

None. The prune mechanism, the rejection filter, and the clock dependency are all
directly readable; `specs/02` §5 and `specs/03` §4.1 state the guarantees being
tested; and the fault types needed (clock jitter for variant C) are recorded as a
catalog-level question rather than a property-level one.
