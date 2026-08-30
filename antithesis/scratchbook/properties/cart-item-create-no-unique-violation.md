# cart-item-create-no-unique-violation

## What led here

The `else` branch of the same `if` that produces `cart-item-quantity-no-lost-update`.
Where that property covers the silent-wrong-answer branch, this one covers the
loud-crash branch. They are two outcomes of one unguarded check-then-act, and
which one you get depends on whether the row already existed.

## Code paths

**`src/app/api/cart/items/route.ts:27-46`**:

```
27   const existing = await prisma.cartItem.findUnique({
28     where: { cartId_productId: { cartId, productId } },
29   })
31   if (existing) { ...update... }
37   else {
38     await prisma.cartItem.create({
39       data: { cartId, productId, quantity, unitPriceCentsSnapshot: product.priceCents },
45     })
46   }
```

**`prisma/schema.prisma:86`** — `@@unique([cartId, productId])` on `CartItem`.

There is no `try`/`catch` in this file, or in any other cart route.

## Failure scenario

Cart does not yet contain product P. Two concurrent
`POST /api/cart/items {productId: P, quantity: 1}`:

| t | Request A | Request B |
|---|---|---|
| 1 | `findUnique` → `null` | |
| 2 | | `findUnique` → `null` |
| 3 | `create(...)` succeeds | |
| 4 | | `create(...)` → **P2002 unique constraint failed** |
| 5 | responds 200 | throws; Next returns an unstructured 500 |

## What goes wrong

Two things, and the second is worse than the first.

1. `specs/01` §7.3 enumerates the response codes this slice may return ("`200`
   ok, `400` validation, `404` unknown product/coupon") and `specs/02` §6 extends
   the list to 201/401/409/413/415. 500 is not in either list. The response body
   is Next's default HTML/JSON error page, not the documented
   `{ error: { message, code, details? } }` shape, so a client parsing the error
   shape gets nothing usable.
2. The client's only handling is
   `toast({variant: "warning", message: "Something went wrong — please try again"})`
   ([cart/page.tsx:52-54](../../../src/app/cart/page.tsx#L52-L54),
   [AddToCartButton.tsx:41](../../../src/components/AddToCartButton.tsx#L41)).
   The advertised recovery is to retry — and the retry now finds the row that
   request A created, taking the `if (existing)` branch, which is the
   lost-update path. The two failure modes feed each other.

## Note on P2003

The same route has a second constraint hazard on the same lines: `product` is
read at line 23 and the `CartItem` is created at line 38. A concurrent
`DELETE /api/products/[id]` or `DELETE /api/products?all=true` landing in between
makes the create violate `CartItem.product`'s foreign key (P2003), also
unhandled. That variant is cataloged separately as
`product-delete-cascades-cleanly` because its trigger is an admin operation
rather than shopper concurrency, but it surfaces through this same missing
`try`/`catch`.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** `Always(response.status < 500)` on every
  `/api/cart/items` response, with the observed status and method in the
  assertion message. Sufficient on its own — no SUT changes needed.
- **Missing, SUT-side:** none required. A `try`/`catch` converting P2002 into a
  retry-or-merge would be a fix, not instrumentation.

## Scope decision (2026-08-01): demoted to P2

The user confirmed multi-shopper access is out of scope. This property shares the
surviving single-shopper trigger described in
`cart-item-quantity-no-lost-update.md` — per-component `busy` flags — and is
narrower still, because it additionally requires the product to be **absent** from
the cart when both requests start. That is a first-add, so the two overlapping
requests must be the shopper's first two interactions with that product.

**Demoting this costs no detection coverage.** The assertion is
`Always(status < 500)` on `/api/cart/items`, which is exactly one of the three
assertions in `cart-endpoints-never-unhandled-500` — and that property stays at P1
because its in-scope causes (P2003 from an admin delete racing an add, P2025, and
`SQLITE_BUSY` from the app's own write amplification) are unaffected by the scope
decision. What P2 costs here is only the diagnosable story attached to this
specific cause: if the shared assertion fires, P2002 is now a less likely
explanation than it was.

The assertion itself is unchanged.

## Open questions

None. The unique constraint, the unguarded create, and the absence of error
handling are all directly visible in the code, and the resulting status code is
determined by Next's default behavior for an exception escaping a route handler.
