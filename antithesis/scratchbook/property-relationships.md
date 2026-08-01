---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Property Relationships

Lightweight map of which properties share code paths, evidence, or failure
mechanisms. Written during discovery synthesis, updated after evaluation
gap-filling, and revised after the 2026-08-01 scope decision. This is a set of
connections noticed while working, not a formal dependency analysis.

**Effect of the scope decision on this map.** Clusters are unchanged — the shared
code paths and mechanisms are the same regardless of scope. What changed is
triage weight within cluster 2: `cart-item-quantity-no-lost-update` and
`cart-item-create-no-unique-violation` are now P2, so a failure in cluster 2 is
most likely to surface via `cart-endpoints-never-unhandled-500` (cluster 3) or
`price-snapshot-immutable`, both of which kept full priority. Cluster 6 gained
weight: `single-cart-per-session` is now the highest-priority concurrency property
in the catalog.

## Cluster 1 — The `priceAndPrune` read-modify-write

**Shared code:** `src/lib/cart.ts:89-124`, plus the second writer at
`src/app/api/cart/coupons/route.ts:32-38`.

- `cart-coupon-set-atomic`
- `persisted-coupons-match-discount-lines`
- `coupon-prune-path-observed`
- `coupon-mutation-leaves-cart-consistent`
- `coupon-removal-is-reversible`

All five read or write `Cart.coupons` through the same unguarded sequence.
`coupon-prune-path-observed` is the reachability marker the other four depend on:
if the prune never fires, `persisted-coupons-match-discount-lines` and
`coupon-mutation-leaves-cart-consistent` pass vacuously.

**Suspected dominance:** `cart-coupon-set-atomic` is the broadest — a failure
there will usually also break `persisted-coupons-match-discount-lines`, since a
clobbered write is exactly a persisted set that doesn't match what applied. If
both fire, triage `cart-coupon-set-atomic` first. The reverse does not hold:
`persisted-coupons-match-discount-lines` can break single-threaded, via the
double-write in the coupon DELETE route.

**Shared instrumentation:** one SUT-side marker at
[cart.ts:119](../../src/lib/cart.ts#L119) serves `cart-coupon-set-atomic`
(identifies the lost-update branch), `coupon-prune-path-observed` (confirms the
prune ran), and `persisted-coupons-match-discount-lines` (makes the equality
exactly observable). Highest-value single instrumentation point in the catalog.

## Cluster 2 — The `POST /api/cart/items` check-then-act

**Shared code:** `src/app/api/cart/items/route.ts:23-46`.

- `cart-item-quantity-no-lost-update` — the `if (existing)` branch
- `cart-item-create-no-unique-violation` — the `else` branch
- `cart-mutation-applied-at-most-once` — bounds the same counter from both sides
- `product-delete-cascades-cleanly` — the P2003 variant of the same window
- `price-snapshot-immutable` — the price read at line 23 vs. the write at line 43

Five properties, one function. The two branches of a single `if` produce opposite
failure signatures: silent wrong answer vs. loud 500.

**Suspected dominance:** `cart-mutation-applied-at-most-once`'s lower bound
(`acked <= observed`) is implied by `cart-item-quantity-no-lost-update`. If the
lost-update property holds, the lower bound cannot fire. The upper bound
(`observed <= attempted`) is independent and is the real content of that
property. Triage a lower-bound failure as a lost update first.

## Cluster 3 — Missing error handling

**Shared absence:** no `try`/`catch` in any file under `src/app/api/cart/`.

- `cart-endpoints-never-unhandled-500` — the catch-all
- `cart-item-create-no-unique-violation` — P2002, a named cause
- `product-delete-cascades-cleanly` — P2003, a named cause
- `cart-eventually-readable` — what happens after the exceptions stop

**Suspected dominance:** `cart-endpoints-never-unhandled-500` strictly dominates
the two named-cause properties for *detection* — any 500 they catch, it catches
too. They are kept separate because they carry a diagnosable story and it does
not. If only the catch-all fires, the cause is unenumerated — most likely
`SQLITE_BUSY`, which has no single call site.

## Cluster 4 — The N+1 coupon winner selection

**Shared code:** `src/lib/pricing/engine.ts:240-295`.

- `applying-coupon-never-raises-total`
- `coupon-removal-is-reversible`
- `exclusive-coupon-wins-observed`

`exclusive-coupon-wins-observed` is the reachability gate for the other two: both
concern what happens when an exclusive coupon wins, so a run where that never
occurs tests neither.

**Shared instrumentation:** a SUT-side marker inside the winner loop at
[engine.ts:265](../../src/lib/pricing/engine.ts#L265) serves all three. The N+1
comparison is entirely internal — the response shows only the winner, so from
outside "the exclusive beat three candidates" and "only one candidate existed"
are indistinguishable.

**Connection to Cluster 1:** supersession is what evicts stackables from
`Cart.coupons`, so `coupon-removal-is-reversible` sits in both clusters. Its
mechanism is here; its persistence consequence is there.

## Cluster 5 — Invariants as a shared assertion library

**Shared code:** `src/lib/pricing/invariants.ts`, reused by the workload.

- `priced-cart-invariants-hold` — the primary
- `money-fields-stay-exact` — the most likely reason invariant 2 or 7 breaks
- `product-delete-cascades-cleanly` — invariants after a cascade
- `coupon-mutation-leaves-cart-consistent` — invariants during coupon mutation
- `cart-eventually-readable` — invariants during the quiet-period check

**Suspected dominance:** `priced-cart-invariants-hold` is the tripwire for most
of category B. When it fires alongside `money-fields-stay-exact`, the overflow is
the cause and the invariant break is the symptom — triage the overflow.

Practically, the seven invariant assertions should be written once in the
workload and called from every response handler, so four of these properties
share one implementation.

## Cluster 6 — Cart identity and the cookie

**Shared code:** `src/lib/cart.ts:37-49` (`resolveCartId`).

- `single-cart-per-session` — the concurrent first-contact race
- `cart-rows-bounded-by-distinct-clients` — steady-state growth
- `acked-cart-mutations-survive-restart` — needs stable cart identity across a
  restart to have anything to check

The first two are complementary rather than overlapping: the same line 46 creates
the row, but one property is about correctness in a burst and the other about
growth over a run. Neither implies the other — a system could pass the burst
check and still leak rows to cookie-less clients.

**Shared instrumentation:** a SUT-side `Reachable` at
[cart.ts:46](../../src/lib/cart.ts#L46), ideally distinguishing "no cookie
present" from "cookie present but cart not found," serves both.

## Cluster 7 — Catalog size and unbounded reads

**Shared mechanism:** unpaginated `findMany` over the whole catalog.

- `recommendations-stay-responsive` — `recommend-service.ts:13`
- `catalog-read-never-shows-partial-batch` — `products/route.ts:12`
- `bulk-product-create-atomic` — the writer these two read against

All three are exercised by one workload setup: a large staging run with
concurrent shoppers. `bulk-product-create-atomic` is the writer;
`catalog-read-never-shows-partial-batch` checks what readers see during it; and
`recommendations-stay-responsive` checks the heaviest reader completes.

## Cluster 8 — Restart and startup

**Shared trigger:** node-termination faults.

- `acked-cart-mutations-survive-restart`
- `startup-crash-never-bricks-container`
- `price-snapshot-immutable` (the seed-revert variant only)

All three are unfound rather than passing if node termination is disabled. They
should be reported together so a run summary does not read as three clean results
when the fault was never injected.

**Suspected dominance:** `startup-crash-never-bricks-container` dominates in a
blunt way — if the container bricks, every other property stops being checkable.
It is the one to triage first after any restart-related failure.

## Cross-cluster notes

- **The two-GET pattern** appears in `persisted-coupons-match-discount-lines`
  (checking for divergence) and in the workload bookkeeping several other
  properties need. Implementing it once as a workload helper is worthwhile.
- **Per-cart serialization.** Revised by the scope decision of 2026-08-01. With
  multi-shopper access out of scope, one shopper per cart is the default, so the
  preconditions of `applying-coupon-never-raises-total`,
  `coupon-removal-is-reversible`, and `price-snapshot-immutable` come for free —
  the workload no longer needs to keep a "concurrent shopper pool" off their
  carts. What it does need is a *browser-faithful* shopper that reproduces the
  overlap the application generates on its own (the mount-time double fetch and
  the double `notifyCartUpdated()` per mutation), since that is what exercises
  `single-cart-per-session` and supplies the contention behind
  `cart-endpoints-never-unhandled-500`. See `deployment-topology.md`.
- **`cart-endpoints-never-unhandled-500` should be asserted unconditionally**,
  across both modes and every other property's traffic. It is the cheapest
  assertion in the catalog and it is the one most likely to fire first.

## Coverage of the catalog

Every slug referenced above appears in `property-catalog.md`. Properties
appearing in no cluster: none — all 24 are placed. Properties appearing in more
than one: `coupon-removal-is-reversible` (1, 4), `product-delete-cascades-cleanly`
(2, 3, 5), `price-snapshot-immutable` (2, 6, 8),
`coupon-mutation-leaves-cart-consistent` (1, 5), `cart-eventually-readable`
(3, 5), `bulk-product-create-atomic` (7), `acked-cart-mutations-survive-restart`
(6, 8).
