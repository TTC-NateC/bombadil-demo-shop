# cart-coupon-set-atomic

## What led here

Focus 2 (state management) and Focus 3 (concurrency) converged on the same
function. `priceAndPrune` is described in its own doc comment as "the one load ->
price -> prune -> persist sequence. Every cart route goes through here; a route
that skipped the prune would be a silent bug with no failing test anywhere else."

That comment establishes it as the single funnel for coupon state. It does not
mention that the sequence is a read-modify-write with no transaction.

## Code paths

**`src/lib/cart.ts:85-132`** — `priceAndPrune(cartId, applyingCode?)`:

```
89   const cart = await prisma.cart.findUnique({ ... include items ... })   // READ
95   const held: string[] = JSON.parse(cart.coupons)                        // read state
98   const couponRows = await prisma.coupon.findMany({ ... })               // READ
111  const priced = priceCart({ items, coupons, config })                   // pure
118  const applied = appliedCodes(priced)
119  if (JSON.stringify(applied) !== cart.coupons)                          // compare to STALE read
120    await prisma.cart.update({ where: { id: cartId },                    // WRITE
                                 data: { coupons: JSON.stringify(applied) } })
```

Line 119 compares against `cart.coupons` as read at line 89. Between line 89 and
line 120 there are at least two `await` boundaries where another request's
continuation can run to completion.

**Second writer:** `src/app/api/cart/coupons/route.ts:32-38` (`DELETE`) reads
`cart.coupons`, filters the code out, and writes it directly — *before* calling
`priceAndPrune`, which then reads it back and may write it again. So a single
coupon-removal request performs two separate unsynchronized writes to the same
column.

**Callers of `priceAndPrune`** (every one of them can be concurrent with any
other, for the same cart):

- `GET /api/cart` — `src/app/api/cart/route.ts:7`
- `POST /PATCH /DELETE /api/cart/items` — `src/app/api/cart/items/route.ts:48, 69, 84`
- `POST /DELETE /api/cart/coupons` — `src/app/api/cart/coupons/route.ts:22, 40`

## Failure scenario

Two requests, same cart:

| t | Request 1 (`POST /api/cart/coupons` code=SAVE10) | Request 2 (`GET /api/cart` from `CartBadge`) |
|---|---|---|
| 1 | `findUnique` → `coupons: "[]"` | |
| 2 | | `findUnique` → `coupons: "[]"` |
| 3 | prices with SAVE10 in the candidate set, `applied = ["SAVE10"]` | |
| 4 | `update({coupons: '["SAVE10"]'})` | |
| 5 | responds 200, `discountLines: [SAVE10]`, `rejectedCoupons: []` | |
| 6 | | prices with `held = []`, `applied = []` |
| 7 | | `'[]' !== '[]'` is false — **no write**, so nothing is clobbered here |

That interleaving is benign. The damaging one reverses steps 6-7 by having
request 2 be a *mutation* whose applied set differs from its stale read:

| t | Request 1 (`POST /api/cart/coupons` code=SAVE10) | Request 2 (`PATCH /api/cart/items` quantity change) |
|---|---|---|
| 1 | | `findUnique` → `coupons: '["TAKE15"]'` |
| 2 | `findUnique` → `coupons: '["TAKE15"]'` | |
| 3 | prices, `applied = ["SAVE10","TAKE15"]` | |
| 4 | `update({coupons: '["SAVE10","TAKE15"]'})` | |
| 5 | responds 200 showing both discounts | |
| 6 | | prices from its stale read, `applied = ["TAKE15"]` |
| 7 | | `'["TAKE15"]' !== '["TAKE15"]'` — false, no write |

Still benign, because the comparison is against the stale value. The write only
fires when the *stale* value differs from the newly-applied set — and that is
precisely when the newly-applied set was computed without knowledge of the
concurrent apply:

| t | Request 1 (`POST /api/cart/coupons` code=SAVE10) | Request 2 (`PATCH` quantity, dropping subtotal below TAKE15's min) |
|---|---|---|
| 1 | | `findUnique` → `coupons: '["TAKE15"]'`, items at old quantity |
| 2 | `findUnique` → `coupons: '["TAKE15"]'` | |
| 3 | prices, `applied = ["SAVE10","TAKE15"]` | |
| 4 | `update({coupons: '["SAVE10","TAKE15"]'})` | |
| 5 | responds 200 showing SAVE10 applied | |
| 6 | | prices from stale coupon read + its own item write: `applied = []` (TAKE15 no longer qualifies, SAVE10 unknown to it) |
| 7 | | `'[]' !== '["TAKE15"]'` → **writes `'[]'`** |

`Cart.coupons` is now `[]`. SAVE10 was acknowledged to the shopper at step 5 and
is gone. No `rejectedCoupons` entry is produced — §5.6's prune is silent by
design — so the UI shows the chip disappearing with no explanation.

## What goes wrong

Claim S6 (`sut-analysis.md` §5) is violated: `Cart.coupons` no longer holds what
applied on the last pass, because "the last pass" is ambiguous when two passes
overlap. The shopper loses a discount they were shown.

## Detection from the workload

The workload does not see `Cart.coupons` directly. It sees the consequence:
a code that appeared in `discountLines` on an acknowledged apply is absent from
the next `GET /api/cart` without any operation that should have removed it. The
workload must therefore track, per cart, which of its own operations could
legitimately drop a coupon (explicit delete, or a quantity change crossing
`minSubtotalCents` / the free-shipping threshold) so the assertion does not fire
on a legitimate prune.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**. The repo
has no Antithesis SDK.

- **Missing, workload-side:** the `Always` assertion described above. This is the
  primary check and needs no SUT changes.
- **Missing, SUT-side (valuable):** an assertion inside `priceAndPrune` at
  [cart.ts:119](../../../src/lib/cart.ts#L119) recording that a compare-and-write
  fired, with the stale value and the new value. This state is invisible from
  outside and is the exact branch that loses data. It would also serve as a
  replay anchor.
- **Missing, SUT-side (structural fix, not instrumentation):** wrapping lines
  89-124 in `prisma.$transaction` would close the window. Noted because a
  reviewer will ask; it is a fix, not a test.

## Scope decision (2026-08-01): demoted to P2

The user confirmed multi-shopper access is out of scope. That removes this
property's wide trigger — two shoppers on one cart — and leaves two narrow
single-shopper paths.

For the clobber to occur, a coupon apply must overlap an operation that computes a
*different* applied set from a stale read. Working through the interleavings in
the tables above: a stale `GET` alone cannot do it, because when `held` is
unchanged the comparison at [cart.ts:119](../../../src/lib/cart.ts#L119) is equal
and no write fires. It takes a **quantity change** overlapping an **apply**.

The cart page's `busy` flag ([cart/page.tsx:48-50](../../../src/app/cart/page.tsx#L48-L50))
disables its own buttons during a mutation, so the obvious single-shopper route is
closed. Two remain:

1. **The toast Undo callback.** `run()` is invoked from the toast action at
   [cart/page.tsx:200-207](../../../src/app/cart/page.tsx#L200-L207), which lives
   outside the coupon form's submit path. An Undo re-add firing while a coupon
   apply is in flight produces exactly the required overlap.
2. **Two browser tabs sharing the cookie.** One shopper, one session, two
   documents — each with its own independent `busy` state.

Both are real but narrow. P2 is the honest placement: worth asserting because the
mechanism is unguarded and the failure is silent (nothing else in the system would
report a lost coupon), but not worth search budget ahead of categories B, D and G.

The assertion itself is unchanged.

## Open questions

- None.

### Investigation Log

#### Is a lost coupon under concurrency a defect, or accepted for a single-shopper demo?

- Examined: `specs/01` §1 (non-goals), §5.6 (coupon lifecycle), §7.2 (cart API),
  §7.4 (cookie and cart lifetime), §12.1 (Playwright worker count);
  `playwright.config.ts:11-17`; `shopping-cart-demo-spec.md` defect table; all
  three slice specs' acceptance criteria.
- Found: `specs/01` §1 rules out accounts and shopper auth but says nothing about
  concurrent access. `specs/01` §12.1 and `playwright.config.ts` both acknowledge
  SQLite single-writer contention explicitly, and both address it by constraining
  the *test harness* (`workers: 1`), not the application. No spec section states
  an expected number of simultaneous users.
- Not found: any statement of the intended concurrency envelope for the served
  application. The ten reviewed defects in `shopping-cart-demo-spec.md` contain
  no concurrency defect, confirming it was not a review lens.
- Conclusion: tagged `(needs human input)`. The code and docs genuinely do not
  settle it — this is a product-scope decision, not a fact recoverable from the
  repository.

**Second pass, 2026-08-01 (after the user's scope decision):**

- Answered by the user: multi-shopper access is **not** in scope.
- Follow-up examined, to determine whether the property survives at all:
  `cart/page.tsx:48-50` (the page-level `busy` flag), `cart/page.tsx:226-237` (the
  coupon form's submit path), `cart/page.tsx:190-208` (the remove button and its
  toast Undo action), `AddToCartButton.tsx:22` (per-component `busy`),
  `cart-events.ts:14-25` (`mutateCart`, no client-side queueing), and the
  interleaving tables above.
- Found: the clobber needs an apply overlapping a quantity change. The page-level
  `busy` flag closes the direct route, but the toast Undo callback runs `run()`
  outside the form's guard, and nothing coordinates across browser tabs sharing
  the cookie. Both are single-shopper.
- Conclusion: question resolved and removed from the Open Questions list.
  Property retained at P2 with the narrow paths documented above, rather than
  deleted — the mechanism is still unguarded and the failure is still silent.
