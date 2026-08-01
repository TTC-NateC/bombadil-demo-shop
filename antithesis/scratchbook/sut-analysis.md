---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# SUT Analysis — demo-shop

Research scope confirmed with the user at the start of this run:
**"Just this directory"** (no external docs, repos, or trackers) and
**"Cart / checkout core"** as the target subsystem. The analysis covers the whole
system for context, but depth and property density are concentrated on the cart,
pricing, and coupon paths.

Produced by a single-agent pass through the twelve attention focuses in
`references/sut-discovery.md`. Focus provenance is noted per finding as `[F1]`,
`[F2]`, etc.

---

## 1. What the product is

A self-contained demo e-commerce app: browse a seeded catalog, manage a cart,
apply and remove coupons, and see a fully itemized price breakdown. There is
**no checkout, no payment, and no order placement** — `specs/01` §1 lists all
three as explicit non-goals. "The cart is the terminal screen." There is also no
inventory, no shopper accounts, and no authentication for shoppers. `[F10]`

The declared centerpiece is the **pricing engine**: `specs/01` §5 calls it "the
single source of truth for all totals," and the top-level spec's cross-cutting
rule 2 states "the client never computes money." The three build slices are:
core shop + engine (slice 1), admin API + data pipeline (slice 2), and
recommendations + toasts (slice 3). All three are implemented at this commit.

A user-visible failure here looks like: a wrong total, a coupon chip that
disappears or refuses to apply, a cart that loses an item the shopper added, or
a cart badge that disagrees with the cart page. `[F10]`

---

## 2. Architecture and data flow `[F1]`

**Single process, single container.** Next.js 15.5.22 App Router
(`output: "standalone"`), serving both the React UI and the JSON API from one
Node 20 process. SQLite via Prisma 6.19.3 in the same process — the database is a
file on the `/data` volume, not a separate service. There is no message broker,
no cache, no sidecar, and no external network dependency at runtime.

```
browser ──HTTP──> Next.js server process ──in-process──> Prisma client ──file I/O──> /data/app.db
                        │                                                             ▲
                        └── node:fs (uploads) ─────────────────────────────────────> /data/uploads
```

### Entry points

| Path | Auth | Purpose |
|---|---|---|
| `GET /api/products` | none | catalog list ([products/route.ts:9](../../src/app/api/products/route.ts#L9)) |
| `GET /api/products/[idOrSlug]` | none | one product |
| `GET /api/cart` | none (cookie) | **priced cart — and it writes** (see §4) |
| `POST/PATCH/DELETE /api/cart/items` | none (cookie) | add / set quantity / remove |
| `POST/DELETE /api/cart/coupons` | none (cookie) | apply / remove coupon |
| `GET /api/recommendations`, `GET /api/products/[idOrSlug]/recommendations` | none | recommendations |
| `GET /uploads/[filename]` | none | serve stored image |
| `POST/DELETE /api/products`, `POST /api/products/bulk`, `PATCH/DELETE /api/products/[idOrSlug]` | `x-admin-key` | admin catalog writes |
| `GET/POST/DELETE /api/coupons`, `POST /api/coupons/bulk`, `PATCH/DELETE /api/coupons/[id]` | `x-admin-key` | admin coupon writes |
| `POST /api/uploads` | `x-admin-key` | image upload |

### The cart request path (the target subsystem)

Every cart-mutating route follows the same three steps:

1. `resolveCartId()` — read the `cartId` cookie, verify the row exists, else
   create a cart and set the cookie ([cart.ts:37-49](../../src/lib/cart.ts#L37-L49)).
2. The route's own Prisma write (`cartItem.create/update/delete`, or nothing for
   coupon apply).
3. `priceAndPrune(cartId, applyingCode?)` — load cart + items + products, load
   candidate coupon rows, call the pure `priceCart()`, then **write back**
   `Cart.coupons` if the applied set changed
   ([cart.ts:85-132](../../src/lib/cart.ts#L85-L132)).

`priceAndPrune` is the single funnel. Its doc comment states the reason: "a route
that skipped the prune would be a silent bug with no failing test anywhere else."

### The pure core

`src/lib/pricing/engine.ts` is genuinely pure — no Prisma, no clock except the
injected `now`. `priceCart()` builds N+1 candidate coupon sets (all stackables
together, plus each exclusive alone), prices each with `priceWithCouponSet()`,
and picks the lowest `totalCents`, tie-breaking on candidate count then sorted
code list ([engine.ts:228-238](../../src/lib/pricing/engine.ts#L228-L238)).
`src/lib/recommend.ts` follows the same pure/impure split.

---

## 3. State management and persistence `[F2]`

### Stored state

| Where | What | Notes |
|---|---|---|
| `/data/app.db` (SQLite) | `Product`, `Coupon`, `Cart`, `CartItem` | single file, single writer |
| `/data/uploads/<uuid>.<ext>` | uploaded images | flat, server-generated names |
| `cartId` cookie | the only client-side state | httpOnly, lax, 30d, unsigned by design |
| `process.env` | store config, admin key | read per request (see below) |

### Two JSON-in-a-column fields

`Cart.coupons` and `Product.relatedIds` are `String` columns holding JSON arrays
(`schema.prisma:66`, `schema.prisma:27`). SQLite has no array type and the Prisma
SQLite connector has no `enum`, which `specs/01` §4.3 documents as the reason
`Coupon.type` and `Coupon.targetType` are also plain strings, narrowed by Zod at
the boundary.

`Cart.coupons` matters most: it is the **only** persisted cart-level state besides
the item rows, and every pricing pass rewrites it via read-modify-write.

### The price snapshot

`CartItem.unitPriceCentsSnapshot` is captured once, when the row is created
([items/route.ts:43](../../src/app/api/cart/items/route.ts#L43)), from
`product.priceCents` read moments earlier at line 23. The engine reads the
snapshot and never `Product.priceCents`. `specs/01` §4.1 claims two consequences:
an admin price change does not reprice existing carts, and Playwright fixtures are
stable. Both are claims this catalog turns into properties, not established facts.

### Concurrency-relevant persistence properties

- **No `PRAGMA journal_mode=WAL`, no `busy_timeout` anywhere.** grep for
  `journal_mode`, `busy_timeout`, `WAL`, `pragma` across `src/`, `prisma/`,
  `scripts/`, `e2e/`, `docker/` returns nothing. The `DATABASE_URL` carries no
  connection parameters (`.env`, `.env.example`, Dockerfile `ENV`).
- **`prisma.$transaction` is used in exactly two places**: `products/bulk` and
  `coupons/bulk`, both as array-form batched creates. No cart path uses a
  transaction — including the read-modify-write in `priceAndPrune`.
- **Config is re-read per request.** `loadConfig()` is called inside
  `priceAndPrune` on every pass ([cart.ts:114](../../src/lib/cart.ts#L114)) rather
  than being captured at startup. `readInt`/`readBool` silently fall back to the
  default on unparseable input rather than failing
  ([config.ts:19-35](../../src/lib/pricing/config.ts#L19-L35)).
- **Abandoned carts are never reaped.** `specs/01` §7.4 states this explicitly:
  "Abandoned `Cart` rows are never reaped; they are cheap and a demo database is
  disposable."

### Startup state machinery

`docker/entrypoint.sh` runs, in order: admin-key fail-closed check (production
only), `mkdir -p /data` and the upload dir, `npx --no-install prisma migrate
deploy`, `npx --no-install prisma db seed`, then `exec node server.js`. The seed
is idempotent (upsert by slug/code) and runs on **every** container start — which
means a restart rewrites `Product.priceCents` for every seeded product back to
its fixture value.

---

## 4. Concurrency model `[F3]`

This is the most important section for Antithesis, and the most surprising.

### There is real concurrency, and it is not guarded

Node is single-threaded, but every route handler is `async` and awaits Prisma
between reads and writes. Two HTTP requests in flight simultaneously interleave
freely at every `await`. The code contains at least four check-then-act sequences
with no transaction and no unique-constraint recovery:

1. **`resolveCartId`** — `cookies().get` → `cart.findUnique` → `cart.create` →
   `jar.set`. Two cookie-less requests each create a cart and each emit a
   `Set-Cookie`. ([cart.ts:37-49](../../src/lib/cart.ts#L37-L49))
2. **`POST /api/cart/items`** — `cartItem.findUnique` → either
   `update({quantity: existing.quantity + quantity})` or `create(...)`. Two
   concurrent adds of the same product either both create (violating
   `@@unique([cartId, productId])`) or both compute the same `existing.quantity +
   n` (losing one add). There is no `upsert` and no `{ increment: n }`.
   ([items/route.ts:27-46](../../src/app/api/cart/items/route.ts#L27-L46))
3. **`priceAndPrune`** — `cart.findUnique(include items)` → pure pricing →
   `cart.update({coupons})`. The write is based on a snapshot read earlier in the
   same request. Concurrent passes clobber each other's coupon set.
   ([cart.ts:89-124](../../src/lib/cart.ts#L89-L124))
4. **`uniqueSlug`** — a `while (await findUnique(slug))` loop that returns a slug
   nobody has reserved. Concurrent product creates, and *even a single bulk
   request containing two rows with the same name*, produce the same slug.
   ([product-payload.ts:57-66](../../src/lib/api/product-payload.ts#L57-L66))

### `GET /api/cart` is a write

`priceAndPrune` is called on the GET path too, and it issues `cart.update` when
the applied set differs from what is stored. So a plain read of the cart takes a
SQLite write lock. Two facts make this load-bearing:

- The cart page mounts `CartPage` (which fetches `/api/cart`) *and* `CartBadge`
  (in the root layout, which also fetches `/api/cart`) simultaneously. Every cart
  page load issues at least two concurrent `GET /api/cart` requests.
  ([cart/page.tsx:28](../../src/app/cart/page.tsx#L28),
  [CartBadge.tsx:13](../../src/components/CartBadge.tsx#L13))
- `mutateCart` fires `notifyCartUpdated()` on success, and `run()` in the cart
  page fires it again — so each mutation triggers at least two more badge
  refreshes ([cart-events.ts:23](../../src/components/cart-events.ts#L23),
  [cart/page.tsx:59](../../src/app/cart/page.tsx#L59)).

On a first visit with no cookie, those two concurrent GETs both fall through
`resolveCartId`'s create branch.

### The project already knows SQLite contention is a hazard

`playwright.config.ts:11-17` and `specs/01` §12.1 both state it in terms worth
quoting: "SQLite is single-writer. Parallel workers hitting one database file
produce `SQLITE_BUSY` errors that surface as intermittent, plausible-looking
pricing bugs. If this suite ever gets slow enough to matter, the fix is WAL mode
plus a busy timeout — **not** more workers."

The chosen mitigation is `workers: 1` in the **test harness**. The served
application has no equivalent mitigation and no equivalent constraint on how many
browsers hit it. Note what this does to the test suite's evidentiary value: the
suite is configured so that it can never observe the failure mode the comment
describes.

### No error handling on any cart path

Not one cart route has a `try`/`catch`. A Prisma `P2002` (unique violation),
`P2003` (FK violation), or a raw `SQLITE_BUSY` propagates out of the handler and
Next returns an unstructured 500. The client's only response is
`toast({variant: "warning", message: "Something went wrong — please try again"})`
([cart/page.tsx:53](../../src/app/cart/page.tsx#L53)).

### Client-side serialization is per-component, not per-cart

`AddToCartButton` and the cart page each hold their own `busy` flag that disables
their own buttons. Two different components (e.g. a product card and a
recommendation card for the same product) can be in flight at once, and nothing
coordinates across browser tabs sharing a cookie.

---

## 5. Claimed guarantees `[F4]` `[F5]`

These are **claims made by the specs and code comments**, extracted verbatim in
substance. This analysis does not assert that any of them hold; each is a
candidate property (see `property-catalog.md`).

### Safety claims

| # | Claim | Source |
|---|---|---|
| S1 | The seven §5.2 pricing invariants hold on every `GET /api/cart` response | `specs/01` §5.2, AC 7 |
| S2 | `discountTotalCents` never includes shipping | `specs/01` §5.2 |
| S3 | Allocation is exact — per-line discounts sum to the whole, no drift | `specs/01` §5.5, `allocate.ts` header |
| S4 | No line total and no cart total ever goes negative | `specs/01` §5.5 |
| S5 | A shopper entering a valid code is never penalised — the winning set is the lowest total | `specs/01` §5.3, defect #3 |
| S6 | `Cart.coupons` holds *exactly* what applied on the last pricing pass — nothing else | `specs/01` §5.6 |
| S7 | `rejectedCoupons` means exactly one thing: this apply attempt failed and was not persisted | `specs/01` §5.6, `specs/03` §4.1 |
| S8 | Nothing of value is lost when an exclusive coupon supersedes stackables, because supersession only happens at a strictly lower total | `specs/01` §5.6 |
| S9 | Changing a product's price does not alter the total of a cart that already contains it | `specs/01` §4.1, `specs/02` AC 10 |
| S10 | Bulk create is all-or-nothing: an invalid row creates **zero** rows | `specs/02` §4, AC 1 |
| S11 | Deleting a product that sits in a live cart succeeds, and the cart renders without it | `specs/01` §4.2, `specs/02` AC 6 |
| S12 | Admin endpoints fail closed — unset `ADMIN_API_KEY` returns 401, never succeeds | `specs/02` §2.1, AC 2 |
| S13 | `GET /uploads/../app.db` and the encoded form return 404 | `specs/02` §8.2, AC 5 |
| S14 | The engine is deterministic — priority ties break on code, output is independent of input order | `specs/01` §5.4 |
| S15 | Ordering, not caching: cart and catalog reads never serve stale data | `specs/01` §7.5 |

### Liveness / progress claims

| # | Claim | Source |
|---|---|---|
| L1 | `docker run` produces a working app with seeded data, no network access required at container start | `specs/01` AC 1 |
| L2 | The seed is idempotent, so the entrypoint can run it on every start | `prisma/seed.ts` header, `specs/01` §10 |
| L3 | Uploaded images and created products survive a container restart | `specs/02` AC 4, §11 |
| L4 | The recommendation section is never empty — layer 3 is a deterministic fallback | `specs/03` §2.1 |
| L5 | The staging script continues past a failed API call and reports `created + skipped === N` | `specs/02` §9.5, AC 7 |

### Claims with no enforcement mechanism found

- **S1** is asserted only in Vitest. `assertInvariants` is never called on an API
  response path — there is no cart-route test file, despite the comment in
  `invariants.ts` saying there is.
- **S6/S7** depend entirely on `priceAndPrune` being the sole writer of
  `Cart.coupons`. Grep confirms `DELETE /api/cart/coupons` writes it too
  ([coupons/route.ts:35-38](../../src/app/api/cart/coupons/route.ts#L35-L38)) —
  a second, unsynchronized writer of the same column.
- **S10** has no defence against duplicate slugs generated *within* one batch.
  The coupon bulk route explicitly checks `duplicatesInBatch`
  ([coupons/bulk/route.ts:30-35](../../src/app/api/coupons/bulk/route.ts#L30-L35));
  the product bulk route has no equivalent check.

---

## 6. Failure and degradation modes `[F8]`

### What the system does on error

| Layer | Behavior |
|---|---|
| Zod validation failures | structured 400 via `validationError` |
| Not-found / conflict | structured 4xx via `apiError` |
| Prisma exceptions | **unhandled** — Next's default 500, no structured body |
| Filesystem errors on upload read | caught, 404 ([uploads/[filename]/route.ts:54](../../src/app/uploads/[filename]/route.ts#L54)) |
| Unlink of a deleted product's image | `.catch(() => undefined)` — swallowed ([[idOrSlug]/route.ts:82](../../src/app/api/products/[idOrSlug]/route.ts#L82)) |
| Client fetch failures | one generic warning toast; no retry, no backoff |

### Notable degradation gaps

- **No retry, no backoff, no circuit breaker anywhere.** Neither the client
  (`mutateCart`) nor the server retries a failed database operation, which is
  exactly the operation most likely to fail transiently under SQLite contention.
- **No health or readiness endpoint.** `playwright.config.ts` polls
  `/api/products` as a liveness proxy. Antithesis will need something similar.
- **No timeouts on anything.** No `AbortController` in the client, no query
  timeout in Prisma configuration.
- **Startup is a hard sequence with no recovery.** `entrypoint.sh` uses `set -e`.
  If `prisma migrate deploy` is interrupted mid-migration, the
  `_prisma_migrations` bookkeeping row is left with a null `finished_at`, and the
  next `migrate deploy` refuses to proceed. The container would then fail to
  start on every subsequent attempt rather than degrading.
- **`--no-install` on both `npx` calls is deliberate** — the comment says "fail
  loudly rather than reaching for the network at boot," which is the right call
  but means a missing runtime dep is a hard start failure.

### Unbounded inputs on unauthenticated paths

- `PATCH /api/cart/items` validates `quantity: z.number().int().min(0)` — **no
  upper bound** ([items/route.ts:14](../../src/app/api/cart/items/route.ts#L14)).
  `POST` uses `.positive()`, also unbounded.
- `POST /api/products` validates `priceCents: z.number().int().positive()` — no
  upper bound ([schemas.ts:23](../../src/lib/api/schemas.ts#L23)).
- `lineSubtotal = unitPriceCents * quantity` ([engine.ts:26](../../src/lib/pricing/engine.ts#L26))
  and `percentOfBps(base, bps) = Math.floor((base*bps + 5000)/10000)`
  ([money.ts:21](../../src/lib/money.ts#L21)) both assume the product stays below
  `Number.MAX_SAFE_INTEGER`. `money.ts`'s comment states the assumption openly:
  "base is cents (<= ~1e9 in any realistic cart)." Nothing enforces it.
- `allocate(amount, weights)` computes `amount * weights[i]`
  ([allocate.ts:23](../../src/lib/pricing/allocate.ts#L23)) — the product of two
  already-large numbers.

### Resource boundaries `[F5-res]`

- `recommendationsFor()` issues `prisma.product.findMany({where: {active: true}})`
  — **the entire active catalog, unpaginated**, on every call
  ([recommend-service.ts:13](../../src/lib/recommend-service.ts#L13)). The cart
  page calls it on every render and again on every cart change
  (`refreshOnCartChange`). The staging script is designed to load "a large,
  varied, randomized catalog," so catalog size is an operator-controlled variable.
- No connection pool limit is configured; Prisma's SQLite default applies.
- Cart rows grow without bound and are never reaped (§7.4), and `GET /api/cart`
  creates one for any client without a cookie — including crawlers and health
  checks.

---

## 7. External dependencies and integration points `[F9]`

Deliberately none at runtime. No S3, no CDN, no Redis, no broker — `specs/01` §1
requires "no external services required" and `specs/02` §8 repeats it for images.
The only cross-process boundaries are:

- **Browser ↔ server** over HTTP. This is the only link Antithesis can partition
  or delay, and it is the one that matters.
- **Server ↔ filesystem** for both SQLite and uploads, both on the `/data` volume.
  Filesystem slowness and fsync behavior are in scope; network faults are not,
  because there is no network hop.
- **Container start ↔ npm registry** is explicitly severed by `npx --no-install`.

Consequence for topology: putting the SUT and the workload in separate containers
gives exactly one faultable link. Node throttling, node hang, CPU modulation, and
node termination are the levers that reach the SUT's internals; partitions and
bad-node faults only sever the client.

---

## 8. Existing test strategy `[F7]`

| Layer | Coverage | What it does not exercise |
|---|---|---|
| Vitest (`src/lib/**/*.test.ts`) | Strong on the pure engine: worked examples A/B/C verbatim, eligibility, clamping, tax, targeting, allocation including a randomized sum-to-whole property test, determinism across 100 shuffles, config parsing, admin-auth fail-closed, recommendation layering | Anything with I/O. No route handler is unit tested. No `PricedCart` produced by the API is ever checked. |
| Playwright (`e2e/*.spec.ts`) | Catalog, cart, coupons, admin API, recommendations, toasts — end to end through a real browser against a real build | `workers: 1`, `fullyParallel: false`. **Zero concurrency.** No fault injection. No restart test (`specs/02` §11 lists the persistence smoke test as "optional"). |

Where Antithesis adds value that these do not duplicate: everything in §4
(concurrency), §6 (degradation, unbounded inputs), and the durability half of §5.
Where it would duplicate: the pure engine arithmetic, the path-traversal regex,
and admin-auth fail-closed — all three are already covered deterministically and
have no timing dimension.

---

## 9. Bug history and density `[F6]`

There is no issue tracker in scope and the git history is four implementation
commits with no fix commits. The substitute source is the **defect table in
`shopping-cart-demo-spec.md`**, which lists ten defects found during spec review
and resolved before implementation. That is a design-review artifact, not a
runtime bug history — the defects were fixed in the spec, and no evidence in this
repo shows any of them ever manifesting in running code. They are useful as a map
of where the authors believed the hard parts were:

| Spec defect | Area | Regression risk it points at |
|---|---|---|
| #1 double-subtracted free shipping | shipping vs. discount separation | invariants 1 and 3 |
| #2 undefined "running discountable base" | allocation across stacked coupons | invariant 2 |
| #3 exclusive coupon won unconditionally | N+1 winner selection | S5, monotonicity |
| #4 missing `onDelete` cascade | product delete with live carts | S11 |
| #5 Dockerfile could not boot | startup sequence | L1 |
| #7 path traversal on the read route | upload serving | S13 |
| #8 admin key failing open | auth | S12 |
| #9 undefined behavior for a coupon that stops qualifying | prune lifecycle | S6, S7 |
| #10 slug collisions on repeat staging runs | slug allocation | S10 |

Two of these are directly relevant to the concurrency findings in §4: #10 is the
same slug-allocation weakness that `uniqueSlug` still exhibits within a single
bulk batch and across concurrent creates, and #9's prune rule is the mechanism
that `priceAndPrune`'s unguarded read-modify-write can violate.

**Suspiciously quiet:** the four check-then-act sequences in §4 appear in none of
the ten reviewed defects. Concurrency was not a review lens.

---

## 10. Unproven assumptions `[F11]`

These are implicit axioms the code is built on that nothing validates. In this
system they are the highest-yield Antithesis targets, because they are precisely
the conditions the authors never tested.

1. **"One shopper at a time."** Every check-then-act sequence in §4 is correct if
   and only if no two requests touching the same cart overlap. Nothing enforces
   or documents this. The only place the assumption is written down is
   `playwright.config.ts`, where it is enforced on the *test harness* instead.

   **Update, 2026-08-01:** the user confirmed multi-shopper access is out of
   scope, which makes this an accepted operating envelope rather than an unproven
   assumption. Note what that does *not* resolve: §4 shows the application issues
   overlapping requests against its own cart on every page load (two components
   fetching `/api/cart`, plus two `notifyCartUpdated()` calls per mutation), so
   "one shopper at a time" does not imply "one request at a time." The assumption
   is narrowed, not retired.
2. **"Money fits in a double."** Stated in a comment in `money.ts` and enforced
   nowhere (see §6).
3. **"Prisma calls do not fail."** No cart path has error handling. The
   implicit model is that SQLite either works or the process is dead.
4. **"A cart's coupon set has one writer."** `priceAndPrune` claims to be the
   funnel; `DELETE /api/cart/coupons` writes the column directly first, then
   calls `priceAndPrune`, which reads it back.
5. **"The cookie round-trips before the next request."** `resolveCartId` sets a
   cookie on the response; any request already in flight has not seen it.
6. **"Route-handler GETs are not cached."** `specs/01` §7.5 relies on a Next 15
   default rather than an explicit `export const dynamic = "force-dynamic"`. If
   that default changed, `GET /api/cart` could serve one shopper's cart to
   another — the code has no defence and no test.
7. **"The catalog is small."** `recommendationsFor` loads it whole, on a page the
   shopper hits constantly, while slice 2 exists specifically to make the catalog
   large.
8. **"Restart is safe at any point."** `entrypoint.sh` has no idempotency guard
   around `migrate deploy` beyond Prisma's own bookkeeping, which is what makes an
   interrupted migration sticky rather than self-healing.
9. **"`Set-Cookie` on a GET is harmless."** It makes an ostensibly safe method
   both state-creating and write-locking.

---

## 11. Wildcard observations `[F12]`

Run last, with awareness of what the eleven other passes covered.

**The read path is the write path, and nobody says so.** Focus 1 mapped
`GET /api/cart` as a read; focus 2 mapped `Cart.coupons` as state; focus 3 found
the unguarded read-modify-write. What none of them names is the *architectural*
oddity: this application has no read-only endpoint for its most-requested
resource. Every cart badge render, every prefetch, every crawler hit takes a
SQLite write lock and can create a row. The consequences (unbounded cart growth,
first-load cart-splitting, write amplification under load) all descend from one
design choice that no spec section discusses.

**The test suite is configured to be blind to the risk it documents.**
`playwright.config.ts` contains the clearest, most specific statement of the
system's central hazard anywhere in the repo — and immediately sets `workers: 1`
so the suite can never observe it. This isn't a criticism of the choice for a
test suite; it's an observation that the hazard has been named, mitigated in the
one place it was inconvenient, and left unmitigated in the one place it is real.

**"Best outcome wins" makes coupon state path-dependent in a way the spec
half-notices.** `specs/01` §5.6 records that removing an exclusive coupon does not
restore superseded stackables, and argues that "nothing of value was lost at
eviction time." The argument is about the eviction instant. It does not cover the
sequence: apply stackables → apply a better exclusive (stackables pruned) →
remove the exclusive. The cart now sits at a *higher* total than before the
exclusive was ever entered, with no record that anything was dropped. Whether
that is intended is a product question, but it is a concrete, reachable,
API-observable state transition — and one that concurrency makes worse, since a
prune from one request can evict a coupon another request just applied.

**Two independently-correct decisions combine into a fault line.** Focus 2 noted
the price snapshot (correct: admin edits don't reprice live carts). Focus 8 noted
that the entrypoint re-runs the idempotent seed on every start (correct: restarts
converge). Together: an admin's price edit to a *seeded* product is silently
reverted by any restart, while carts created before the restart keep snapshots of
the edited price. Nothing is wrong at either site; the composition produces a
catalog and a set of carts that disagree about history, and only a restart-aware
test would ever see it.

**`isBetter` tie-breaks on the candidate set, not the applied set.**
`candidateCodes` is `coupons.map(c => c.code)` — every code handed to the pass,
including ones that produced no discount line
([engine.ts:219](../../src/lib/pricing/engine.ts#L219)). `specs/01` §5.3 step 5
says the tie-break is "fewest coupons." If a stackable set of three coupons where
only one applies ties with a single exclusive, the exclusive wins on count even
though both applied exactly one coupon. Whether that matches intent is unclear
from the spec; flagged as an open question rather than a defect.

**Nothing in the system is time-sensitive except coupons.** `startsAt`/`endsAt`
are compared against `new Date()` inside `priceCart`
([engine.ts:242](../../src/lib/pricing/engine.ts#L242)). This is the sole clock
dependency in the SUT, which makes clock-jitter faults surgical here — they can
flip a coupon's eligibility mid-session and nothing else.

---

## Assumptions

- The SUT is the repository at commit `3f1a675`, deployed as the `Dockerfile`
  builds it (production `NODE_ENV`, `/data` volume, `ADMIN_API_KEY` set).
- "Concurrent shopper" means overlapping HTTP requests carrying the same or
  different `cartId` cookies against one server process. **Scope decision,
  2026-08-01:** the user confirmed that overlapping requests from *different*
  shoppers are out of scope. Overlapping requests generated by one shopper's own
  browser, and admin operations concurrent with one shopper, remain in scope. See
  the resolved bias B1 in `evaluation/synthesis.md`.
- The specs in `specs/`, `shopping-cart-demo-spec.md`, and `IMPLEMENTATION-PLAN.md`
  are the system's design documentation, per the user's "just this directory"
  scope answer. Their guarantees are treated as claims to test.

## Open Questions

- ~~Is concurrent multi-shopper access in scope?~~ **Resolved 2026-08-01: no.**
  Multi-shopper access is out of scope. §4's two-shopper findings are documented
  limitations (three properties demoted to P2); its single-shopper findings — the
  cart page's self-concurrency and the write amplification — remain in scope at
  full priority. See `evaluation/synthesis.md` B1.
- Does the deployed container mount `/data` as a durable volume in the Antithesis
  environment? Antithesis-restarted containers may lose non-durable filesystem
  state, which changes what `acked-cart-mutations-survive-restart` can claim.
  `(needs human input)`
- Are node-termination and clock-jitter faults enabled for this tenant? Four
  properties depend on them. `(needs human input)`
