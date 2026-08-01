# acked-cart-mutations-survive-restart

## What led here

`specs/01` §10 states the purpose of the volume — "Mount `/data` as a volume so
the DB persists across restarts" — and `specs/02` AC 4 requires products and
uploaded images to survive a restart. `specs/02` §11 lists a "persistence smoke
(optional)" Playwright test that does not exist in `e2e/`.

Carts are the state a shopper actually cares about, and they are the one thing no
acceptance criterion names in a restart context.

## Code paths

**Storage — `prisma/schema.prisma:59-87`:** `Cart` and `CartItem` are ordinary
rows in `/data/app.db`.

**Durability configuration — none.** No `synchronous` pragma, no `journal_mode`,
no `busy_timeout` anywhere in the repository (see the investigation log in
`catalog-read-never-shows-partial-batch.md` for the full search). Whatever SQLite
does by default under Prisma 6.19.3 is what this system does.

**Where an ack is issued:** every cart route returns
`NextResponse.json(await priceAndPrune(cartId))`. The response is written after
the Prisma write resolves, so a 200 means the write was accepted by the engine.
Whether "accepted by the engine" means "durable across a `SIGKILL`" depends
entirely on the SQLite synchronous setting, which is unset.

**The restart path — `docker/entrypoint.sh`:** `migrate deploy`, then `db seed`,
then `exec node server.js`. Neither step touches `Cart` or `CartItem`, so a
restart should be transparent to cart state.

## Failure scenario

1. Workload adds items to cart C and receives 200 for each.
2. Antithesis crash-kills the container.
3. The container restarts; the entrypoint runs migrate and seed and starts the
   server.
4. Workload issues `GET /api/cart` with C's cookie.
5. A violation is any acknowledged item missing, or any acknowledged quantity
   reduced.

## Two preconditions that can make this property test the harness instead of the SUT

Both must be confirmed before the result means anything, which is why they are
open questions rather than assumptions.

**Node-termination faults must be enabled.** `references/faults.md` records that
these are commonly disabled by default. Without them, step 2 never happens and
the property is unfound rather than passing.

**`/data` must be a durable volume in the Antithesis environment.**
`references/faults.md` states that restarted containers "may lose non-durable
filesystem state." If the SQLite file lives on the container's ephemeral layer
rather than a mounted volume, every restart loses every cart — and the property
fails for a reason that has nothing to do with the SUT. The `Dockerfile` declares
`VOLUME /data` and the documented run command is
`docker run -p 3000:3000 -v cartdata:/data demo-cart`, but the Antithesis
environment's compose configuration is what actually decides this, and that
configuration is written by the `antithesis-setup` stage, not here.

Flagging both is the point of this file: a green result on a misconfigured
environment is worse than no result.

## What the property genuinely tests once the preconditions hold

Whether SQLite's default durability settings preserve a committed write across a
crash-kill. This is a real question with a real answer, and the system has made no
explicit choice about it — there is no `PRAGMA synchronous` anywhere, so the
answer is inherited rather than decided. A demo that loses the last few seconds of
cart activity on a crash may be entirely acceptable; the point is that nobody has
said so, and the volume exists specifically to make persistence a feature.

## Interaction with `price-snapshot-immutable`

The restart also re-runs the idempotent seed, which rewrites `Product.priceCents`
for every seeded product. A cart that survives the restart therefore holds
snapshots that may no longer match the catalog. That composition is cataloged
under `price-snapshot-immutable`; here it matters only as a reason the workload's
post-restart expectations must be built from `unitPriceCents` as observed
*before* the restart, not from the catalog after it.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** an expected-cart model per virtual shopper,
  updated on every 200, and an `Always` assertion after each detected restart
  that the recovered `PricedCart` contains every acknowledged item at the
  acknowledged quantity.
- **Missing, workload-side (supporting):** restart detection. The SUT exposes no
  health, readiness, or uptime endpoint (`sut-analysis.md` §6), so the workload
  must infer a restart from connection failure followed by recovery. A trivial
  `/api/health` returning a process start timestamp would make this exact rather
  than inferred — see `deployment-topology.md`.
- **Missing, SUT-side:** none required for the assertion itself.

## Open questions

- **Is `/data` mounted as a durable volume in the planned Antithesis
  environment?** If not, this property tests the harness rather than the SUT and
  must be suppressed until the topology is corrected.
- **Are node-termination faults enabled for this tenant?** If not, the property
  is unfound rather than passing, and the run report should say so rather than
  showing a clean result.

### Investigation Log

#### Is `/data` mounted as a durable volume in the planned Antithesis environment?

- Examined: `Dockerfile` (`VOLUME /data`, `ENV DATABASE_URL="file:/data/app.db"`,
  `ENV UPLOAD_DIR="/data/uploads"`), `docker/entrypoint.sh` (`mkdir -p /data`),
  `specs/01` §10 (documented run command with `-v cartdata:/data`),
  `references/faults.md` ("Restarted containers ... may lose non-durable
  filesystem state").
- Found: the image is built to expect a mounted volume and the documented run
  command supplies one. The SUT side is correct and unambiguous.
- Not found: the Antithesis environment's compose configuration — it does not
  exist yet. It is produced by the `antithesis-setup` stage, which runs after this
  research, so the answer is a decision rather than a discoverable fact.
- Conclusion: tagged `(needs human input)`. Recorded here and carried into
  `deployment-topology.md` so the setup stage inherits the requirement rather than
  rediscovering it.

#### Are node-termination faults enabled for this tenant?

- Examined: `references/faults.md` ("Node termination ... **Disabled by
  default**"; "The set of enabled faults depends on the tenant configuration and
  the webhook used to launch runs").
- Found: the default is disabled, and availability is a per-tenant setting that
  customers change by contacting Antithesis support.
- Not found: anything in the repository bearing on it — fault availability is not
  a property of the codebase.
- Conclusion: tagged `(needs human input)`. Without these faults the property is
  *unfound* rather than passing, which is easy to misread in a run report — so
  the answer should be confirmed before the run, not inferred from a clean result.
