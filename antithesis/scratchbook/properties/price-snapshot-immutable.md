# price-snapshot-immutable

## What led here

`specs/01` §4.1 is a section titled "Why `unitPriceCentsSnapshot`," and
`specs/02` AC 10 turns it into a testable statement:

> "Changing a product's price via `PATCH` does not alter the total of a cart that
> already contains it."

`specs/01` §4.1 adds the second reason it exists: "Playwright fixtures are
stable: a cart's arithmetic cannot move underneath a running test." So a
regression here breaks the existing test suite's foundations as well as the
shopper-facing guarantee.

That is claim S9 in `sut-analysis.md` §5.

## Code paths

**Capture — `src/app/api/cart/items/route.ts:23-45`:**

```
23   const product = await prisma.product.findUnique({ where: { id: productId } })
...
31   if (existing) {
32     // Quantity change only — the snapshot is NOT refreshed (§4.1).
33     await prisma.cartItem.update({ ..., data: { quantity: ... } })
37   } else {
38     await prisma.cartItem.create({
39       data: { cartId, productId, quantity,
43              unitPriceCentsSnapshot: product.priceCents },
45     })
     }
```

**Read — `src/lib/cart.ts:102-109`:**

```
107      // The snapshot, never Product.priceCents (§4.1).
         unitPriceCents: line.unitPriceCentsSnapshot,
```

**Admin write — `src/app/api/products/[idOrSlug]/route.ts:56-62`** — `PATCH`
updates `Product.priceCents` with no reference to `CartItem`. Correct by design.

`PATCH /api/cart/items` sets quantity only ([items/route.ts:66](../../../src/app/api/cart/items/route.ts#L66)),
and `POST` on an existing row updates quantity only. So no code path rewrites
`unitPriceCentsSnapshot` after creation. Within a single process lifetime the
guarantee is structurally sound.

## Two windows where it is not sound

### 1. The capture window (narrow, ambiguous)

`product.priceCents` is read at line 23 and written at line 43, with
`resolveCartId()` — which may create a cart and perform its own database round
trip — in between at line 26. A concurrent admin `PATCH` landing in that window
means the snapshot records a price that was already superseded when it was
written.

This is ambiguous rather than clearly wrong: both the pre-PATCH and post-PATCH
prices are defensible answers for a request that arrived concurrently with the
edit. It is recorded because it is a real read-then-write gap, not because it
obviously produces a wrong result.

### 2. The restart window (wide, and clearly surprising)

`docker/entrypoint.sh` runs `npx --no-install prisma db seed` on **every**
container start. `prisma/seed.ts:19-27` upserts each fixture product by slug with
an `update` payload that includes `priceCents`:

```
14   const data = { name, description, priceCents, category, active: true }
21   await prisma.product.upsert({
22     where: { slug: product.slug },
23     create: { slug: product.slug, ...data },
24     update: data,                                 // <-- rewrites priceCents
25   })
```

So an admin's price edit to a *seeded* product is silently reverted by any
restart. Meanwhile carts created before the restart keep snapshots of the edited
price.

Neither half is wrong on its own. The seed's idempotence is deliberate and
documented ("so the container entrypoint can run it on every start without
duplicating rows"). The snapshot's immutability is deliberate and documented. The
composition produces a catalog and a set of carts that disagree about what the
price ever was, and only a restart-aware test would see it. This is the
composition noted in `sut-analysis.md` §11.

## Failure scenario

1. Shopper adds product P at `priceCents: 12999`. `CartItem.unitPriceCentsSnapshot
   = 12999`.
2. Admin `PATCH`es P to `priceCents: 9999`.
3. Cart total is unchanged — **guarantee holds**, `specs/02` AC 10 satisfied.
4. Container is crash-killed and restarted. The entrypoint's seed rewrites P back
   to `12999`.
5. A second shopper adds P and gets a snapshot of `12999`.
6. The catalog page shows `12999`. The admin's edit is gone with no record.

Step 4 is where Antithesis contributes something no existing test does. **This
variant needs node-termination faults**, which are commonly disabled — see the
open questions in `property-catalog.md`.

## What goes wrong

For the narrow window: a cart priced from a snapshot that never matched any
committed catalog state. For the restart composition: an admin change that
appears to succeed (200 with the updated product) and silently reverts, while
carts created in the interim are priced from it forever.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** record `unitPriceCents` per `(cart, product)` on
  first observation; `Always` assert every later observation matches. Cheap, and
  it covers both windows from the shopper's side.
- **Missing, workload-side (restart variant):** record the admin-set
  `priceCents` per product, and after a restart assert the catalog still reports
  it. This is the half that catches the seed revert. It is arguably a separate
  concern from the snapshot; kept here because the two only produce a visible
  contradiction together.
- **Missing, SUT-side (optional):** an assertion at
  [items/route.ts:43](../../../src/app/api/cart/items/route.ts#L43) recording the
  captured snapshot against the product's current `priceCents` at write time,
  which would make the narrow capture window directly observable.

## Open questions

- **Should the snapshot be captured inside a transaction with the item create, so
  it cannot be stale relative to the row it was read from?** If yes, the capture
  window is a defect and the fix is a transaction spanning
  [items/route.ts:23-45](../../../src/app/api/cart/items/route.ts#L23-L45). If
  no — because either price is an acceptable answer for a concurrent request —
  the property should assert only post-creation immutability and drop the capture
  window entirely, which makes it a cheaper and stronger assertion.

### Investigation Log

#### Should the snapshot be captured inside a transaction with the item create?

- Examined: `src/app/api/cart/items/route.ts:18-49`, `src/lib/cart.ts:37-49`
  (`resolveCartId`, which sits inside the window), `prisma/schema.prisma`
  (`CartItem.unitPriceCentsSnapshot`), `specs/01` §4.1, `specs/02` §4 and AC 10,
  `src/app/api/products/[idOrSlug]/route.ts` (`PATCH`).
- Found: the window is confirmed — three `await` points separate the price read
  from the snapshot write, one of which (`resolveCartId`) can itself perform a
  create. `specs/01` §4.1 defines the guarantee as "The snapshot is captured on
  `POST /api/cart/items` when the row is created," which describes *when* the
  capture happens but not *which* price it must reflect if the price changes
  during the request.
- Not found: any spec text on concurrent admin edits during a cart add.
  `specs/02` AC 10's phrasing ("a cart that **already** contains it") scopes the
  guarantee to carts where the item pre-exists the edit, which suggests the
  concurrent case was not considered rather than that it was decided.
- Conclusion: tagged `(partial: ...)`. The window is confirmed to exist in code.
  Whether the resulting staleness is user-visibly wrong depends on which price is
  "correct" for a request racing the edit, and the specs do not settle that.
