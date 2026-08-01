---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Property Evaluation — Synthesis

Four lens passes over the property catalog: Antithesis Fit, Coverage Balance,
Implementability, and Wildcard. Findings below are categorized as **Refinement**
(fix is clear, applied directly), **Gap** (something missing, filled by targeted
discovery), or **Bias** (needs human judgment, escalated).

Lens evidence: [`antithesis-fit.md`](antithesis-fit.md),
[`coverage-balance.md`](coverage-balance.md),
[`implementability.md`](implementability.md), [`wildcard.md`](wildcard.md).

## Outcome at a glance

| Category | Count | Status |
|---|---|---|
| Refinement | 8 | All applied |
| Gap | 3 | All filled — catalog grew 21 → 24 |
| Bias | 1 | **Resolved 2026-08-01 — see B1 below** |

## Refinements (applied)

### R1 — Split `cart-endpoints-never-unhandled-500` into three assertions
*From IM-1.* One assertion covering three endpoint families reuses a single
message across unrelated call sites, which `references/property-catalog.md`
prohibits, and reports "a cart endpoint 500'd" without saying which. The three
routes fail for different reasons (P2002/P2003, P2025, contention).
**Applied** to the catalog entry and evidence file.

### R2 — Restate `cart-mutation-applied-at-most-once` as an interval
*From IM-2.* An equality (`observed === acked`) false-positives whenever a
network fault drops a response after the write commits — the workload genuinely
cannot know whether it landed. The interval `acked <= observed <= attempted`
encodes that irreducible uncertainty; the upper bound carries the real content.
**Applied**, with the reasoning written into the evidence file.

### R3 — Mark fault-dependent properties and record their preconditions
*From IM-3.* `acked-cart-mutations-survive-restart` and
`startup-crash-never-bricks-container` need node-termination faults;
`coupon-mutation-leaves-cart-consistent`'s clock variant needs clock jitter. Both
are commonly disabled by default. Additionally, the restart property requires
`/data` to be a durable volume, or it tests the harness rather than the SUT.
**Applied** — `[needs node-termination]` / `[needs clock-jitter]` tags in the
catalog, open questions on the properties, and the volume requirement carried into
`deployment-topology.md`.

### R4 — Raise `single-cart-per-session` from P2 to P1
*From AF-5.* It reads like a cosmetic first-load nit. It fires on an ordinary
first page load (the cart page mounts two components that both fetch
`/api/cart`), its consequence is a shopper's items landing in a cart no cookie
points at, and it seeds the unbounded-growth mechanism in
`cart-rows-bounded-by-distinct-clients`. **Applied.**

### R5 — Scope `allocation-remainder-distributed` honestly and move its instrumentation
*From AF-2.* `allocate.test.ts` already has a randomized sum-to-whole property
test, so this is not hunting arithmetic bugs — it confirms the integration path
reaches multi-line uneven allocation. Also, the workload cannot recover the
running base from a multi-coupon response, so the SUT-side placement at
`allocate.ts:36` (where `leftover > 0` is directly known) is strictly better.
**Applied** — "Honest scoping" section in the evidence file, and the SUT-side
placement recommended.

### R6 — State the fuzzing-vs-timing limitation on `money-fields-stay-exact`
*From AF-3.* The trigger is input magnitude, not interleaving. Kept at P1 because
the interesting failures need a *combination* (large subtotal + multi-line
allocation + a maximising percentage) that Antithesis's search explores and a
hand-written test does not, and because the assertion rides free on responses the
workload already checks. **Applied** — "Why this is an Antithesis property and not
just a unit test" section.

### R7 — Record `persisted-coupons-match-discount-lines`'s observation limit
*From IM-7.* `Cart.coupons` is not in the API shape and no debug route exposes it
(verified by enumerating `src/app/api/`). The two-GET comparison detects
self-correcting divergence but not a divergence stable across passes.
**Applied** — limitation stated, SUT-side alternative recorded, open question
tagged `(partial: ...)` with an investigation log.

### R8 — Carry workload-design constraints into the topology
*From IM-5, IM-6, IM-8, IM-9.* Four constraints that would silently void
properties if missed: the workload must own explicit cookie jars that *record*
overwrites; serialized and concurrent shopper pools must not share carts; the
admin key must reach the workload container; and the store config values must be
known so the workload can cross coupon thresholds.
**Applied** — all four in `deployment-topology.md`, and the serialization
constraint also in `property-relationships.md` as a cross-cluster note.

## Gaps (filled)

### G1 — Resource boundaries had zero properties
*From CB-1.* `sut-analysis.md` §6 names two unbounded growth mechanisms and
discovery produced no property for either. The discovery focus set was
correctness-oriented, and resource exhaustion fell between focuses — one of the
gap patterns `references/property-evaluation.md` names.

**Filled with two properties** (new category G):

- `recommendations-stay-responsive` — `recommend-service.ts:13` loads the entire
  active catalog unpaginated on every call, from the page shoppers use most, on an
  unauthenticated endpoint, while slice 2 exists specifically to make the catalog
  large.
- `cart-rows-bounded-by-distinct-clients` — `cart.ts:46` creates a row on a
  **GET**, carts are never reaped (`specs/01` §7.4), and three mechanisms decouple
  row count from shopper count.

### G2 — All-or-nothing was only checked from the writer's side
*From CB-2.* `bulk-product-create-atomic` checks the response; nobody checked what
a concurrent `GET /api/products` sees while the transaction is open. Matters
because `recommend-service.ts` is a high-frequency full-catalog reader that ranks
deterministically over whatever it gets — a partial batch yields a recommendation
set that is stable, plausible, and wrong.

**Filled with** `catalog-read-never-shows-partial-batch` (P2). Both this lens and
Antithesis Fit (AF-4) agree it may be vacuous under the current SQLite
configuration; kept because it is nearly free, correct regardless, catches a
different bug if `$transaction` is ever replaced, and becomes live if WAL is
enabled — which both `specs/01` §12.1 and `playwright.config.ts` name as the
recommended fix for the contention problem.

### G3 — `GET /api/cart` is a write, and nothing was about that fact
*From WC-1.* The root cause behind four separate catalog properties: the
most-requested endpoint takes a write lock, creates persistent state, and sets a
cookie — none of it discussed in any spec. Write amplification compounds it: a
single "add to cart" click produces one write plus several more write-locking
GETs, because `notifyCartUpdated()` fires twice per mutation and `CartBadge`
re-fetches on each.

**Filled by** `cart-rows-bounded-by-distinct-clients` (shared with G1) for the
growth consequence, plus recording the shared root cause in
`property-relationships.md` clusters 1 and 6 so triage does not chase four
independent bugs.

## Bias (resolved)

### B1 — Is concurrent multi-shopper access in scope for this demo?

> **RESOLVED 2026-08-01. User decision: multi-shopper access is not in scope.**
>
> **Applied as follows.**
>
> Three properties demoted P0 → P2 and reframed as documented limitations, each
> retaining a narrow single-shopper path recorded in its evidence file:
> `cart-coupon-set-atomic` (toast-Undo callback outside the page's `busy` guard;
> two tabs sharing the cookie), `cart-item-quantity-no-lost-update` and
> `cart-item-create-no-unique-violation` (per-component `busy` flags, so a product
> card, a recommendation card, and the Undo action are independent instances).
>
> Two category A properties kept full priority because neither ever needed a
> second shopper. `single-cart-per-session` is now the category anchor: the race
> is between `CartPage` and `CartBadge`, two components in one document, on one
> shopper's first page load. `cart-mutation-applied-at-most-once` is one client,
> one request, one dropped response.
>
> Explicitly **not** excluded, and left at full priority:
>
> - One shopper's browser overlapping requests with itself. Beyond the mount-time
>   double fetch, every mutation fires `notifyCartUpdated()` twice, and each
>   triggers a badge `GET /api/cart` — which is a write. The app supplies its own
>   contention, so `cart-endpoints-never-unhandled-500` keeps P1 on the
>   `SQLITE_BUSY` cause alone.
> - Admin operations concurrent with one shopper. An operator running `--reset`
>   or editing a price mid-demo is a single-shopper scenario with an operator, not
>   two shoppers — and `specs/02` §9.5 describes `--reset` as exactly the
>   right-after-a-demo action. All of category C is unaffected, as are the P2003
>   and P2025 causes in category E.
>
> Categories B, D, F and G are unaffected. `persisted-coupons-match-discount-lines`
> keeps P0 because its sharpest mechanism is a *single request* performing two
> unsynchronized writes to `Cart.coupons`
> ([coupons/route.ts:35-38](../../src/app/api/cart/coupons/route.ts#L35-L38) then
> `priceAndPrune`) — no concurrency required.
>
> **Net: 3 properties demoted P0 → P2, 0 removed, 0 added, no assertion type
> changed. Priorities move from 6 P0 / 12 P1 / 6 P2 to 3 P0 / 12 P1 / 9 P2.** One
> open question was fully resolved (`cart-coupon-set-atomic`) and one narrowed to
> its admin-edit half (`applying-coupon-never-raises-total`), taking the
> catalog's tagged-question count from 12 to 11.
>
> The original analysis is preserved below as the record of why the decision was
> asked for.

---

*From WC-2.* This is the single decision that most changes the value of the
catalog. **14 of 24 properties exist because concurrent access to one cart is
unguarded.**

**The evidence that this is genuinely open, not merely unanswered:**

*The project named the hazard precisely.* `playwright.config.ts:11-17`, repeated
in `specs/01` §12.1:

> "SQLite is single-writer. Parallel workers hitting one database file produce
> `SQLITE_BUSY` errors that surface as intermittent, plausible-looking pricing
> bugs. If this suite ever gets slow enough to matter, the fix is WAL mode plus a
> busy timeout — **NOT** more workers."

*Then mitigated it in the test harness only* — `workers: 1`,
`fullyParallel: false`. Correct for a test suite, and it means the suite is now
configured so it cannot observe the failure mode its own comment describes.

*And left the application unmitigated* — no WAL, no `busy_timeout`, no
transaction around any cart read-modify-write, no error handling on any cart
route, no rate limit, no constraint on how many browsers reach `:3000`.

*With no scope statement either way.* `specs/01` §1's non-goals rule out accounts,
payments, inventory, and shopper auth. Concurrency is not mentioned. None of the
ten reviewed defects in `shopping-cart-demo-spec.md` is a concurrency defect,
confirming it was never a review lens.

**What each answer implies:**

| If **in scope** | If **out of scope** |
|---|---|
| Category A is the highest-value work here. The mechanisms are unguarded and the failures are silent — a lost coupon, a lost add, a 500 on the app's most common action. | Category A drops to P2 and becomes a documented-limitation report rather than a bug hunt. |
| The SUT probably wants transactions around `priceAndPrune` and an upsert/increment on cart items before testing is even interesting — otherwise Antithesis will find the same window repeatedly. | Effort shifts to categories B, D, and G — pricing correctness, durability, and resource growth — all of which hold regardless of concurrency. |
| Roughly 14 properties stay at P0/P1. | Roughly 9 properties drop a tier; the catalog stays useful at ~15 properties. |

**The part worth deciding carefully:** even under the narrowest reading of "one
shopper at a time," the application generates concurrent requests against its own
cart on every page load. `CartPage` fetches `/api/cart` and `CartBadge` in the
root layout fetches it too, both on mount, unordered. So `single-cart-per-session`
— and the `SQLITE_BUSY` exposure in `cart-endpoints-never-unhandled-500` —
survive a decision to exclude multi-shopper concurrency. A "no" answer narrows the
catalog; it does not empty category A.

**What we need from you:** whether the served demo is meant to handle overlapping
requests from more than one person, and if not, whether the self-inflicted
concurrency from the cart page's own double-fetch is still in scope.

## Re-evaluation assessment

`references/property-evaluation.md` advises a second evaluation pass when
gap-filling produces a new *category* of properties.

Three properties were added, two of them forming a new category G (resource
boundaries). That is at the threshold. Judged **not** to require a second full
pass, for three reasons:

- Both category G properties were checked against all four lenses during
  gap-filling — Antithesis Fit (fault-driven cookie loss is what makes
  `cart-rows-bounded-by-distinct-clients` an Antithesis property rather than a
  load test), Implementability (both are observable from the HTTP boundary and
  need no new topology), and Coverage Balance (they close the gap that produced
  them).
- The third addition, `catalog-read-never-shows-partial-batch`, extends an
  existing category rather than creating one.
- The unresolved item is B1, and no amount of further evaluation resolves it —
  it is a product-scope decision.

**Recommended:** resolve B1, then re-triage priorities across categories A, C, and
E accordingly. That is a priority adjustment, not another evaluation pass.

**Done 2026-08-01.** B1 was resolved and the re-triage applied. Category C and the
in-scope causes in category E turned out not to need adjustment at all — both rest
on admin-vs-shopper concurrency, which the decision leaves in scope. Only category
A moved. No re-evaluation pass was run, per the assessment above: the catalog's
composition is unchanged (24 properties, same categories), and only priorities and
four Antithesis Angles were revised.

## Open Questions

- ~~**B1** — the escalated bias.~~ **Resolved 2026-08-01: multi-shopper access is
  out of scope.** Applied to the catalog, four evidence files, the SUT analysis,
  the topology, and the relationships map. See the resolution block above.
- Are node-termination and clock-jitter faults enabled for this tenant? Three
  properties and one property-variant are unfound rather than passing without
  them, which is easy to misread in a run report. `(needs human input)`
- Is `/data` configured as a durable volume in the Antithesis environment? If
  not, `acked-cart-mutations-survive-restart` tests the harness.
  `(needs human input)`
- Should a `/api/health` endpoint be added to the SUT? It would sharpen three
  properties' failure triage but is a change to the application, not the harness.
  `(needs human input)`
