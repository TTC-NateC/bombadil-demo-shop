---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Evaluation Lens 2 — Coverage Balance

Not "is each property good" but "is this the right set?" Read against
`sut-analysis.md` section by section.

## Risk-area coverage matrix

| SUT analysis area | Risk | Properties | Verdict |
|---|---|---|---|
| §4 concurrency — four check-then-act sequences | Highest | 8 | Proportionate |
| §5 claimed guarantees S1-S15 | High | 11 of 15 claims covered | See CB-3 |
| §6 no error handling | High | 3 | Proportionate |
| §6 unbounded inputs | Medium | 1 (`money-fields-stay-exact`) | Proportionate |
| §6 resource boundaries | Medium | 0 → **2 after gap-fill** | See CB-1 |
| §3 durability, §6 startup sequence | Medium | 3 | Proportionate |
| §10 unproven assumptions (9 listed) | High | 7 of 9 covered | See CB-4 |
| Uploads / image serving | Low | 0 | Correct — see CB-5 |
| Recommendations | Medium | 0 → **1 after gap-fill** | See CB-1 |
| Pure engine arithmetic | Low (well tested) | 0 checks, 1 marker | Correct |

## Findings

### CB-1 — Gap: the two unbounded growth paths had no properties

**Scope:** catalog-wide.

`sut-analysis.md` §6 identifies resource boundaries as a risk area and names two
specific mechanisms. Discovery produced zero properties for either.

**Evidence, mechanism 1 — the recommendations query.**
`recommend-service.ts:13` issues `prisma.product.findMany({where: {active: true}})`
with no `take`. The pure ranking then makes two more full copies and two full
sorts of the catalog (`recommend.ts:80`, `recommend.ts:91`) plus an
O(sources × catalog) filter at `recommend.ts:84`. The cart page calls this on
load and on every cart change (`cart/page.tsx:300-304`, `refreshOnCartChange`).
Slice 2 exists specifically to make the catalog large, and both endpoints are
unauthenticated (`specs/03` §2.3). This is the slowest path in the system, on the
page shoppers use most, with no pagination, no cap on input size, and no timeout.

**Evidence, mechanism 2 — cart row growth.** `cart.ts:46` creates a `Cart` row for
any request without a usable cookie, reachable via `GET /api/cart`, and
`specs/01` §7.4 states carts are never reaped. Three mechanisms decouple row
count from shopper count: the concurrent first-contact race, clients that don't
persist cookies, and cookie loss after a reset or restart.

Both mechanisms are named in the SUT analysis. Neither had a property.

**Why discovery missed them:** the focus set that produced this catalog was
oriented toward correctness — data integrity, concurrency, protocol contracts.
Resource exhaustion is a different question about the same code, and it fell
between focuses. This is one of the gap patterns
`references/property-evaluation.md` names explicitly.

**Suggested action:** targeted discovery for resource boundaries.
**Applied** — produced `recommendations-stay-responsive` and
`cart-rows-bounded-by-distinct-clients`, now category G in the catalog.

### CB-2 — Gap: all-or-nothing was checked from the writer's side only

**Scope:** property-specific, but a pattern worth naming.

`bulk-product-create-atomic` checks whether the batch returned 201 with
`created === N` or 4xx with nothing created. That is the writer's view.
`specs/02` §4 states the guarantee without specifying whose view it applies to,
and the reader's view is a distinct question: what does `GET /api/products`
return while the transaction is open?

This matters more than it first appears because `recommend-service.ts:13` is a
high-frequency full-catalog reader that computes a deterministic ranking over
whatever it gets — a partial batch produces a recommendation set that is stable,
plausible, and wrong.

**Suggested action:** add a reader-side property.
**Applied** — `catalog-read-never-shows-partial-batch`, category C. Note the
Antithesis Fit lens flags it as possibly vacuous (AF-4); both lenses agree it is
cheap enough to keep at P2 with the vacuity risk documented.

### CB-3 — Claimed guarantees: four of fifteen uncovered, three correctly

**Scope:** catalog-wide, informational.

Cross-checking `sut-analysis.md` §5's claim table against the catalog:

| Claim | Covered by |
|---|---|
| S1-S4 (invariants, allocation, no-negative) | `priced-cart-invariants-hold`, `money-fields-stay-exact` |
| S5 (never penalised) | `applying-coupon-never-raises-total` |
| S6-S7 (prune, rejectedCoupons meaning) | `persisted-coupons-match-discount-lines`, `coupon-mutation-leaves-cart-consistent`, `coupon-prune-path-observed` |
| S8 (nothing of value lost) | `coupon-removal-is-reversible` |
| S9 (price snapshot) | `price-snapshot-immutable` |
| S10 (bulk all-or-nothing) | `bulk-product-create-atomic`, `catalog-read-never-shows-partial-batch` |
| S11 (delete cascades) | `product-delete-cascades-cleanly` |
| L1-L3 (boot, seed idempotence, restart survival) | `startup-crash-never-bricks-container`, `acked-cart-mutations-survive-restart` |
| L4 (recommendations never empty) | `recommendations-stay-responsive` (partially — covers the bound and completion, not non-emptiness) |
| **S12 (admin fail-closed)** | **none — correct**, `admin-auth.test.ts` covers all branches deterministically |
| **S13 (path traversal 404)** | **none — correct**, `e2e/admin-api.spec.ts` covers it; no timing dimension |
| **S14 (engine determinism)** | **none — correct**, `engine.test.ts` tests 100 shuffled inputs |
| **S15 (no stale reads / no caching)** | **none — see below** |

S15 is the one uncovered claim that is not obviously correct to skip. `specs/01`
§7.5 relies on Next 15's default of not caching route-handler GETs, rather than
an explicit `export const dynamic = "force-dynamic"`. `sut-analysis.md` §10
assumption 6 notes the consequence: if that default ever changed, `GET /api/cart`
could serve one shopper's cart to another, and the code has no defence and no
test.

Judged **not** worth a property: it is a framework-version property, not a
system-behavior property. Antithesis cannot change Next's default, so a property
would assert something no fault can influence. It belongs in the SUT analysis as
an unproven assumption — where it is — rather than the catalog.

### CB-4 — Unproven assumptions: seven of nine covered

`sut-analysis.md` §10 lists nine. Covered: 1 (one shopper at a time — all of
category A), 2 (money fits in a double), 3 (Prisma calls don't fail), 4 (one
writer for the coupon set), 5 (cookie round-trips), 7 (catalog is small — after
gap-fill), 8 (restart is safe at any point), 9 (Set-Cookie on GET is harmless —
after gap-fill).

That is actually eight. Uncovered: assumption 6 (route-handler GETs are not
cached), which is CB-3's S15, correctly excluded.

Good coverage of the highest-yield category in the analysis.

### CB-5 — Component distribution, and one deliberate zero

| Component | Properties |
|---|---|
| Cart / pricing (`src/lib/cart.ts`, `src/lib/pricing/`, `src/app/api/cart/`) | 14 |
| Admin API (`src/app/api/products/`, `src/app/api/coupons/`) | 4 |
| Recommendations | 1 |
| Lifecycle (`docker/entrypoint.sh`, restart) | 3 |
| Uploads (`src/lib/uploads.ts`, `src/app/uploads/`) | **0** |

The concentration on cart/pricing is correct — the user scoped this run to the
cart/checkout core, and `sut-analysis.md` §4 shows that is also where the
mechanism density is.

The upload zero is deliberate and correct. `storeUpload` derives the extension
from the validated MIME type rather than the client filename, generates the name
server-side with `randomUUID`, and the read route uses a single-segment route
with a strict regex plus resolve-containment. All of it is input validation with
no timing dimension, and `e2e/admin-api.spec.ts` covers the negative cases. One
observation recorded rather than cataloged: `writeFile` at `uploads.ts:75` is not
atomic (no write-to-temp-then-rename), so a crash mid-write leaves a truncated
image. Impact is a broken image on a demo page — not worth a property, and
`price-snapshot-immutable` already carries the node-termination cost.

### CB-6 — Assertion-type balance

By primary assertion type across the 24 properties: 19 `Always`, 2 `Sometimes`,
3 `Reachable` — plus one additional `Reachable` paired inside
`startup-crash-never-bricks-container`. (Several `Always` properties expand into
multiple assertions with distinct messages: `priced-cart-invariants-hold` is seven
and `cart-endpoints-never-unhandled-500` is three.)

`references/property-evaluation.md` warns that a catalog of all-`Always` is
probably missing liveness. This catalog is `Always`-heavy but not exclusively so,
and the reason is structural rather than an oversight: the SUT has no consensus,
no replication, no queues, no background jobs, and no async work of any kind.
Its guarantees are overwhelmingly safety-shaped. The two liveness properties
(`cart-eventually-readable`, `startup-crash-never-bricks-container`) cover the
only two genuine progress questions the system raises — does it recover from a
fault, and does it recover from a crash during startup.

The three `Reachable` markers are well-targeted at the branches whose absence
would make category B vacuous. No action.

## Passes

- Every high-risk area in `sut-analysis.md` has proportionate coverage after
  gap-filling.
- No low-risk area is over-invested. Uploads at zero is the clearest example of
  correct restraint.
- The claim table is 11/15 covered with three of the four omissions verified as
  correct deterministic-test territory and the fourth (S15) reasoned about
  explicitly.
- Property distribution matches the user's stated scope (cart/checkout core).

## Uncertainties

- Whether `recommendations-stay-responsive` should be split into a bound check
  (cheap, `Always`) and a completion/latency check (needs a workload timeout
  policy this evaluation did not specify). Left as one property; the workload
  design stage can split it if the timeout policy warrants.
- Whether L4 ("recommendations never empty") deserves its own assertion. The
  fallback layer makes emptiness nearly unreachable with a non-empty catalog, so
  it would likely be a vacuous `Always`. Not added.
