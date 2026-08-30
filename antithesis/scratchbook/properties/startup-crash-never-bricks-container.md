# startup-crash-never-bricks-container

## What led here

Focus 8 (failure and degradation modes) reading `docker/entrypoint.sh` line by
line. The script is short, correct for the happy path, and has no recovery
behavior at all — `set -e` means any step's failure ends the container.

The interesting part is that one of those steps leaves persistent state behind
when interrupted, so the failure is not transient.

## Code paths

**`docker/entrypoint.sh`** in full order:

```sh
set -e

# 1. admin key fail-closed (production only)
if [ "$NODE_ENV" = "production" ]; then
  case "$ADMIN_API_KEY" in
    ""|"change-me") echo "FATAL: ..." >&2; exit 1 ;;
  esac
fi

# 2. writable state
mkdir -p /data
mkdir -p "${UPLOAD_DIR:-/data/uploads}"

# 3. schema and baseline data
npx --no-install prisma migrate deploy
npx --no-install prisma db seed

# 4. serve
exec node server.js
```

**Step 3a — `prisma migrate deploy`.** Prisma records each migration in a
`_prisma_migrations` table with `started_at` set when it begins and `finished_at`
set when it completes. A process killed between those two writes leaves a row
with a null `finished_at`. On the next start, `migrate deploy` finds a migration
recorded as started-but-not-finished and **refuses to proceed** rather than
retrying it, because it cannot know how much of the migration was applied.

`set -e` then terminates the entrypoint, so `node server.js` never runs. The
container fails to start, and it fails identically on every subsequent attempt.
That is a permanent outage produced by a single transient fault.

**Step 3b — `prisma db seed`** runs `prisma/seed.ts`, which upserts each fixture
row individually ([seed.ts:14-27](../../../prisma/seed.ts#L14-L27), and again for
`relatedIds` at 35-43 and coupons at 47+). There is no wrapping transaction, so
an interrupted seed leaves a partially-seeded database. This half *is*
self-healing: the upserts are idempotent by slug/code, so the next start
completes what was missed. The seed's own doc comment states this is the design
("Idempotent: upserts by slug/code, so the container entrypoint can run it on
every start without duplicating rows").

So the two steps have opposite recovery characteristics, and only one of them is
documented as idempotent.

**`--no-install`** on both `npx` calls is deliberate and correct — its comment
says "fail loudly rather than reaching for the network at boot," which serves
`specs/01` AC 1's "no network access required at container start." It also means
a missing runtime dependency is a hard failure, which is the right trade but adds
a third way the startup sequence can end without serving.

## Failure scenario

1. Antithesis crash-kills the container during `prisma migrate deploy` on a fresh
   volume.
2. `_prisma_migrations` holds a row for `20260801050207_init` with a null
   `finished_at`.
3. Container restarts. `migrate deploy` refuses. `set -e` exits.
4. Steps 3 repeat forever. The SUT never serves again on that volume.

## Why the window is small and why that doesn't reduce the value

There is exactly one migration (`prisma/migrations/20260801050207_init/`), and it
runs against a small schema, so it completes in milliseconds. On a random kill the
odds of landing inside it are low.

That is precisely the profile Antithesis exists for. A low-probability window with
a permanent, unrecoverable consequence is worth more search budget than a common
window with a transient one — and it is exactly the case that manual testing and
a CI suite will never hit.

## Assertion design

`Sometimes(container reached a serving state after a start that followed an
interrupted startup)`, paired with a `Reachable` marker for "startup was
interrupted."

The pairing is load-bearing. `Sometimes` alone cannot distinguish two very
different run outcomes:

- the precondition never occurred (no kill landed in the startup window) — the
  property is unfound, which is fine;
- the precondition occurred and recovery failed — the property is violated.

The `Reachable` marker on the interrupted-startup path separates them. Without
it, a run where Antithesis never happened to kill during startup looks the same
as one where it did and the container bricked.

`Always` would be wrong here: the condition is about eventual progress after a
specific, rare precondition, not an invariant evaluated on every operation.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, SUT-side (required — this one cannot be done from the workload):**
  the entrypoint must emit markers. Concretely: a `Reachable` when the entrypoint
  begins `migrate deploy`, a `Reachable` when it completes, and a `Reachable`
  when `exec node server.js` is reached. The workload sits outside the container
  and cannot see which startup step a kill landed in — from outside, "still
  starting" and "bricked" look identical until a timeout expires.
- **Missing, workload-side:** the `Sometimes` assertion, evaluated during an
  `ANTITHESIS_STOP_FAULTS` quiet period so the container has an uninterrupted
  window to complete its startup.
- **Note:** the entrypoint is `/bin/sh`, so these markers need the SDK's shell
  entry point or a small Node one-liner. `deployment-topology.md` records this as
  an SDK requirement on the SUT container.

## Open questions

- **Does the init migration complete fast enough that the interruption window is
  negligible in practice?** If the window is genuinely sub-millisecond, the
  property may go unfound on most runs and the search budget is better spent
  elsewhere — but the consequence is permanent, so the answer changes priority
  rather than whether to keep it.
- **Are node-termination faults enabled for this tenant?** Without them the
  property cannot be exercised at all.

### Investigation Log

#### Does the init migration complete fast enough that the interruption window is negligible?

- Examined: `prisma/migrations/` (one directory, `20260801050207_init`),
  `prisma/migrations/migration_lock.toml`, `prisma/schema.prisma` (four models,
  no indexes beyond the unique constraints), `docker/entrypoint.sh`.
- Found: a single migration creating four tables with three unique constraints and
  no data movement. This is a small, fast DDL operation on an empty file. The
  window is correspondingly small — but `migrate deploy` also performs process
  startup, connection establishment, and the `_prisma_migrations` bookkeeping
  writes, so the *step* is measured in hundreds of milliseconds even if the DDL
  itself is not.
- Not found: any measurement. Timing the step would require running the container,
  which is empirical work outside a code-reading pass, and the number would be
  environment-dependent anyway (Antithesis's CPU modulation deliberately changes
  it).
- Conclusion: tagged `(partial: ...)`. Settled that the migration is small and the
  window is short. The remaining open part is the practical hit rate under
  Antithesis's own throttling, which the first run will reveal directly via the
  paired `Reachable` marker — that marker exists precisely to answer this.

#### Are node-termination faults enabled for this tenant?

- Examined: `references/faults.md` ("Node termination ... **Disabled by
  default**"; "The set of enabled faults depends on the tenant configuration and
  the webhook used to launch runs").
- Found: the default is disabled, and availability is a tenant setting.
- Not found: anything in the repository bearing on it — this is not a property of
  the codebase.
- Conclusion: tagged `(needs human input)`. Confirm with the user before relying
  on this property or `acked-cart-mutations-survive-restart`.
