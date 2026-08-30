# persisted-coupons-match-discount-lines

## What led here

`specs/01` §5.6 opens with an exact equality, in bold in the source:

> "`Cart.coupons` holds **exactly the codes that applied on the last pricing
> pass** — nothing else."

`specs/03` §4.1 then builds the entire toast design on it, and says so directly:

> "Slice 1 §5.6 makes this safe by construction: `rejectedCoupons` means exactly
> one thing... So there is no population of 'coupons I still hold but that didn't
> apply this pass' to accidentally toast about on every quantity tweak."

That is claim S6 plus S7 in `sut-analysis.md` §5. Two specs depend on the
equality; one function maintains it; that function is not transactional.

## Code paths

**The maintaining code — `src/lib/cart.ts:117-124`:**

```
117   // Prune: Cart.coupons holds exactly what applied on this pass, nothing else.
118   const applied = appliedCodes(priced)
119   if (JSON.stringify(applied) !== cart.coupons) {
120     await prisma.cart.update({
121       where: { id: cartId },
122       data: { coupons: JSON.stringify(applied) },
123     })
124   }
```

**`appliedCodes` — `src/lib/pricing/engine.ts:298-300`:**

```
export function appliedCodes(priced: PricedCart): string[] {
  return priced.discountLines.map((line) => line.couponCode)
}
```

So the persisted set is derived from `discountLines` by construction, and the
equality holds *within* a single pass, unconditionally. The property is about
whether it survives across passes.

**The second writer — `src/app/api/cart/coupons/route.ts:26-41` (`DELETE`):**

```
32   const cart = await prisma.cart.findUniqueOrThrow({ where: { id: cartId } })
34   const held: string[] = JSON.parse(cart.coupons)
35   await prisma.cart.update({
36     where: { id: cartId },
37     data: { coupons: JSON.stringify(held.filter((c) => c !== code)) },
38   })
40   return NextResponse.json(await priceAndPrune(cartId))
```

This is a second, independent read-modify-write on the same column, performed
*before* `priceAndPrune` does its own. A single coupon removal therefore issues
two unsynchronized writes. `priceAndPrune`'s doc comment describes itself as "the
one load -> price -> prune -> persist sequence" — this route writes the column
outside that sequence.

## Scope decision (2026-08-01): unchanged priority

The user confirmed multi-shopper access is out of scope. This property keeps P0,
because its sharpest mechanism needs **no concurrency at all**.

`DELETE /api/cart/coupons` performs two unsynchronized writes to `Cart.coupons`
within a *single request*: it filters and writes the held list at
[coupons/route.ts:35-38](../../../src/app/api/cart/coupons/route.ts#L35-L38), then
calls `priceAndPrune`, which reads the column back and may write it again. One
shopper, one click, two writers of the same column — and `priceAndPrune`'s doc
comment claims to be "the one load -> price -> prune -> persist sequence," which
this route bypasses on its first write.

The concurrent interleaving table below is retained because admin coupon
mutations concurrent with one shopper remain in scope, and because the two-GET
detection method is unchanged. What the scope decision removes is only the
two-shopper variant, which was never this property's primary evidence.

## Failure scenario

The equality breaks when a pass persists a set computed from a stale read while a
concurrent pass persists a different one. Concretely, with an apply and a remove
overlapping — note this is reachable single-shopper via the toast Undo callback,
which runs outside the cart page's `busy` guard:

| t | `POST /api/cart/coupons` (apply SAVE10) | `DELETE /api/cart/coupons?code=TAKE15` |
|---|---|---|
| 1 | | `findUniqueOrThrow` → `coupons: '["TAKE15"]'` |
| 2 | `findUnique` → `coupons: '["TAKE15"]'` | |
| 3 | prices with `{TAKE15, SAVE10}`, both apply | |
| 4 | `update({coupons: '["SAVE10","TAKE15"]'})` | |
| 5 | responds 200 with both discount lines | |
| 6 | | `update({coupons: '[]'})` — filtered from its stale read |
| 7 | | `priceAndPrune` re-reads `'[]'`, prices with no coupons, `applied = []`, no write |
| 8 | | responds 200 with no discount lines |

Final state: `Cart.coupons = '[]'`. SAVE10 was acknowledged at step 5 and is gone.
The shopper removed one coupon and lost two.

The reverse ordering leaves `Cart.coupons` containing a code that produced no
discount line on the last pass — the direct negation of the §5.6 equality.

## Detection from the workload

`Cart.coupons` is not in the API shape (`PricedCart` in
[types.ts:101-122](../../../src/lib/pricing/types.ts#L101-L122) has no
applied-coupons field — §5.6 says so deliberately, since the UI reads
`discountLines`). So the workload checks the observable consequence:

Issue `GET /api/cart` twice with nothing in between. Both passes read the same
items and the same persisted coupon set, so both must produce identical
`discountLines` code sets. If they differ, the first pass persisted something
other than what it applied, and the second pass corrected it — which is exactly
the equality failing.

This is weaker than reading the column directly: it catches divergence that
*self-corrects on the next pass*, but not a divergence that is stable across
passes. See the open question.

## What goes wrong

`specs/03` AC 6 requires that a quantity change which prunes a coupon fires **no**
toast. The UI implements that by only reading `rejectedCoupons` when it explicitly
applied a code
([cart/page.tsx:61-82](../../../src/app/cart/page.tsx#L61-L82)) — which is safe.
The failure this property catches is the other direction: a coupon chip appearing
for a discount the shopper is not receiving, or vanishing without the total
changing to match, because the persisted set and the applied set disagree.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the two-GET comparison as an `Always` assertion.
- **Missing, workload-side (cheap and strictly stronger):** on every cart
  response, assert `rejectedCoupons` is empty unless the request was a
  `POST /api/cart/coupons`. `specs/03` §4.1 states this as the field's entire
  meaning, and it needs no second request. Shared with
  `coupon-mutation-leaves-cart-consistent`.
- **Missing, SUT-side (would make the property exact):** an assertion at
  [cart.ts:118](../../../src/lib/cart.ts#L118) comparing the freshly-read
  `cart.coupons` against `applied`, firing when they diverge for a reason other
  than this pass's own prune. This is the only way to observe a *stable*
  divergence.

## Open questions

- **Is there a stronger, directly observable check than the two-GET comparison —
  e.g. an admin or debug endpoint exposing `Cart.coupons`?** The two-GET check
  detects self-correcting divergence only. A divergence that persists across
  passes — for instance a code stuck in `Cart.coupons` that never applies —
  produces identical `discountLines` on both GETs and is invisible. If a debug
  read of the column existed, the property would become an exact equality check on
  every response, which is materially stronger.

### Investigation Log

#### Is there a stronger, directly observable check than the two-GET comparison?

- Examined: `src/lib/pricing/types.ts` (`PricedCart` shape), all six cart route
  handlers, `src/app/api/coupons/**` (admin coupon endpoints), `specs/01` §5.6 and
  §7.2, `specs/02` §5 (admin coupon API surface).
- Found: `PricedCart` has no applied-coupon field, and `specs/01` §5.6 states this
  is deliberate — "the UI can render applied-coupon chips directly from
  `discountLines`... `PricedCart` needs no separate applied-coupons field." No
  admin endpoint exposes carts at all: `/api/coupons` returns coupon definitions,
  not cart state. There is no route under `/api/carts`.
- Not found: any existing mechanism to read `Cart.coupons` over HTTP. Confirmed by
  enumerating every file under `src/app/api/`.
- Conclusion: tagged `(partial: ...)`. Settled that no such endpoint exists at
  this commit, so the two-GET comparison is the strongest workload-only check
  available. The remaining open part is whether adding a debug read is acceptable
  SUT-side instrumentation for this project — a decision for whoever owns the
  code, since it means adding a route that exposes cart internals.
