---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Existing Antithesis SDK Assertions

## Summary

**No Antithesis SDK assertions exist in this codebase.** The scan below found zero
imports of any Antithesis SDK and zero calls to `assert_always`, `assert_sometimes`,
`assert_reachable`, `assert_unreachable`, or their non-macro / JS equivalents
(`alwaysOrUnreachable`, `sometimes`, `reachable`, `unreachable`).

Every property in `property-catalog.md` therefore starts from zero instrumentation.
Where an evidence file says instrumentation is "missing," that is the default state
for this repo — nothing is "already there."

## Scan performed

| What | How | Result |
|---|---|---|
| Antithesis SDK package | `package.json` dependencies + devDependencies | Not present. Deps are `@prisma/client`, `next`, `prisma`, `react`, `react-dom`, `tsx`, `zod`. |
| Any mention of Antithesis | case-insensitive grep for `antithesis` across `*.ts`, `*.tsx`, `*.json`, `*.md`, `*.sh`, `Dockerfile` (excluding `node_modules`, `.next`) | Zero hits. |
| Assertion call sites | grep for `assert_always`, `assert_sometimes`, `assert_reachable`, `assert_unreachable`, `alwaysOrUnreachable`, `sometimes(`, `reachable(` | Zero hits. |
| `antithesis/` directory | filesystem | Did not exist before this research run. |

## Non-Antithesis assertion machinery that already exists

These are **not** Antithesis assertions, but they matter because they define
invariants the Antithesis workload can lift and reuse. They are throw-on-failure
checks confined to the test process — they never run in the served application.

### `src/lib/pricing/invariants.ts` — `assertInvariants(priced, label)`

The seven `specs/01` §5.2 invariants, implemented as a single function that
`throw`s a labeled `Error` on the first violation:

1. `discountTotalCents === Σ non-SHIPPING discount lines` ([invariants.ts:26](../../src/lib/pricing/invariants.ts#L26))
2. `discountTotalCents === Σ items[].lineDiscountCents` ([invariants.ts:33](../../src/lib/pricing/invariants.ts#L33))
3. `shippingDiscountCents === Σ SHIPPING discount lines` ([invariants.ts:40](../../src/lib/pricing/invariants.ts#L40))
4. `shippingCents >= 0` ([invariants.ts:47](../../src/lib/pricing/invariants.ts#L47))
5. per-line arithmetic + zero floor ([invariants.ts:50-59](../../src/lib/pricing/invariants.ts#L50-L59))
6. `subtotalCents === Σ lineSubtotalCents` ([invariants.ts:62](../../src/lib/pricing/invariants.ts#L62))
7. `totalCents === max(0, subtotal - discount + shipping + tax)` and `>= 0` ([invariants.ts:67-74](../../src/lib/pricing/invariants.ts#L67-L74))

**Where it is called:** only from Vitest specs (`engine.test.ts`). It is *not*
called on any API response path. The file's own doc comment says it is "called at
the end of EVERY engine test and on every API response in the cart-route tests" —
grep confirms there is no cart-route test file, and no route handler imports it.

This function is directly reusable by the Antithesis workload: it is pure, takes a
`PricedCart`, and has no I/O. The workload should call it against every
`PricedCart` returned by the API and convert its `throw` into an `Always`
assertion. See `properties/priced-cart-invariants-hold.md`.

### Vitest suites

`src/lib/**/*.test.ts` and `prisma/seed.test.ts` — unit coverage for the pure
engine, `allocate`, `money`, `config`, `recommend`, `admin-auth`, and the staging
generators. These run at build time only and exercise no concurrency, no
persistence, and no fault conditions.

### Playwright suites

`e2e/*.spec.ts` — browser-level acceptance tests. `playwright.config.ts` pins
`workers: 1` and `fullyParallel: false` specifically to avoid SQLite write
contention, so the suite exercises no concurrent access at all.

## Assumptions

- The scan covers the repository working tree at commit `3f1a675`. It does not
  cover the built `.next/` output (generated) or `node_modules/` (dependencies).

## Open Questions

- None.
