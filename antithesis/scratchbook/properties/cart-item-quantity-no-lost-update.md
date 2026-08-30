# cart-item-quantity-no-lost-update

## What led here

`specs/01` §7.2 describes `POST /api/cart/items` as "Upserts quantity." The
implementation is not an upsert — it is a read, a branch, and a write, with the
new quantity computed in application code from the value it read.

## Code paths

**`src/app/api/cart/items/route.ts:18-49`** — `POST`:

```
23   const product = await prisma.product.findUnique({ where: { id: productId } })
26   const cartId = await resolveCartId()
27   const existing = await prisma.cartItem.findUnique({
28     where: { cartId_productId: { cartId, productId } },
29   })
31   if (existing) {
33     await prisma.cartItem.update({
34       where: { id: existing.id },
35       data: { quantity: existing.quantity + quantity },   // <-- computed from a stale read
36     })
37   } else {
38     await prisma.cartItem.create({ ... })                 // <-- see cart-item-create-no-unique-violation
     }
```

Line 35 is the lost-update site. Prisma supports `{ quantity: { increment: n } }`
and `prisma.cartItem.upsert(...)`; neither is used.

`PATCH` ([items/route.ts:52-70](../../../src/app/api/cart/items/route.ts#L52-L70))
sets an absolute quantity, so it is last-writer-wins by design — not a lost
update in the same sense, though it can still clobber a concurrent `POST`.

## Failure scenario

Cart contains 1 × product P. Two `POST /api/cart/items {productId: P, quantity: 1}`
arrive concurrently.

| t | Request A | Request B |
|---|---|---|
| 1 | `findUnique` → `{id: X, quantity: 1}` | |
| 2 | | `findUnique` → `{id: X, quantity: 1}` |
| 3 | `update({quantity: 2})` | |
| 4 | | `update({quantity: 2})` |
| 5 | responds 200, cart shows 2 | responds 200, cart shows 2 |

Both requests were acknowledged. The shopper asked for 3 total and has 2. Neither
response indicates anything went wrong — both show a plausible number, which is
what makes this class of bug survive manual testing.

## How it is reached in practice

The client-side `busy` guards are per-component, not per-cart:

- `AddToCartButton` holds its own `busy` state
  ([AddToCartButton.tsx:22](../../../src/components/AddToCartButton.tsx#L22)).
  A product card and a recommendation card for the same product are two separate
  component instances with two separate flags.
- The cart page's `run()` sets a single `busy` for the page
  ([cart/page.tsx:48-50](../../../src/app/cart/page.tsx#L48-L50)), but that does
  not coordinate with the catalog page, another tab, or the undo action in a
  toast ([cart/page.tsx:200-207](../../../src/app/cart/page.tsx#L200-L207)).

So a shopper adding the same item from the recommendation strip and the cart's
undo action, or from two tabs, reaches this without any unusual behavior.

## What goes wrong

An acknowledged mutation is silently discarded. Distinct from
`cart-item-create-no-unique-violation` (the `else` branch of the same `if`),
which fails loudly with a 500 instead.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the `Always` assertion comparing the workload's
  running acked-quantity total to the observed quantity. No SUT changes needed.
- **Missing, SUT-side (optional):** an assertion at
  [items/route.ts:35](../../../src/app/api/cart/items/route.ts#L35) recording the
  read quantity and the written quantity, to distinguish "the update was lost"
  from "the update never happened."

## Scope decision (2026-08-01): demoted to P2

The user confirmed multi-shopper access is out of scope. The property survives on
the "How it is reached in practice" section above, which was written from
single-shopper mechanisms and needs no revision: the client's `busy` guards are
**per component, not per cart**, so a product card, a recommendation card for the
same product, and the cart page's toast Undo are three independent instances that
can be in flight together. Two browser tabs sharing the cookie is a fourth path.

What is lost is the wide trigger — arbitrary overlapping requests from separate
shoppers — and with it the high hit rate. P2 reflects that: still a real defect
class, no longer a priority target.

Note the documented-semantics divergence is unaffected by scope. `specs/01` §7.2
describes this endpoint as "upserts quantity" and the implementation is a
non-atomic read-modify-write with no `upsert` and no `{increment: n}`. That gap
exists regardless of how many shoppers there are, and it is why the property is
demoted rather than dropped.

The assertion itself is unchanged.

## Open questions

None. The mechanism is unambiguous from the code, the endpoint's documented
semantics ("upserts") are stated in `specs/01` §7.2, and the divergence between
the two needs no external information to establish.
