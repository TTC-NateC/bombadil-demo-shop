# cart-eventually-readable

## What led here

Focus 8. The system has no retry, no backoff, no circuit breaker, no timeout, and
no error handling on any cart path (`sut-analysis.md` §6). Recovery from any
transient fault therefore depends entirely on the fault clearing and on nothing
inside the process having been left in a bad state.

That is a strong assumption and nothing verifies it. This property is the
liveness counterpart to the safety properties in categories A and B: those ask
"was the answer right," this one asks "is there an answer at all, afterwards."

## Code paths

**Everything that can wedge:**

- `src/lib/db.ts:1-11` — a single `PrismaClient` singleton with no options. No
  connection limit, no timeouts, no pool configuration.
- No `try`/`catch` in any file under `src/app/api/cart/`.
- No `busy_timeout` or `journal_mode` configured anywhere, so SQLite lock
  contention behavior is the unmodified default.
- `src/components/cart-events.ts:14-25` — the client issues one `fetch` with no
  timeout and no retry.

**What the workload observes:** `GET /api/cart` →
`priceAndPrune(await resolveCartId())` → a `PricedCart` or an exception.

## The distinction the property draws

- **Degraded during a fault** — a request fails while the container is throttled,
  hung, or partitioned from the client. Expected. Not a violation.
- **Broken after the fault** — the fault clears and the cart is still
  unreadable. A violation.

Getting that distinction right is why the check must run inside a quiet period
rather than continuously.

## Mechanism: `ANTITHESIS_STOP_FAULTS`, not `eventually_`

Per `references/faults.md`, `eventually_` runs with faults paused but is a
**terminal** check — Antithesis does not resume testing on that branch afterward.
This property should be checked repeatedly through a run, after different fault
episodes, with the timeline continuing each time. That is exactly the
`ANTITHESIS_STOP_FAULTS` use case:

1. Run cart operations while faults are active.
2. Call `ANTITHESIS_STOP_FAULTS <seconds>` with enough time for the container to
   recover (and to restart, if node-termination faults are enabled).
3. Poll until the SUT responds or the window expires.
4. For every cart the workload created, issue `GET /api/cart` and assert 200 with
   a `PricedCart` satisfying the seven §5.2 invariants.
5. Resume the workload; faults restart automatically.

Using `eventually_` instead would give one liveness datapoint per timeline
instead of many, and would forfeit everything the timeline could have explored
afterward.

## What a violation would look like

Concrete candidates, in rough order of likelihood:

- **A wedged write lock.** `GET /api/cart` takes a write lock via
  `priceAndPrune`'s `cart.update`. With no `busy_timeout` set, a lock held across
  a node hang could leave subsequent writers failing after the hang ends.
- **Connection pool exhaustion.** Every request that throws leaves Prisma to
  reclaim its connection. With no pool configuration and no error handling,
  sustained throttling plus the write amplification from `CartBadge` refreshes
  (`sut-analysis.md` §4) is the shape that would surface it.
- **A cart left in a shape that always throws.** `priceAndPrune` does
  `JSON.parse(cart.coupons)` at [cart.ts:95](../../../src/lib/cart.ts#L95) with no
  guard. A torn write to that column — from an interrupted transaction, or from
  the concurrent double-write described in
  `persisted-coupons-match-discount-lines.md` — would make every subsequent
  pricing pass for that cart throw, permanently. This one is worth calling out
  because it is *per-cart* and permanent: the SUT would look healthy overall while
  one shopper's cart is unrecoverable.

That last candidate is the reason the assertion iterates over **every** cart the
workload created rather than sampling one — a single poisoned cart in a healthy
system is exactly what a spot check misses.

## Assertion design

`Sometimes(every tracked cart returned a valid PricedCart during the quiet
period)`.

`Sometimes` is correct: this is a progress condition whose meaningful evaluation
requires a precondition (faults paused, recovery window elapsed) that does not
hold continuously. Asserting `Always` would fire on every legitimate
during-fault failure and drown the signal.

The condition is non-trivial and semantic rather than a bare location marker, so
it is a genuine `Sometimes` rather than a disguised `Reachable`.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the quiet-period loop and the `Sometimes`
  assertion; reuse of the seven invariant checks from
  `priced-cart-invariants-hold`.
- **Missing, workload-side (supporting):** the workload must track every cart id
  it created so it can check all of them. This is the same bookkeeping
  `single-cart-per-session` and `acked-cart-mutations-survive-restart` need.
- **Missing, SUT-side (would help):** a health endpoint. The SUT has none
  (`sut-analysis.md` §6) — `playwright.config.ts` polls `/api/products` as a
  liveness proxy. A trivial `/api/health` would let the workload distinguish
  "process is up but the cart path is broken" from "process is still down,"
  which changes how a failure is triaged. Recorded in
  `deployment-topology.md`.

## Open questions

None. The mechanism (no error handling, no retry, no timeouts), the check
procedure (`ANTITHESIS_STOP_FAULTS`), and the assertion type are all determined
by what is in the repository and in `references/faults.md`. The candidate failure
modes above are hypotheses the property exists to test, not claims about what the
system does.
