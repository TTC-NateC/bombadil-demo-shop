# product-delete-cascades-cleanly

## What led here

`shopping-cart-demo-spec.md` defect #4:

> "`CartItem.product` had no `onDelete`, so Prisma's default `Restrict` made
> `DELETE /api/products/[id]` throw `P2003` — breaking `--reset` precisely when
> you'd use it, right after a demo."

The fix landed: `onDelete: Cascade` is present at
[schema.prisma:84](../../../prisma/schema.prisma#L84), with a comment explaining
why. `specs/02` AC 6 tests it. This property exists because the fix covers the
delete direction and leaves the *insert* direction open, and because a recently
fixed bug is a good place to look for a neighbouring one.

## Code paths

**Fixed direction — `prisma/schema.prisma:81-86`:**

```
81   cart    Cart    @relation(fields: [cartId], references: [id], onDelete: Cascade)
84   product Product @relation(fields: [productId], references: [id], onDelete: Cascade)
86   @@unique([cartId, productId])
```

**The delete paths:**

- `DELETE /api/products/[idOrSlug]` —
  [route.ts:68-86](../../../src/app/api/products/[idOrSlug]/route.ts#L68-L86)
- `DELETE /api/products?all=true` — `deleteMany({})`,
  [products/route.ts:48-54](../../../src/app/api/products/route.ts#L48-L54).
  Its comment names the `--reset` scenario explicitly.
- Both are reachable from `scripts/stage-data.ts:197-203` (`--reset`).

**Unfixed direction — `src/app/api/cart/items/route.ts:23-45`:**

```
23   const product = await prisma.product.findUnique({ where: { id: productId } })
24   if (!product || !product.active) return apiError("NOT_FOUND", "Unknown product")
26   const cartId = await resolveCartId()
27   const existing = await prisma.cartItem.findUnique({ ... })
...
38   await prisma.cartItem.create({
39     data: { cartId, productId, ... },              // <-- FK to a row that may be gone
45   })
```

The product's existence is checked at line 23 and relied upon at line 38, with
two `await` points in between. A delete landing in that window makes the create
violate `CartItem.product`'s foreign key — P2003, unhandled, 500.

## Failure scenarios

**A — cascade correctness (the fixed direction, verifying it stays fixed):**

1. Shopper has products P and Q in a cart.
2. Admin deletes P.
3. Shopper's next `GET /api/cart` must return 200 with a valid `PricedCart`
   containing only Q, all seven §5.2 invariants intact.

The subtle part is the pricing consequence. Removing a line changes the subtotal,
which can cross `freeShippingThresholdCents` or a coupon's `minSubtotalCents`,
which prunes coupons ([cart.ts:117-124](../../../src/lib/cart.ts#L117-L124)).
So a product deletion can silently change which coupons the shopper holds — a
three-hop consequence with no message. That is correct per §5.6, and it is where
an invariant violation would show up if the recomputation went wrong.

**B — the insert race (the unfixed direction):**

| t | Shopper `POST /api/cart/items {P}` | Admin `DELETE /api/products?all=true` |
|---|---|---|
| 1 | `findUnique(P)` → found, active | |
| 2 | `resolveCartId()` | |
| 3 | | `deleteMany({})` commits |
| 4 | `cartItem.create({productId: P})` → **P2003** | |
| 5 | throws; 500 | |

`--reset` is documented as the thing you run "right after a demo," which is
precisely when carts exist and shoppers are still clicking. The staging script
issues the reset as its first action ([stage-data.ts:197-203](../../../scripts/stage-data.ts#L197-L203)).

## What goes wrong

Scenario A failing means a cart that references a deleted product, or a
`PricedCart` whose totals don't reconcile after the cascade — a regression of
defect #4 in a new form.

Scenario B failing means the shopper's add returns an unstructured 500 during a
reset. `specs/02` §6 does not list 500 as a permitted code.

## Note on the image unlink

`DELETE /api/products/[idOrSlug]` also unlinks the product's uploaded image
([route.ts:78-83](../../../src/app/api/products/[idOrSlug]/route.ts#L78-L83)),
guarded by `STORED_NAME.test(filename)` and swallowing errors with
`.catch(() => undefined)`. The swallow is defensible (a missing file shouldn't
fail the delete) but it means a failed unlink is invisible — orphaned files
accumulate silently on the `/data` volume. Not made a property: the growth rate
is bounded by admin deletes, and no spec claims otherwise. Recorded so a future
reader doesn't have to rediscover the decision.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** assert the delete returns 200 (not 5xx); assert the
  affected cart's next `PricedCart` satisfies the invariants and contains no line
  for the deleted product; assert every `/api/cart/items` response is `< 500`
  (shared with `cart-item-create-no-unique-violation`).
- **Missing, SUT-side:** none needed. Both scenarios are visible in responses.

## Open questions

None. The cascade is present and its behavior is determined by the schema; the
insert-side window is directly readable in the route; and `specs/02` AC 6 states
the guarantee being tested.
