# coupon-prune-path-observed

## What led here

The prune is §5.6's central mechanism and the precondition for several category B
properties to mean anything. It is also silent by design — nothing in the
response says "a coupon was pruned," only that a chip is gone. So a run in which
it never fired is indistinguishable from a run in which it fired correctly,
unless something records it.

## Code paths

**The prune — `src/lib/cart.ts:117-124`:**

```
117   // Prune: Cart.coupons holds exactly what applied on this pass, nothing else.
118   const applied = appliedCodes(priced)
119   if (JSON.stringify(applied) !== cart.coupons) {
120     await prisma.cart.update({ where: { id: cartId },
121                                data: { coupons: JSON.stringify(applied) } })
122   }
```

**Why it is silent — `src/lib/cart.ts:126`:**

```
126   let rejectedCoupons = priced.rejectedCoupons.filter((r) => r.couponCode === applyingCode)
```

On a quantity change `applyingCode` is `undefined`, so every rejection the engine
produced — including the one explaining why the coupon stopped applying — is
filtered out. `specs/03` §4.1 states the intent: "When pruning removes a coupon as
a side effect of a quantity change, the chip simply disappears and the breakdown
updates. Do not toast for it."

**The two boundaries a workload can cross to trigger it:**

- `minSubtotalCents` — [engine.ts:87](../../../src/lib/pricing/engine.ts#L87),
  gating on the **pre-discount** subtotal. Seeded `TAKE15` has
  `minSubtotalCents: 5000` (`specs/01` §9).
- `freeShippingThresholdCents` —
  [engine.ts:30-32](../../../src/lib/pricing/engine.ts#L30-L32), also on the
  pre-discount subtotal. Crossing it upward makes shipping free, which causes a
  held `FREESHIP` to be rejected with `shippingAlreadyFree`
  ([engine.ts:95-98](../../../src/lib/pricing/engine.ts#L95-L98)) and pruned. That
  is the counterintuitive direction and worth exercising: adding items removes a
  coupon.

## Why the marker matters

Three properties depend on the prune having actually run:

- `persisted-coupons-match-discount-lines` — its whole subject is what the prune
  persists.
- `coupon-removal-is-reversible` — supersession-driven pruning is the mechanism
  that makes removal lossy.
- `coupon-mutation-leaves-cart-consistent` — the prune is what `specs/02` §5
  claims handles deletion "with no special case."

If the prune never fires, all three pass without testing anything. `specs/01`
AC 9 and `specs/03` AC 6 both hinge on it as well.

## Assertion design

`Reachable("coupon pruned by a non-coupon cart mutation")`.

`Reachable` for the same reason as `exclusive-coupon-wins-observed`: it is a
pure "did we get here" marker with no further condition worth encoding.

The qualifier "by a non-coupon cart mutation" is load-bearing. A coupon
disappearing after `DELETE /api/cart/coupons` is not the prune path — it is the
explicit-removal path, which is trivially reachable and uninteresting. The
interesting event is a coupon vanishing as a *side effect* of something the
shopper did for another reason.

## Detection

From the workload, across two consecutive observations of the same cart with a
quantity mutation between them:

- code C is in `discountLines` before,
- C is absent from `discountLines` after,
- the intervening request was `POST`/`PATCH`/`DELETE /api/cart/items` (not a
  coupon route),
- `rejectedCoupons` on the after-response is empty.

That last condition doubles as a check: if it is *not* empty, the workload has
found a violation of `coupon-mutation-leaves-cart-consistent`, because
`specs/03` §4.1 requires the prune to be silent.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the `Reachable` marker, fired on the signature
  above.
- **Missing, SUT-side (valuable):** a `Reachable` at
  [cart.ts:119](../../../src/lib/cart.ts#L119) inside the `if`, firing when the
  compare-and-write actually executes and carrying the before/after code sets.
  This is the same instrumentation point `cart-coupon-set-atomic.md` asks for, and
  one marker serves both: for that property it identifies the lost-update branch,
  for this one it confirms the prune path executed. It also distinguishes "pruned
  because it stopped qualifying" from "pruned because it was superseded" — two
  cases the response cannot tell apart.

## Open questions

None. The mechanism, its silence, and both trigger boundaries are directly
readable in the engine and the cart module.
