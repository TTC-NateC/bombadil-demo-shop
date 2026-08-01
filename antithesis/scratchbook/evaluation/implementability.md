---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Evaluation Lens 3 — Implementability

Can each property actually be checked, given the deployment topology, the
workload's observation surface, and the codebase as it stands?

## Findings

### IM-1 — Refinement: `cart-endpoints-never-unhandled-500` needed splitting

**Scope:** property-specific.

As originally drafted, the property was one `Always` assertion covering three
endpoint families. `references/property-catalog.md` is explicit: "Every planned
assertion message must be unique and specific. Do not model a broad property by
reusing one assertion message at multiple unrelated callsites."

Beyond the rule, there is a practical cost: a single message reports "a cart
endpoint 500'd" without saying which, and the three routes fail for different
reasons (`/api/cart/items` → P2002/P2003, `/api/cart/coupons` → P2025 via
`findUniqueOrThrow`, `/api/cart` → contention or a torn `Cart.coupons` column).

**Suggested action:** split into three assertions with distinct messages carrying
endpoint, method, and observed status.
**Applied** — the catalog entry and evidence file now specify three.

### IM-2 — Refinement: `cart-mutation-applied-at-most-once` cannot be an equality

**Scope:** property-specific.

The original framing implied the workload could assert `observed === acked`. It
cannot. When a network fault drops a response after the write commits, the
workload genuinely does not know whether the mutation landed — that ambiguity is
the fault's whole point, and collapsing it to a guess produces false positives on
correct behavior.

**Suggested action:** restate as the interval `acked <= observed <= attempted`,
with the upper bound carrying the real content.
**Applied** — the catalog and evidence file both use the interval form, and the
evidence file explains why.

### IM-3 — Refinement: `acked-cart-mutations-survive-restart` has two environment preconditions

**Scope:** property-specific, with topology implications.

Two conditions must hold or the property tests the harness rather than the SUT:

1. **Node-termination faults must be enabled.** `references/faults.md` records
   they are commonly disabled by default. Without them the property is *unfound*,
   which in a run report is easy to misread as *passing*.
2. **`/data` must be a durable volume.** `references/faults.md`: restarted
   containers "may lose non-durable filesystem state." If SQLite sits on the
   container's ephemeral layer, every restart loses every cart and the property
   fails for reasons unrelated to the SUT.

The SUT side is correct — the `Dockerfile` declares `VOLUME /data` and the
documented run command mounts one. The Antithesis compose configuration is what
decides it, and that is written by `antithesis-setup`, not here.

**Suggested action:** mark the property `[needs node-termination]` in the catalog,
record both preconditions as open questions on the property, and carry the volume
requirement into `deployment-topology.md` so the setup stage inherits it rather
than rediscovering it.
**Applied** — all three.

### IM-4 — `startup-crash-never-bricks-container` is not workload-observable

**Scope:** property-specific. **The clearest instrumentation requirement in the catalog.**

From outside the container, "still starting" and "permanently bricked" are the
same observation — no response — until an arbitrary timeout expires. Worse, the
property needs to distinguish *which startup step* a kill landed in, since only
`migrate deploy` leaves sticky state; an interrupted seed self-heals.

The entrypoint is `/bin/sh`, so this needs the SDK's shell entry point or a small
Node one-liner:

- a marker when `migrate deploy` begins,
- a marker when it completes,
- a marker immediately before `exec node server.js`.

**Suggested action:** record this as a required SUT-side change in both the
evidence file and the topology.
**Applied** — `deployment-topology.md` lists shell-level assertions as one of
three required Dockerfile/entrypoint additions.

### IM-5 — Workload must control its own cookie jar, and record overwrites

**Scope:** affects `single-cart-per-session`, `cart-rows-bounded-by-distinct-clients`, `acked-cart-mutations-survive-restart`, and every category A property.

A standard HTTP client with automatic cookie handling applies `Set-Cookie`
last-write-wins and discards the previous value — silently. That overwriting is
precisely what `single-cart-per-session` measures, so an off-the-shelf jar makes
the property undetectable.

**Suggested action:** specify in the topology that each virtual shopper owns an
explicit jar that *records* every `Set-Cookie` rather than only applying it.
**Applied** — `deployment-topology.md`, "Cookie handling is load-bearing."

### IM-6 — Two workload modes that must not share a cart

**Scope:** catalog-wide constraint on workload design.

Three properties require "no other operation touched this cart" as a precondition
(`applying-coupon-never-raises-total`, `coupon-removal-is-reversible`,
`price-snapshot-immutable`). All five category A properties require the opposite.

Running both against the same cart makes each meaningless: the comparison
properties false-positive on legitimate concurrent changes, and the race
properties get no races.

**Suggested action:** the workload needs a serialized-shopper pool and a
concurrent-shopper pool with disjoint carts.
**Applied** — recorded in `deployment-topology.md` and as a cross-cluster note in
`property-relationships.md`.

### IM-7 — `persisted-coupons-match-discount-lines` cannot be checked exactly

**Scope:** property-specific.

`Cart.coupons` is not in the API shape, and `specs/01` §5.6 states that omission
is deliberate ("`PricedCart` needs no separate applied-coupons field"). No admin
or debug endpoint exposes cart state — verified by enumerating every file under
`src/app/api/`.

The two-GET comparison in the evidence file is the strongest workload-only check
available, and it has a real limitation: it detects divergence that *self-corrects
on the next pass* but not a divergence stable across passes. A code stuck in
`Cart.coupons` that never applies produces identical `discountLines` on both GETs
and is invisible.

**Suggested action:** keep the two-GET check; record the limitation and the
SUT-side alternative (an assertion at `cart.ts:118` comparing the read set to the
applied set) as an open question, since adding a debug route is the code owner's
call.
**Applied** — the evidence file carries both, with an investigation log.

### IM-8 — Admin key must reach the workload container

**Scope:** affects six properties.

`requireAdmin` rejects unconditionally when `ADMIN_API_KEY` is unset or
`"change-me"` (`admin-auth.ts:25-27`), and the entrypoint refuses to start in
production without one. So `bulk-product-create-atomic`,
`product-delete-cascades-cleanly`, `coupon-mutation-leaves-cart-consistent`,
`catalog-read-never-shows-partial-batch`, `recommendations-stay-responsive` (the
large-catalog staging half), and `price-snapshot-immutable` all need the workload
to hold the same key the SUT holds.

**Suggested action:** specify a fixed non-default test value in both containers'
environment.
**Applied** — `deployment-topology.md`, required environment table.

### IM-9 — Workload needs the store config values, not just the endpoints

**Scope:** affects `coupon-prune-path-observed` and everything downstream of it.

To trigger a prune, the workload must drive a cart across `TAKE15`'s
`minSubtotalCents` (5000) or the free-shipping threshold (5000 by default). Both
gate on the **pre-discount** subtotal (`engine.ts:87`, `engine.ts:30-32`). If the
workload doesn't know those numbers, it can only stumble into the boundary.

Since `coupon-prune-path-observed` is the reachability gate for four other
properties (`property-relationships.md` cluster 1), getting this wrong quietly
voids a large part of category B.

**Suggested action:** pin the store config env vars to known values in the
topology and make them available to the workload.
**Applied** — `deployment-topology.md` names the values and the reason.

### IM-10 — Topology supports every property's fault requirements, with one honest limit

Checked each property against what the two-container topology can actually
produce:

- **Categories A, B, C, E** need concurrent requests and timing pressure. Node
  throttling, CPU modulation, and thread pausing all reach inside the single SUT
  process. Supported.
- **Category D** needs node termination. Supported *if enabled* — see IM-3.
- **`coupon-mutation-leaves-cart-consistent`'s clock variant** needs clock
  jitter. `new Date()` at `engine.ts:242` is the SUT's only clock dependency, so
  the fault is surgical here. Supported if enabled.
- **Network partitions** cannot reach anything interesting. There is one network
  link (workload → SUT) and no inter-service communication, so partitions only
  test the workload's own error handling. The one genuine use is dropping a
  *response* after a committed write, which is what makes
  `cart-mutation-applied-at-most-once` meaningful.

That last point is worth stating plainly rather than leaving implied: a large
share of Antithesis's standard fault repertoire does nothing for this SUT, and
the topology should not be designed as though it does.
**Applied** — `deployment-topology.md` has an explicit "Ineffective, and worth
saying so" subsection.

## Passes

- Every property is observable from the HTTP boundary except
  `startup-crash-never-bricks-container` (IM-4), which has a specified
  instrumentation path.
- The two-container topology supports every fault scenario the catalog needs,
  subject to the two tenant-configuration questions.
- The workload can construct every required precondition: carts crossing coupon
  thresholds (given IM-9), concurrent same-cart requests, admin writes during
  shopping (given IM-8), and large catalogs via the staging path.
- Reusing the SUT's pure `invariants.ts` and `types.ts` in the workload is
  feasible — both are dependency-free TypeScript, and the topology's `node:20-slim`
  workload base makes the import direct rather than a reimplementation.
- No property requires sustaining throughput long enough to strain a timeline.

## Uncertainties

- Whether the workload can reliably detect a restart without a health endpoint.
  It must currently infer one from connection failure followed by recovery, which
  is imprecise under node hang (which looks the same from outside). Recommended a
  `/api/health` returning a process start timestamp; flagged as a decision for
  `antithesis-setup` since it modifies the SUT.
- Whether coverage instrumentation for thread pausing is worth its build cost.
  Every category A window is an `await` boundary, so it should help — but node
  throttling and CPU modulation may already suffice. First-run question.
