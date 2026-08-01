---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Deployment Topology

## Summary

**Two containers.** The SUT is a single self-contained process with no external
services (`sut-analysis.md` §7), so the minimal useful topology is the SUT plus a
workload client.

```text
+--------------------------+                      +---------------------------+
| workload                 |  HTTP :3000          | demo-shop                 |
| (test driver + client)   | -------------------> | Next.js standalone server |
|                          | <------------------- | + SQLite on /data volume  |
| /opt/antithesis/test/v1/ |   PricedCart JSON    | + uploads on /data volume |
+--------------------------+                      +---------------------------+
```

That is the whole system. Adding anything else would be inventing infrastructure
the application does not have.

## Components

### `demo-shop` — service

| | |
|---|---|
| **Image source** | The repository's existing `Dockerfile`, with additions listed below |
| **Role** | Service (the SUT) |
| **Runs** | `docker/entrypoint.sh` → `prisma migrate deploy`, `prisma db seed`, `exec node server.js` |
| **Listens** | `:3000` (`ENV PORT=3000`, `ENV HOSTNAME=0.0.0.0`) |
| **Replicas** | 1 |
| **Connections** | Accepts HTTP from `workload`. Makes no outbound connections. |
| **Volume** | `/data` — **must be durable**. Holds `app.db` and `uploads/`. |

The existing multi-stage Dockerfile is sound and should be reused rather than
replaced: it builds Next standalone output on `node:20-slim`, copies the Prisma
query engine explicitly, and installs `prisma` and `tsx` as genuine runtime
dependencies so `npx --no-install` at boot needs no network. `specs/01` §10
explains each of those choices, and each addresses a real container failure mode.

**Required environment:**

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Activates the entrypoint's admin-key fail-closed check |
| `ADMIN_API_KEY` | a fixed non-default test value | Without it, `requireAdmin` rejects everything and the entire admin surface — six catalog properties — is untestable |
| `DATABASE_URL` | `file:/data/app.db` | Dockerfile default; keep |
| `UPLOAD_DIR` | `/data/uploads` | Dockerfile default; keep |
| store config | Dockerfile/`.env.example` defaults | `TAX_RATE_BPS=800`, `SHIPPING_FLAT_CENTS=599`, `FREE_SHIPPING_THRESHOLD_CENTS=5000`. The workload must know these to construct carts that cross the free-shipping threshold and `TAKE15`'s min-spend — see `coupon-prune-path-observed`. |

**Required Dockerfile additions:**

1. **Antithesis SDK.** No SDK is present (`existing-assertions.md`). The SUT
   needs the JavaScript SDK for the SUT-side instrumentation the evidence files
   call for — the highest-value points being `cart.ts:119`, `engine.ts:265`, and
   `cart.ts:46`.
2. **Shell-level assertions in the entrypoint.**
   `startup-crash-never-bricks-container` cannot be checked from the workload:
   from outside the container, "still starting" and "bricked" are
   indistinguishable. The entrypoint needs markers around `migrate deploy` and
   before `exec node server.js`.
3. **Coverage instrumentation.** Required for thread-pausing faults
   (`references/faults.md`). Worth enabling — the whole of category A depends on
   exploring interleavings at `await` boundaries.

### `workload` — client

| | |
|---|---|
| **Image source** | New Dockerfile, `node:20-slim` base (matches the SUT's runtime, and the workload shares TypeScript types with it) |
| **Role** | Client |
| **Runs** | Emits `setup_complete` once the SUT answers, then stays alive for test commands |
| **Replicas** | 1 |
| **Connections** | HTTP to `demo-shop:3000` |
| **Test template** | `/opt/antithesis/test/v1/shop/` |

A `node:20-slim` base lets the workload import the SUT's own pure modules
directly — `src/lib/pricing/invariants.ts` for the seven invariant checks and
`src/lib/pricing/types.ts` for the `PricedCart` shape. Those are pure, dependency
-free TypeScript, and reusing them means the assertions check the same definitions
the SUT was built against rather than a hand-copied restatement.

**Readiness:** the workload must wait for the SUT before emitting
`setup_complete`. The SUT has no health endpoint (`sut-analysis.md` §6);
`playwright.config.ts` polls `GET /api/products` as a liveness proxy and that is
the right precedent — it exercises the database, so a 200 means migrations ran
and the seed completed. Note this is a *pre*-test-template readiness signal, not
a `first_` command.

**Cookie handling is load-bearing.** Several properties are about cart identity:

- Each virtual shopper owns an explicit cookie jar the workload controls.
- The jar must **record** every `Set-Cookie` rather than silently applying
  last-write-wins the way a browser does — `single-cart-per-session` measures
  precisely that overwriting, so a client that hides it makes the property
  undetectable.

**Shopper model — revised by the scope decision of 2026-08-01.**

Multi-shopper access is out of scope, so the workload models **one shopper per
cart**. It does *not* fan multiple virtual shoppers at a single `cartId`. That
removes what was previously the most awkward constraint on workload design: there
is no longer a "concurrent shopper pool" that must be kept off the serialized
pool's carts.

What remains, and must be built deliberately:

- *Serialized shopper* — the default. One request at a time per cart. Satisfies
  the preconditions of `applying-coupon-never-raises-total`,
  `coupon-removal-is-reversible`, and `price-snapshot-immutable` for free.
- *Browser-faithful shopper* — replays the concurrency the **application itself**
  generates, which is still in scope. Specifically: on first contact, issue the
  two `/api/cart` fetches the cart page's mount produces (`CartPage` +
  `CartBadge`) without ordering them; after every mutation, issue the two badge
  refreshes the double `notifyCartUpdated()` produces. This is what exercises
  `single-cart-per-session` and supplies the `SQLITE_BUSY` contention behind
  `cart-endpoints-never-unhandled-500`. A workload that politely serializes
  everything will find neither.
- *Admin operator* — issues catalog and coupon mutations while a shopper is
  active. Still in scope and unchanged; drives all of category C.
- *Cookie-less client* — a low-volume crawler-shaped caller for
  `cart-rows-bounded-by-distinct-clients`.

The three demoted category A properties (`cart-coupon-set-atomic`,
`cart-item-quantity-no-lost-update`, `cart-item-create-no-unique-violation`) retain
narrow single-shopper triggers — the toast Undo callback firing outside the cart
page's `busy` guard, and per-component `busy` flags on `AddToCartButton`. A
browser-faithful shopper reaches those incidentally; the workload need not
construct them deliberately at P2.

## Why not more containers

| Considered | Verdict |
|---|---|
| Separate database container | The database is a file inside the SUT process (`sut-analysis.md` §3). There is no network protocol to fault and no image that would speak it. Extracting it would test a system that does not exist. |
| Separate uploads/object store | Same — uploads are `node:fs` writes to the same volume. `specs/02` §8 rules out S3 and CDNs explicitly. |
| Multiple SUT replicas | The app has no clustering, no shared-nothing story, and a single-writer SQLite file. Two replicas on one volume would produce corruption unrelated to any property. Two replicas on separate volumes would be two independent shops. |
| Separate admin client | Admin operations are HTTP calls with a header. The workload issues them. A second container would only remove the ability to interleave admin writes with shopper traffic — which is exactly what category C tests. |
| A browser container | Every property is checked at the HTTP boundary. Playwright already covers the browser layer deterministically. Adding a browser would add a large, slow container and no property coverage. |

## Fault surface, and its honest limits

Because the SUT is one process with one internal filesystem, the fault types
split cleanly:

**Effective:**

- **Node throttling / CPU modulation** — the primary levers. They widen every
  read-to-write window in `sut-analysis.md` §4 and lengthen SQLite lock holds,
  which is what categories A and E depend on.
- **Thread pausing** — reorders continuations at `await` boundaries. Requires
  coverage instrumentation.
- **Node hang** — freezes the SUT mid-operation; feeds `cart-eventually-readable`.
- **Node termination** — required by `acked-cart-mutations-survive-restart`,
  `startup-crash-never-bricks-container`, and the seed-revert half of
  `price-snapshot-immutable`. **Commonly disabled by default; confirm.**
- **Clock jitter** — surgical here. `new Date()` at `engine.ts:242` is the SUT's
  only clock dependency, so a jump flips coupon `startsAt`/`endsAt` eligibility
  and nothing else. **Commonly disabled by default; confirm.**

**Ineffective, and worth saying so:**

- **Network partitions and bad-node faults** can only sever the workload from the
  SUT. There is no inter-service link to partition. They exercise the workload's
  error handling, not the SUT's — with one exception worth keeping: a dropped
  *response* after a committed write is what makes
  `cart-mutation-applied-at-most-once` meaningful.

**Custom faults worth adding:** the admin API is a natural custom-fault surface —
periodically deleting a coupon, deactivating one, or PATCHing a product price
while shoppers are active. That drives category C without the workload having to
schedule it, and it produces interleavings the workload would not construct
deliberately.

## SDK selection

| Where | SDK | For |
|---|---|---|
| `workload` | Antithesis JavaScript SDK | All workload-side assertions — the bulk of the catalog |
| `demo-shop` (Node) | Antithesis JavaScript SDK | SUT-side markers at `cart.ts:119`, `cart.ts:46`, `engine.ts:265`, `allocate.ts:23`/`:36` |
| `demo-shop` (entrypoint) | SDK shell entry point, or a Node one-liner | `startup-crash-never-bricks-container` markers in `/bin/sh` |

SDK assertions do not crash the process on failure and are designed to be
low-overhead or no-ops outside Antithesis, so the SUT-side markers are safe to
leave in the application code rather than maintaining a fork.

## Recommended SUT addition: a health endpoint

Not required, but it improves three properties and costs a few lines. A
`GET /api/health` returning `{ ok: true, startedAt: <process start timestamp> }`
would let the workload:

- distinguish "process is up but the cart path is broken" from "process is down"
  (`cart-eventually-readable`),
- detect restarts exactly rather than inferring them from connection failure
  (`acked-cart-mutations-survive-restart`),
- separate "still starting" from "bricked"
  (`startup-crash-never-bricks-container`).

Flagged for the `antithesis-setup` stage as a decision, since it is a change to
the SUT rather than to the test harness.

## Assumptions

- The SUT is deployed from the repository's `Dockerfile` at commit `3f1a675`,
  with the three additions above.
- `/data` is a durable volume. If it is not, `acked-cart-mutations-survive-restart`
  tests the harness rather than the SUT — see that property's open questions.
- One SUT replica is correct because the application has no clustering story.

## Open Questions

- Is `/data` configured as a durable volume in the Antithesis environment?
  `(needs human input)`
- Are node-termination and clock-jitter faults enabled for this tenant? Three
  properties and one property-variant depend on them. `(needs human input)`
- Should a `/api/health` endpoint be added to the SUT? It is a code change, not a
  harness change. `(needs human input)`
- Should the workload be permitted to use the admin API to create products with
  extreme `priceCents` values, or should `money-fields-stay-exact` be restricted
  to the quantity-driven path (which needs no admin key)? `(needs human input)`
