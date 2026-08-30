# single-cart-per-session

## What led here

Focus 3 found the check-then-act in `resolveCartId`. Focus 12 (wildcard) supplied
what made it interesting: this race is not a load-testing curiosity, it fires on
an ordinary first page load, because the application issues two concurrent
`GET /api/cart` requests every time the cart page mounts.

## Code paths

**`src/lib/cart.ts:37-49`** — `resolveCartId`:

```
38   const jar = await cookies()
39   const existing = jar.get(CART_COOKIE)?.value
41   if (existing) {
42     const found = await prisma.cart.findUnique({ where: { id: existing }, ... })
43     if (found) return found.id
     }
46   const cart = await prisma.cart.create({ data: {} })
47   jar.set(CART_COOKIE, cart.id, cookieOptions())
48   return cart.id
```

**The two concurrent callers on cart page load:**

- `src/app/cart/page.tsx:27-40` — `load()` fetches `/api/cart` in a `useEffect`.
- `src/components/CartBadge.tsx:12-23` — `refresh()` fetches `/api/cart` in its
  own `useEffect`. `CartBadge` is mounted in the root layout, so it renders
  alongside every page.

Both effects run on mount, unordered. Neither awaits the other.

**Amplification:** `mutateCart` fires `notifyCartUpdated()` on success
([cart-events.ts:23](../../../src/components/cart-events.ts#L23)) *and* the cart
page's `run()` fires it again ([cart/page.tsx:59](../../../src/app/cart/page.tsx#L59)).
`CartBadge` listens for that event and re-fetches. So every mutation produces at
least two additional `GET /api/cart` calls — each of which, per
`sut-analysis.md` §4, is also a write.

## Failure scenario

A first-time visitor navigates directly to `/cart` (or clicks the badge from the
catalog before any cart exists):

| t | `CartPage` → `GET /api/cart` | `CartBadge` → `GET /api/cart` |
|---|---|---|
| 1 | no cookie; `findUnique` skipped | |
| 2 | | no cookie; `findUnique` skipped |
| 3 | `cart.create()` → cart `A` | |
| 4 | | `cart.create()` → cart `B` |
| 5 | responds with `Set-Cookie: cartId=A` | |
| 6 | | responds with `Set-Cookie: cartId=B` |

The browser applies both `Set-Cookie` headers in arrival order; the last one
wins. Cart `A` is orphaned. If the shopper's first add raced through the request
that established `A`, that item is now in a cart no cookie points at.

The same shape occurs when a shopper on the catalog page clicks "Add to cart"
before `CartBadge`'s initial fetch has completed — the add and the badge refresh
both arrive cookie-less.

## What goes wrong

The shopper adds an item and the badge reads 0, or the cart page renders empty.
Refreshing may or may not fix it depending on which cart the surviving cookie
names. There is no error, no log, and nothing in the response indicating a
second cart was created.

Secondary consequence: every orphaned cart is a permanent row.
`specs/01` §7.4 states carts are never reaped — see
`cart-rows-bounded-by-distinct-clients`.

## Detection from the workload

The workload models one virtual shopper as one cookie jar. It issues a burst of
concurrent cookie-less requests, then asserts that exactly one distinct `cartId`
appeared across all `Set-Cookie` headers for that shopper, and that a subsequent
`GET /api/cart` contains every item the shopper successfully added.

This requires an HTTP client whose cookie jar the workload controls explicitly —
not one that silently applies last-write-wins the way a browser does, since the
overwriting is the thing being measured.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the `Always` assertion above. Sufficient on its own.
- **Missing, SUT-side (valuable):** an assertion at
  [cart.ts:46](../../../src/lib/cart.ts#L46) marking "created a cart for a request
  that arrived without a usable cookie," carrying the resulting id. Cart creation
  is invisible from outside except by inference, and this marker separates
  "created two carts" from "created one cart and the workload's jar misbehaved."

## Scope decision (2026-08-01): unchanged, and now this category's anchor

The user confirmed multi-shopper access is out of scope. **This property is
untouched by that**, because it never needed a second shopper.

The race is between `CartPage`'s `useEffect` and `CartBadge`'s `useEffect` — two
components in **one document**, mounted by one shopper on one page load, both
fetching `/api/cart` with no cookie and no ordering between them. Excluding
multi-shopper access does not remove a single browser from that race, because
there was only ever one.

Three of the five properties in category A dropped to P2 under the scope decision.
This one and `cart-mutation-applied-at-most-once` did not, and this is now the
highest-priority concurrency property in the catalog. If the workload only ever
exercises one property from category A, it should be this one.

Worth restating for whoever reads this after the demotions: the finding here is
not "the app breaks under load." It is that the app races itself, on the first
page load, before the shopper has done anything.

## Open questions

None. The race, both concurrent callers, and the last-write-wins cookie semantics
are all determined by code in the repository; nothing external is needed to
establish the mechanism.
