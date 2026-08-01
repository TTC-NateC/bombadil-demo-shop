---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Evaluation Lens 1 — Antithesis Fit

Does each property require exploring a state space deterministic tests cannot
reach? And conversely: does the catalog underestimate Antithesis anywhere?

The bar is specific for this SUT. It has an unusually strong deterministic test
suite for its size — `engine.test.ts` encodes all three worked examples verbatim,
`allocate.test.ts` includes a randomized sum-to-whole property test, and
`admin-auth.test.ts` covers every fail-closed branch. Anything in that territory
is spending search budget on a question already answered.

## Findings

### AF-1 — Strong fit, no action: the concurrency cluster (categories A, C, E)

`cart-coupon-set-atomic`, `cart-item-quantity-no-lost-update`,
`cart-item-create-no-unique-violation`, `single-cart-per-session`,
`bulk-product-create-atomic`, `product-delete-cascades-cleanly`,
`cart-endpoints-never-unhandled-500`.

These are as good a fit as this lens looks for. Each targets a check-then-act
window one `await` wide, invisible to any test that issues requests sequentially,
and the existing Playwright suite is configured (`workers: 1`,
`fullyParallel: false`) so that it *cannot* observe them. Node throttling and CPU
modulation widen exactly these windows.

Worth recording as an unusual signal: the SUT's own test configuration documents
the hazard and then arranges not to see it (`playwright.config.ts:11-17`). That is
a rare case where the codebase names the gap Antithesis is being brought in to
fill.

### AF-2 — `allocation-remainder-distributed` is closest to unit-test territory

**Scope:** property-specific.

`src/lib/pricing/allocate.test.ts` already contains "always sums to the whole,
across randomised inputs," plus explicit cases for leftover distribution and
lower-index tie-breaking. The arithmetic is covered, and no fault injection makes
`allocate` behave differently — it is a pure function over integers.

**However**, the property as cataloged is a `Reachable` marker, not a safety
check. Its stated job is to confirm the *integration* path reaches multi-line
uneven allocation with snapshots written by the cart routes and weights computed
from a running base — which the unit tests, calling `allocate` directly, do not
establish.

**Suggested action:** keep, at P2, with the evidence file stating explicitly that
it is not hunting for arithmetic bugs. Confirmed present in
`properties/allocation-remainder-distributed.md` under "Honest scoping."
Additionally, prefer the SUT-side placement at `allocate.ts:36` over the
workload-side reconstruction: from inside, `leftover > 0` is directly known,
whereas the workload cannot recover the running base from a multi-coupon response.
That refinement is recorded in the evidence file.

### AF-3 — `money-fields-stay-exact` is fuzzing, not fault timing

**Scope:** property-specific.

The failure is triggered by input magnitude, not by interleaving. A plain fuzzer
with no fault injection would find it. The catalog should say so rather than
implying fault injection is what surfaces it.

Two things keep it worth including:

- The *interesting* failures need a combination — a large line subtotal, a coupon
  set forcing multi-line allocation, and a percentage that maximises the
  intermediate product. Antithesis explores that combination space; a hand-written
  test explores whichever case the author imagined.
- The assertion rides along on responses the workload is already checking for
  `priced-cart-invariants-hold`. Marginal cost is near zero.

**Suggested action:** keep at P1, with the "honest accounting" paragraph in the
evidence file naming the limitation. Confirmed present.

### AF-4 — `catalog-read-never-shows-partial-batch` may be vacuous

**Scope:** property-specific.

If SQLite's default rollback journal already prevents a reader from observing an
in-progress transaction, the assertion never fires, and a never-firing assertion
inflates the apparent coverage of category C.

Weighed against: the assertion is correct whether or not the current config
satisfies it; it costs one polling loop on setup the workload runs anyway; and it
catches a genuinely different bug (a batch that partially commits because someone
replaced `$transaction` with `Promise.all`). It also becomes live the moment
anyone enables WAL — which both `specs/01` §12.1 and `playwright.config.ts` name
as the recommended fix for the contention problem.

**Suggested action:** keep at P2 with the vacuity risk stated in the evidence
file and an open question that the first run resolves empirically. Confirmed
present.

### AF-5 — Antithesis's value is underestimated for `single-cart-per-session`

**Scope:** property-specific. **This is the finding this lens most wants acted on.**

Read quickly, this looks like a cosmetic first-load nit — a badge showing the
wrong count. Three things make it more than that:

1. It fires on an **ordinary first page load**, not under synthetic load. The cart
   page mounts `CartPage` and `CartBadge`, both of which fetch `/api/cart`
   immediately. Every first visit races.
2. The consequence is a shopper's items landing in a cart no cookie points at —
   silent, with no error, and not obviously recoverable by refreshing.
3. It is the seed of the unbounded-growth mechanism in
   `cart-rows-bounded-by-distinct-clients`.

Antithesis controls which response wins the race via latency and throttling,
which is the only reliable way to exercise both orderings. A deterministic test
would see whichever ordering the machine happened to produce.

**Suggested action:** raise from P2 to P1. Applied — the catalog now lists it at
P1.

### AF-6 — Assertion-type check across the catalog

Every property was checked against `references/property-catalog.md`'s guidance.

| Property | Type | Verdict |
|---|---|---|
| `startup-crash-never-bricks-container` | `Sometimes` + paired `Reachable` | Correct, and the pairing is necessary — without the `Reachable`, "the precondition never occurred" and "recovery failed" are indistinguishable. Good catch by discovery. |
| `cart-eventually-readable` | `Sometimes` | Correct. Non-trivial semantic condition (every tracked cart valid during a quiet period), not a disguised `Reachable`. |
| The three category F markers | `Reachable` | Correct. None carries a semantic condition beyond "we got here," so `Sometimes(true, ...)` would be the smell the reference warns about. |
| `cart-mutation-applied-at-most-once` | `Always` on an interval | Correct and well-judged. Collapsing to equality would false-positive whenever a response is dropped — the interval encodes genuine, irreducible uncertainty rather than guessing. |
| Everything else | `Always` | Correct. All are invariants evaluated per response. |

No mismatches found. One note: 19 `Always` to 2 `Sometimes` to 3 `Reachable` is
`Always`-heavy, but that reflects a SUT whose guarantees are overwhelmingly
safety-shaped — there is no consensus, no replication, no queue, and no
background work to be live about. Coverage Balance examines this from the
portfolio angle.

### AF-7 — Deliberate exclusions, verified as correct

Three areas that a discovery pass might have cataloged and correctly did not:

- **Path traversal on `/uploads/[filename]`.** `specs/02` AC 5 and §8.2 specify
  it, `STORED_NAME` plus resolve-containment implement it, and it is pure input
  validation with no timing dimension. `e2e/admin-api.spec.ts` covers it.
  Deterministic test territory.
- **Admin auth fail-closed.** `admin-auth.test.ts` covers all five branches
  including the unset-key case. No timing dimension.
- **Pure engine arithmetic on fixed inputs.** Covered by `engine.test.ts` far more
  thoroughly than a workload could manage.

Excluding these is the right call, and the catalog is stronger for not padding
itself with them.

## Passes

- No property in the catalog is fully verifiable by a unit test with fixed inputs.
  AF-2 comes closest and survives as a reachability marker rather than a check.
- Every property's assertion type matches its semantics (AF-6).
- The catalog does not duplicate the existing Vitest or Playwright coverage.

## Uncertainties

- Whether thread-pausing faults are worth the coverage-instrumentation cost. They
  would sharpen category A considerably — every window there is an `await`
  boundary — but node throttling and CPU modulation may already be sufficient.
  Cannot determine without a first run.
- Whether `catalog-read-never-shows-partial-batch` is live under the current
  SQLite configuration (AF-4). Empirical.
