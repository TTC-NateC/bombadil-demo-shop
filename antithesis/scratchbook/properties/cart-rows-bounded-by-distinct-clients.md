# cart-rows-bounded-by-distinct-clients

## What led here

Added during evaluation gap-filling, from the Wildcard lens
(`evaluation/wildcard.md`, finding WC-1).

`specs/01` §7.4 accepts unreaped carts explicitly:

> "Abandoned `Cart` rows are never reaped; they are cheap and a demo database is
> disposable."

That reasoning is sound if the row count tracks the number of shoppers. This
property checks the premise, because three separate mechanisms in this codebase
decouple cart creation from shopper count.

## Code paths

**Creation — `src/lib/cart.ts:37-49`:**

```
38   const jar = await cookies()
39   const existing = jar.get(CART_COOKIE)?.value
41   if (existing) {
42     const found = await prisma.cart.findUnique({ where: { id: existing }, ... })
43     if (found) return found.id
     }
46   const cart = await prisma.cart.create({ data: {} })
47   jar.set(CART_COOKIE, cart.id, cookieOptions())
```

A row is created for any request that arrives without a cookie **or** whose
cookie names a cart that no longer exists. There is no rate limit, no
authentication, and no deferral until the first mutation.

**Reached from `GET /api/cart`** — `src/app/api/cart/route.ts:6`. This is the
critical part: cart creation happens on a **GET**, which is the endpoint most
likely to be hit by something that is not a shopper.

**No reaper exists.** grep finds no scheduled job, no TTL, no cleanup script, and
no `deleteMany` on `Cart` anywhere in `src/`, `prisma/`, or `scripts/`. The only
path that removes carts is the `Cart` cascade from a `CartItem` — which does not
exist; the cascade runs the other direction ([schema.prisma:81](../../../prisma/schema.prisma#L81)).

## Three ways the row count decouples from the shopper count

**1. The concurrent first-contact race.** Two cookie-less requests each create a
cart and each emit a `Set-Cookie`; the browser keeps one. Cataloged as
`single-cart-per-session` — that property is about the *correctness* consequence
(items landing in an orphaned cart), this one is about the *growth* consequence.
The cart page reliably issues two concurrent `GET /api/cart` calls on mount
([cart/page.tsx:28](../../../src/app/cart/page.tsx#L28),
[CartBadge.tsx:13](../../../src/components/CartBadge.tsx#L13)), so this fires on
ordinary first loads.

**2. Any client that does not persist cookies.** A crawler, a monitoring probe, a
link prefetcher, or a `curl` in a loop generates one row per request. `GET
/api/cart` is unauthenticated and appears in no `robots.txt` (there is none).

**3. Cookie loss after a reset.** `DELETE /api/products?all=true` cascades
`CartItem` rows away but leaves `Cart` rows. Separately, if a shopper's cookie
names a cart that was deleted, line 42's `findUnique` returns null and line 46
creates a fresh one — so the shopper's cookie churns and each churn is a new row.

## Failure scenario

Over a long Antithesis run:

1. Virtual shoppers hit `GET /api/cart` repeatedly (the workload's own badge-like
   polling, plus every mutation's response).
2. Faults strand cookies: a restart, a dropped response, or the first-contact
   race gives a shopper a second cart id.
3. Row count grows superlinearly in requests rather than linearly in shoppers.
4. The database file grows on the `/data` volume, and every `GET /api/cart`
   continues to take a write lock — feeding `cart-endpoints-never-unhandled-500`
   and `cart-eventually-readable`.

## What the property actually asserts

The workload cannot count database rows. What it can assert is the client-side
invariant that would have to hold for the growth to be bounded:

**A workload client that correctly persists its cookie never receives a second,
different `cartId`.**

If a shopper's cookie jar holds `cartId=A` and a later response carries
`Set-Cookie: cartId=B`, the SUT has created a row that no shopper asked for. That
is observable, cheap, and exactly the signal that distinguishes bounded from
unbounded growth.

This makes the property complementary to `single-cart-per-session` rather than a
duplicate: that one covers the concurrent-burst window at first contact, this one
covers steady state across the whole run, including after faults.

## Why this belongs in an Antithesis catalog rather than a load test

The mechanism is not load — it is *fault-driven cookie loss*. A load test with
well-behaved clients that keep their cookies will never see it. Antithesis
supplies the restarts, dropped responses, and interleavings that strand cookies,
which is the only way mechanism 3 fires.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** per-shopper cookie tracking, and an `Always`
  assertion that a shopper with an established `cartId` never receives a
  different one. The assertion message should carry both ids.
- **Missing, SUT-side (valuable):** a `Reachable` at
  [cart.ts:46](../../../src/lib/cart.ts#L46) marking cart creation, ideally
  distinguishing "no cookie present" from "cookie present but cart not found."
  Those two causes are indistinguishable from outside and point at different
  problems — the first is a new client, the second is a stranded cookie. Shared
  with the SUT-side note in `single-cart-per-session.md`.

## Open questions

- **Is unbounded cart growth acceptable for the demo's intended lifetime, or
  should `GET /api/cart` avoid creating a row until the first mutation?**
  Deferring creation until a mutation would fix all three mechanisms at once and
  would make `GET /api/cart` a genuine read — it would also mean returning an
  empty `PricedCart` without a cookie, which changes the API contract in §7.2.
  If unbounded growth is accepted, this property is documentation of a known
  limitation and should drop to informational rather than being asserted.

### Investigation Log

#### Is unbounded cart growth acceptable, or should GET avoid creating a row?

- Examined: `specs/01` §7.2 (cart resolution — "Cart is resolved from the
  `cartId` cookie; if none, one is created and the cookie set"), §7.4 (cookie
  attributes and the unreaped-carts statement), §1 (non-goals), `src/lib/cart.ts`,
  `src/app/api/cart/route.ts`; grep for any cleanup, TTL, or `Cart` deletion
  across `src/`, `prisma/`, `scripts/`.
- Found: `specs/01` §7.2 specifies creation-on-resolve as the intended behavior,
  including for the GET path — so this is a design decision, not an oversight.
  §7.4 states the acceptance of unreaped rows and gives the reason ("they are
  cheap and a demo database is disposable"). No reaper of any kind exists.
- Not found: any consideration of clients that do not persist cookies, of the
  concurrent-creation race, or of an expected upper bound on row count. The
  "cheap" justification is stated without a model of how many rows accumulate.
- Conclusion: tagged `(needs human input)`. The behavior is deliberate and
  documented; what is undecided is whether the premise behind "cheap" — one row
  per shopper — is one the project wants to defend, given that three mechanisms
  in its own code break it. That is a scope call, not a code fact.
