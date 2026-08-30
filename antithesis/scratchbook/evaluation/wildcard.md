---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Evaluation Lens 4 — Wildcard

Run last, with awareness of the territory the other three lenses cover:

- **Lens 1, Antithesis Fit** — whether properties sit in Antithesis's sweet spot
  or in unit-test territory.
- **Lens 2, Coverage Balance** — whether the property set is the right portfolio
  against the SUT analysis.
- **Lens 3, Implementability** — whether each property can actually be checked
  given topology and observation surface.

This lens's job starts where theirs ends.

## Findings

### WC-1 — Gap: `GET /api/cart` is a write, and no property is about that fact

**Scope:** catalog-wide.

Coverage Balance found the resource-boundary gap and gap-filled it. That is the
symptom. The cause is a single architectural decision nobody in the specs
discusses, and once you see it, several catalog properties turn out to be
consequences of one thing rather than five separate things.

`GET /api/cart` calls `priceAndPrune`, which issues `cart.update` whenever the
applied coupon set differs from what is stored (`cart.ts:119-124`), and calls
`resolveCartId`, which creates a `Cart` row and sets a cookie when no usable one
exists (`cart.ts:46-47`).

So the application's most-requested endpoint:

- takes a **SQLite write lock** on a read,
- **creates persistent state** on a read,
- **sets a cookie** on a read.

None of the three specs mentions this. `specs/01` §7.2 describes cart resolution
as "if none, one is created and the cookie set" without noting that it happens on
GET, and §7.4 accepts unreaped carts on a model of one row per shopper.

Now count the write amplification. On the cart page, `CartPage` fetches
`/api/cart` (`cart/page.tsx:28`) and `CartBadge` in the root layout fetches it
too (`CartBadge.tsx:13`). Every mutation then fires `notifyCartUpdated()` twice —
once in `mutateCart` (`cart-events.ts:23`) and again in the cart page's `run()`
(`cart/page.tsx:59`) — each triggering another badge refresh. A single "add to
cart" click produces one write plus several more write-locking GETs.

The catalog properties this explains: `single-cart-per-session` (both concurrent
GETs create carts), `cart-rows-bounded-by-distinct-clients` (growth on a read),
`cart-coupon-set-atomic` (badge refreshes are unsynchronized writers),
`cart-endpoints-never-unhandled-500` (amplified lock contention). Four properties,
one root cause.

**Suggested action:** two parts.

1. Ensure the growth consequence has a property.
   **Applied** — `cart-rows-bounded-by-distinct-clients` was added from this
   finding, and `sut-analysis.md` §11 records the observation.
2. Record in `property-relationships.md` that these four share a root cause, so a
   triage pass does not chase them as independent bugs.
   **Applied** — clusters 1 and 6, plus the shared-instrumentation notes.

### WC-2 — Bias: the concurrency question is unresolved and it governs the catalog

**Scope:** catalog-wide. **Escalated to the user — RESOLVED 2026-08-01: multi-shopper
access is out of scope.** See `synthesis.md` B1 for what was applied. The analysis
below is preserved as the record of why the question was asked; the prediction in
its closing paragraph — that a "no" narrows category A without emptying it — is
what the resolution bore out. Three of five properties demoted, two kept at full
priority.

Fourteen of 24 properties exist because concurrent access to one cart is
unguarded. If concurrent shoppers are out of scope for this demo, most of
category A and parts of C and E are documentation of a known limitation rather
than bug hunts, and their priority collapses.

The evidence that the question is genuinely open, not merely unanswered:

**The project named the hazard precisely.** `playwright.config.ts:11-17`, repeated
in `specs/01` §12.1:

> "SQLite is single-writer. Parallel workers hitting one database file produce
> `SQLITE_BUSY` errors that surface as intermittent, plausible-looking pricing
> bugs. If this suite ever gets slow enough to matter, the fix is WAL mode plus a
> busy timeout — **NOT** more workers."

That is a better statement of the risk than anything in this evaluation.

**Then mitigated it in the test harness only.** `workers: 1`,
`fullyParallel: false`. Correct for a test suite. It also means the suite is now
configured so it cannot observe the failure mode its own comment describes.

**And left the application unmitigated.** No WAL, no `busy_timeout`, no
transaction around any cart read-modify-write, no error handling, no rate limit,
and no constraint on how many browsers reach `:3000`.

**With no scope statement either way.** `specs/01` §1's non-goals rule out
accounts, payments, inventory, and shopper auth. Concurrency is not mentioned.
None of the ten reviewed defects in `shopping-cart-demo-spec.md` is a concurrency
defect, confirming it was never a review lens.

So: the authors knew SQLite is single-writer, fixed the one place it inconvenienced
them, and never stated whether the served application is meant to handle more than
one shopper at a time. That is a real judgment call, and it is the user's.

**What each answer implies:**

| If concurrency is **in scope** | If it is **out of scope** |
|---|---|
| Category A is the highest-value work in the catalog. The mechanisms are unguarded and the failures are silent. | Category A drops to P2 and becomes a documented-limitation report rather than a bug hunt. |
| The SUT likely needs transactions around `priceAndPrune` and an upsert/increment on cart items before testing is even interesting. | Focus shifts to categories B, D, and G — pricing correctness, durability, and resource growth — which hold regardless of concurrency. |
| `single-cart-per-session` matters most, since it fires on a first page load with no unusual behavior at all. | `single-cart-per-session` still matters, because it needs only one shopper — the cart page issues two concurrent GETs by itself. |

That last row is the part worth emphasizing when presenting this: even under the
narrowest reading of "one shopper at a time," the application generates concurrent
requests against its own cart on every page load. A decision to exclude
concurrency does not make `single-cart-per-session` go away.

**Suggested action:** present to the user with this evidence. Not resolvable from
the repository.

### WC-3 — Two individually-correct decisions compose into an invisible fault line

**Scope:** property-specific, cross-cutting.

Neither of these is a defect on its own, and no single-focus review would connect
them:

- `CartItem.unitPriceCentsSnapshot` is captured once and never refreshed
  (`items/route.ts:43`, `cart.ts:107`). Deliberate, documented in `specs/01`
  §4.1, and correct: admin price edits must not reprice live carts.
- `docker/entrypoint.sh` runs `prisma db seed` on **every** container start, and
  `prisma/seed.ts:21-25` upserts with an `update` payload that includes
  `priceCents`. Deliberate, documented, and correct: the seed's idempotence is
  what makes restarts converge.

Compose them: an admin's price edit to a *seeded* product is silently reverted by
any restart, while carts created before the restart keep snapshots of the edited
price. The catalog and the carts now disagree about what the price ever was, and
the admin's 200 response was truthful at the time.

Only a restart-aware test sees this, which means only a run with node-termination
faults enabled sees it.

**Suggested action:** fold into `price-snapshot-immutable` as the restart variant
rather than creating a separate property — the observation is about the snapshot's
meaning, not a distinct guarantee.
**Applied** — the evidence file has a "restart window" section, and the catalog
entry carries `[needs node-termination]`.

### WC-4 — Odd, reported without a confident explanation: `isBetter` counts candidates, not applications

**Scope:** property-specific, low confidence.

`isBetter` breaks total-ties on `candidate.candidateCodes.length`
(`engine.ts:232`), and `candidateCodes` is `coupons.map((c) => c.code)`
(`engine.ts:219`) — every code *handed to* the pass, including ones that produced
no discount line.

`specs/01` §5.3 step 5 says the tie-break is "fewest coupons." Two readings:

- fewest coupons *considered* (what the code does), or
- fewest coupons *applied* (arguably what a shopper would mean).

They differ when a stackable set contains coupons that don't apply. A three-coupon
stackable set where only one applies loses a tie to a single exclusive that also
applies one.

This cannot violate `applying-coupon-never-raises-total` — on a tie the totals are
equal by definition. It changes which set is *persisted*, which changes what a
later removal falls back to, which is `coupon-removal-is-reversible`'s subject.

I cannot tell from the spec which reading was intended, and the difference only
manifests on an exact tie between sets of different sizes — narrow enough that it
may never arise with the seeded coupon set.

**Suggested action:** record it in the two evidence files it touches rather than
raising it as a finding requiring action. It is a signal, not a defect.
**Applied** — noted in `applying-coupon-never-raises-total.md`,
`coupon-removal-is-reversible.md`, `exclusive-coupon-wins-observed.md`, and
`sut-analysis.md` §11.

### WC-5 — Questioning the frame: what the catalog assumes about who is calling

Every property models the client as a shopper or an admin. The system does not
require that.

`GET /api/cart`, `GET /api/products`, `GET /api/recommendations`, and
`GET /uploads/[filename]` are all unauthenticated, and the first creates
persistent state. There is no `robots.txt`, no rate limit, and no user agent
check. A crawler, a link prefetcher, or an uptime monitor is a first-class client
of this API and behaves nothing like a shopper — no cookie persistence, high
request rate, no mutations.

Coverage Balance's gap-fill produced `cart-rows-bounded-by-distinct-clients`,
which covers the growth consequence. What remains unmodeled is the *workload
shape*: the catalog's virtual shoppers all keep cookies and all follow
shopper-like sequences.

**Judgment: not worth another property.** The distinct failure mode — unbounded
row growth from cookie-less clients — is already the subject of
`cart-rows-bounded-by-distinct-clients`. What is worth carrying forward is a
workload-design note: include at least one cookie-less, high-rate client in the
mix, so that property is exercised by something other than fault-stranded
cookies.

**Suggested action:** carry as a workload-design note to `antithesis-workload`
rather than a catalog change.

## Passes

- The catalog's property set is not obviously missing a category once WC-1's root
  cause and Coverage Balance's two gaps are addressed.
- The SUT analysis holds up under questioning. Its §11 wildcard section
  independently identified WC-1 and WC-3, which is a good sign that discovery and
  evaluation are not just agreeing with each other by construction.
- No property in the catalog rests on a claim from a bug report — there is no
  issue tracker in scope, and the ten defects in `shopping-cart-demo-spec.md` are
  correctly treated as a design-review artifact mapping where the authors thought
  the hard parts were, not as evidence of runtime bugs. `sut-analysis.md` §9 says
  so explicitly.

## Uncertainties

- WC-2 is unresolvable here by construction. It is a product-scope decision.
- WC-4's intended tie-break semantics cannot be recovered from the specs.
- Whether the demo is ever deployed anywhere reachable by more than one person.
  `specs/02` §2.2 says the staging script "explicitly targets 'local **or a
  deployed container**', so a reachable instance is a scenario this spec plans
  for" — which is the strongest evidence in the repo that multi-client access was
  contemplated, though it appears in a section about credential safety rather
  than concurrency.
