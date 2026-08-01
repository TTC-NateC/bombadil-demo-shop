# Alignment Review: Demo Shopping Cart — specs vs. implementation plan

**Date:** 2026-07-31 (two passes)
**Commit:** `3eb6e9c` (working tree dirty — all edits from this session are uncommitted)

## Documents Reviewed

- **Intent:** `specs/01-core-shop-and-pricing-engine.md`, `specs/02-admin-api-and-data-pipeline.md`, `specs/03-merchandising-and-polish.md`, with `shopping-cart-demo-spec.md` as index
- **Action:** `IMPLEMENTATION-PLAN.md`
- **Design:** none separate — the specs carry their own design sections (§4 schema, §5.3–5.6 algorithms, §7.4–7.5 platform decisions), checked directly against tasks

**Pass 1** reviewed the plan in its original imperative form; **pass 2** re-reviewed after the plan was rewritten into RED/GREEN/REFACTOR, to confirm the reformat lost no coverage and to catch what the first pass missed.

## Source Control Conflicts

None, both passes. Three commits, all spec work, no code in the repository. Nothing the documents assume has been changed or removed, because nothing has been built yet.

## Decisions Taken During Review

**Next.js 15 confirmed** (was "14+", unresolved). Applied to specs and plan:
- New slice 1 §7.5 — async `cookies()`, route `params`, and page `params`/`searchParams`; the removal of default `fetch`/`GET` caching (which is the behaviour this app wants, so no opt-out is needed); React 19 peer-dependency friction with `shadcn/ui`.
- Slice 2 §8.2's upload-route sample updated to `await params`.
- Plan tasks 0.1–0.2 updated.

This dissolved a scope finding: the plan's version-pinning task previously traced to no requirement, and now traces to §7.5.

## Issues Reviewed

### [1] `prisma/seed.ts` had no owning phase
- **Category:** missing coverage · **Severity:** Critical · **Pass:** 1
- **Documents:** slice 1 §9 and AC1 vs. plan Phases 0–2
- **Issue:** §9 specifies the seed and AC1 requires the container to boot "with seeded products and coupons," but no phase built it. Phase 2's entrypoint *runs* `prisma db seed` and its gate requires a booting container — so the plan's first container gate was unreachable, and the omission would only surface at `docker run`. The coupled `package.json` `prisma.seed` → `tsx` wiring was also unassigned, despite being why Phase 2 installs `tsx` into the runner image.
- **Resolution:** Seed moved into Phase 1 (renamed "Schema, data layer & seed", resized S → M). Now tasks 1.1–1.3. Gate gained a double-run row-count check, proving §9's idempotency requirement — previously untested anywhere.

### [2] Slice 2 §8.4's entrypoint change had no owning task
- **Category:** design gap · **Severity:** Important · **Pass:** 1, resolved in 2
- **Documents:** slice 2 §8.4 vs. plan Phases 2, 7, 8
- **Issue:** §8.4 requires `mkdir -p /data/uploads` in the entrypoint so the first upload doesn't fail on a fresh volume. Phase 2 created `/data` only; Phase 8 built uploads without touching the entrypoint; Phase 7 *did* amend it for the admin-key check, which made the gap easy to miss. The upload test passed on any machine where `/data/uploads` already existed and failed with `ENOENT` on a clean `docker run -v newvolume:/data` — the demo-day path.
- **Resolution:** Task 8.2's GREEN owns the entrypoint amendment; its RED now runs **against a brand-new volume** and names `ENOENT` as the §8.4 signature. Phase 8's gate requires a fresh volume.

### [3] `workers: 1` implemented a constraint no requirement stated
- **Category:** scope — task with no traceable requirement · **Severity:** Important · **Pass:** 1, resolved in 2
- **Documents:** plan Phase 6 step 3 vs. slice 1 §12.1
- **Issue:** The setting is correct — SQLite is single-writer, and parallel Playwright workers produce `SQLITE_BUSY` flake that reads like a pricing bug. But the rationale lived only in the plan, a build-time artifact. Anyone later opening `playwright.config.ts`, checking the spec for a reason, finding none, and raising the worker count would have done the right research and still broken the suite.
- **Resolution:** Constraint and its escape hatch (WAL + busy timeout, *not* more workers) added to slice 1 §12.1; the plan now cites it.

### [4] README documentation requirements under-assigned
- **Category:** missing coverage · **Severity:** Minor · **Pass:** 1, resolved in 2
- **Documents:** slice 1 §5.3, §7.4; slice 2 §2 vs. the plan
- **Issue:** Three spec requirements call for README documentation. At pass 1 only §7.4 (unsigned cookie) had an owner.
- **Correction logged in pass 2:** the TDD rewrite added a README owner for slice 2 §2 to task 7.1's REFACTOR — an inadvertent partial fix to an issue recorded as unresolved, which left both the plan's open-issues table and this report overstating the gap. Corrected in both.
- **Resolution:** slice 1 §5.3's best-outcome-wins rationale attached to task 3.5's REFACTOR, where worked example C is the evidence. All 3 of 3 now owned.

### [5] Two acceptance criteria were built but never verified
- **Category:** missing coverage · **Severity:** Minor (AC3 Important in practice) · **Pass:** 1, resolved in 2
- **Documents:** slice 2 AC3 and AC5 vs. plan Phase 7 and task 8.1
- **Issue:** AC3 (container refuses to start on an unset or `change-me` key) was implemented in task 7.1's GREEN but asserted nowhere; AC5 (`Content-Type` + `X-Content-Type-Options: nosniff` on served images) was named in task 8.1's GREEN but its RED asserted only status codes. AC3 is a security control, and defect #8's whole character was that the broken guard is silent — a control never observed refusing is indistinguishable from one that doesn't.
- **Resolution:** AC3 gates at container level in Phase 7 with explicit `docker run` commands (it can't live in a RED beside in-process 401 tests, so it follows Phase 2's infra-gate pattern). AC5 folded into task 8.1's RED with a failure note explaining the sniffing surface.

### [6] Nothing populated `relatedIds` in a slice-1+3 build
- **Category:** missing coverage · **Severity:** Important · **Pass:** 2
- **Documents:** slice 3 dependency line and AC1 vs. slice 1 §9
- **Issue:** Slice 3 claims "Benefits from slice 2 but does not require it — `relatedIds` can be set by the seed." The seed didn't set them: slice 1 §9 never mentioned `relatedIds`, and the only writer anywhere in the spec set was slice 2 §9.3 step 8, marked *optional*. On the slice-1-then-3 path that slice 3 explicitly sanctions, task 11.2's RED could not go green, and slice 3 AC1 plus its e2e case had no data to assert against — leaving the manual-override layer, the first and highest-priority rule in §2.1 and the only one that shows curation rather than a heuristic, permanently unexercised.
- **Cause:** v1.0's §9 carried the clause "A few products should have curated `relatedIds` so manual recommendations are demonstrable." It was dropped when §9 was rewritten for slice 1, on the reasoning that `relatedIds` was slice 3's concern — but the *data* has to exist in slice 1's seed for slice 3 to stand alone.
- **Resolution:** Clause restored to slice 1 §9 (at least 3 products, 2–4 peers each). Task 1.3's RED asserts it and flags that a lone `relatedIds` failure *is* the slice-3 dependency; its REFACTOR notes the seed must be two-pass so the ids are real.

## Structural Change

Four of the six issues were requirements sitting in a **seam between phases** — the seed (Phases 1/2), the uploads `mkdir` (2/8), `relatedIds` (slices 1/3), and the `package.json` seed wiring (0/1/2). None belonged to a single phase's subject, which is exactly why each went missing.

Guard added: a **`⚙ Amends shared infrastructure`** marker on every phase that modifies `entrypoint.sh`, `package.json`, or the `Dockerfile` (Phases 1, 7, 8), with the convention documented in the plan's *How to read a task*. The instruction is to re-read the file rather than assume it's finished.

## Alignment Summary

- **Requirements:** 28 acceptance criteria across three slices — **all 28 owned by a task and verified by a gate**. Non-AC requirements: slice 2 §8.4 owned, 3 of 3 README notes owned, §9 seed and its `relatedIds` owned.
- **Tasks:** 31 tasks across 13 phases (plus 4 marked `[infra]` where a RED step would be ceremony). **Zero orphaned** — `workers: 1` now traces to §12.1, Next-version pinning to §7.5.
- **Design items:** 12 checked (§4.1–4.3, §5.3–5.6, §7.4, §7.5, slice 2 §2.1, §8.2, §8.4). **All aligned.**
- **TDD rewrite:** already applied — the plan is in RED/GREEN/REFACTOR form, so Phase 4 step 2 was skipped this pass.
- **Status: aligned.** Safe to begin execution at Phase 0.
