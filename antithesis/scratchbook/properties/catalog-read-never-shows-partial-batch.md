# catalog-read-never-shows-partial-batch

## What led here

Added during evaluation gap-filling, from the Coverage Balance lens
(`evaluation/coverage-balance.md`, finding CB-2).

The catalog had `bulk-product-create-atomic`, which checks the all-or-nothing
guarantee from the **writer's** side: did the batch return 201 with `created ===
N`, or 4xx with nothing created. Nobody checked it from the **reader's** side:
what does a shopper browsing the catalog see while that transaction is open.
`specs/02` §4 states the guarantee without specifying whose view it applies to.

## Code paths

**The write — `src/app/api/products/bulk/route.ts:43-45`:**

```
43   const products = await prisma.$transaction(
44     prepared.map((data) => prisma.product.create({ data })),
45   )
```

Prisma's array form runs all operations in one interactive transaction. The
writer gets atomicity.

**The read — `src/app/api/products/route.ts:12-15`:**

```
12   const products = await prisma.product.findMany({
13     where: includeInactive ? {} : { active: true },
14     orderBy: { createdAt: "asc" },
15   })
```

No transaction, no explicit isolation level.

**The relevant configuration — absent.** No `journal_mode`, no `busy_timeout`, no
`synchronous` pragma appears anywhere in `src/`, `prisma/`, `scripts/`, `e2e/`,
or `docker/`. `DATABASE_URL` carries no connection parameters in `.env`,
`.env.example`, or the Dockerfile's `ENV`. So whatever SQLite and Prisma do by
default is what this system does.

**The other reader that matters — `src/lib/recommend-service.ts:13`:**

```
13   const catalog = await prisma.product.findMany({ where: { active: true } })
```

The recommendation module loads the entire active catalog on every call, and the
cart page calls it on load and on every cart change. It is the highest-frequency
catalog reader in the system, and it computes a deterministic ranking over
whatever it gets — so a partial batch produces a recommendation set that is
stable, plausible, and wrong.

## Failure scenario

1. Workload starts a `POST /api/products/bulk` with `N` rows carrying a
   recognizable slug prefix.
2. Concurrently, the workload polls `GET /api/products` and counts how many of
   that prefix are visible.
3. A violation is any observation strictly between `0` and `N`.

## Honest assessment of likelihood

This property may well be vacuous, and that is worth stating up front rather than
discovering during triage.

SQLite's default rollback journal mode gives readers a consistent view: a reader
either sees the pre-transaction state or waits. If Prisma holds a single
connection and the transaction is genuinely atomic at the SQLite level, a partial
read is not reachable and the assertion never fires.

The reasons to keep it anyway:

- The check is nearly free — one extra polling loop during a test the workload
  runs regardless for `bulk-product-create-atomic`.
- It is a *correct* invariant to assert whether or not the current configuration
  happens to satisfy it. If someone later adds `?journal_mode=WAL` to
  `DATABASE_URL` — which `playwright.config.ts:11-17` and `specs/01` §12.1 both
  name as the recommended fix for the contention problem — the isolation
  characteristics change, and this assertion is already in place to catch a
  regression.
- A `0`-or-`N` assertion also catches a genuinely different bug: a batch that
  partially commits because the transaction was not atomic at all (for instance
  if someone replaces `$transaction` with a `Promise.all`).

It is scored P2 for these reasons.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the polling reader plus
  `Always(observed === 0 || observed === N)`.
- **Missing, SUT-side:** none needed.

## Open questions

- **Does the SQLite journal mode in use actually permit a reader to observe an
  in-progress transaction?** If the default rollback journal prevents it outright,
  this property is vacuous and should be dropped rather than left as a
  never-firing assertion that inflates the apparent coverage of category C. If
  WAL is ever enabled, it becomes live. The answer determines whether this is a
  real check or a placeholder for a future configuration.

### Investigation Log

#### Does the SQLite journal mode in use permit a reader to observe an in-progress transaction?

- Examined: `.env`, `.env.example`, `Dockerfile` (`ENV DATABASE_URL`),
  `playwright.config.ts` (`env.DATABASE_URL`), `prisma/schema.prisma` (datasource
  block), `prisma/migrations/20260801050207_init/migration.sql`,
  `src/lib/db.ts` (`PrismaClient` construction), and a repository-wide grep for
  `journal_mode`, `busy_timeout`, `WAL`, and `pragma`.
- Found: no pragma is set anywhere, and no connection parameters are appended to
  any `DATABASE_URL`. `src/lib/db.ts` constructs `new PrismaClient()` with no
  options. So the SQLite/Prisma defaults apply unmodified. `specs/01` §12.1 and
  `playwright.config.ts:11-17` both describe WAL as a change that has *not* been
  made ("**if** this suite ever gets slow enough to matter, the fix **is** WAL
  mode plus a busy timeout"), which confirms WAL is not in use.
- Not found: what Prisma's SQLite connector actually sets for journal mode and
  connection pooling at version 6.19.3. That is engine behavior, not repository
  content — the query engine is a compiled binary and the answer is not
  recoverable from this codebase. Determining it would require running the engine
  and querying `PRAGMA journal_mode`, which is empirical work outside the scope of
  a code-reading pass.
- Conclusion: tagged `(partial: ...)`. Settled that the repository sets nothing,
  so defaults apply. The remaining open part — what those defaults are, and
  whether they make a partial read reachable — needs an empirical check against a
  running container, which the workload's first run will answer for free.
