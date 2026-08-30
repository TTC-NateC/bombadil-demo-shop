# cart-endpoints-never-unhandled-500

## What led here

`specs/01` §7.3 enumerates what this slice may return: "`200` ok, `400`
validation, `404` unknown product/coupon." `specs/02` §6 extends the list to
201/401/409/413/415. 500 appears in neither.

Meanwhile no cart route has a `try`/`catch`, so every database exception becomes
one.

## Code paths

**The complete error-handling surface of the cart routes:**

| File | Structured errors it produces | Exceptions it catches |
|---|---|---|
| `src/app/api/cart/route.ts` | none | none |
| `src/app/api/cart/items/route.ts` | `validationError`, `apiError("NOT_FOUND", ...)`, `apiError("VALIDATION", ...)` | none |
| `src/app/api/cart/coupons/route.ts` | `validationError`, `apiError("VALIDATION", ...)` | none |
| `src/lib/cart.ts` | none — `priceAndPrune` throws `Error(\`Cart ${cartId} not found\`)` at line 93 | none |

`readJson` ([errors.ts:33-39](../../../src/lib/api/errors.ts#L33-L39)) catches
malformed JSON bodies, which is the one input-side exception that is handled.
Everything database-side propagates.

## What can throw

**P2002 — unique constraint.** Concurrent first-adds of the same product violate
`@@unique([cartId, productId])`. Cataloged in detail as
`cart-item-create-no-unique-violation`; this property is the catch-all around it.

**P2003 — foreign key.** A product deleted between the existence check and the
`cartItem.create`. Cataloged as `product-delete-cascades-cleanly`.

**P2025 — record not found.** `DELETE /api/cart/coupons` uses
`findUniqueOrThrow` ([coupons/route.ts:32](../../../src/app/api/cart/coupons/route.ts#L32)),
and `priceAndPrune` throws its own `Error` if the cart vanished between
`resolveCartId` and the load ([cart.ts:93](../../../src/lib/cart.ts#L93)).
Reachable via `DELETE /api/products?all=true` cascading carts away mid-request,
or by a stale cookie racing a reset.

**`SQLITE_BUSY` — the one this property is really aimed at.** SQLite permits one
writer at a time. No `journal_mode=WAL` and no `busy_timeout` are configured
anywhere in the repository, so a writer that finds the database locked fails
rather than waiting.

The project has already written down what happens when that occurs. From
`playwright.config.ts:11-17`, repeated in `specs/01` §12.1:

> "SQLite is single-writer. Parallel workers hitting one database file produce
> `SQLITE_BUSY` errors that surface as intermittent, plausible-looking pricing
> bugs. If this suite ever gets slow enough to matter, the fix is WAL mode plus a
> busy timeout — **NOT** more workers."

The mitigation chosen was `workers: 1` — applied to the test harness. The served
application has no equivalent, and no constraint on how many browsers reach it.
Note the second-order effect: the suite is now configured so that it cannot
observe the failure mode its own comment describes.

**`JSON.parse` on a torn column.** [cart.ts:95](../../../src/lib/cart.ts#L95)
parses `Cart.coupons` with no guard. See the per-cart-poisoning scenario in
`cart-eventually-readable.md`.

## Scope decision (2026-08-01): unchanged at P1

The user confirmed multi-shopper access is out of scope. This property keeps its
priority because three of its four causes survive intact:

| Cause | Status under the narrowed scope |
|---|---|
| P2002 (unique constraint) | Weakened — needs the narrow single-shopper path in `cart-item-create-no-unique-violation` |
| P2003 (foreign key) | **Unaffected** — an admin delete racing one shopper's add; admin-vs-shopper concurrency stays in scope |
| P2025 (`findUniqueOrThrow`) | **Unaffected** — same admin-vs-shopper mechanism |
| `SQLITE_BUSY` | **Unaffected** — see below |

The `SQLITE_BUSY` case is the important one, and it needs no second shopper. One
shopper's single click produces one write plus several more write-locking
`GET /api/cart` calls, because `notifyCartUpdated()` fires twice per mutation —
once in `mutateCart` ([cart-events.ts:23](../../../src/components/cart-events.ts#L23))
and again in the cart page's `run()` ([cart/page.tsx:59](../../../src/app/cart/page.tsx#L59))
— and `CartBadge` re-fetches on each. Every one of those GETs takes a write lock,
because `GET /api/cart` is a write (`sut-analysis.md` §11).

So the app supplies its own contention. This property is now the main beneficiary
of that observation, and it absorbs the detection coverage of the two category A
properties demoted to P2 — see the note in
`cart-item-create-no-unique-violation.md`.

## Why Antithesis is the right tool for the `SQLITE_BUSY` half

The window is the duration of a write lock — microseconds under normal load.
Antithesis widens it directly:

- **Node throttling** limits the container's CPU, stretching the time between a
  lock being taken and released.
- **CPU modulation** changes instruction-level timing, reordering concurrent
  continuations.
- **Node hang** freezes the container mid-operation.

Combined with concurrent workload requests — and with the write amplification
from `CartBadge` refreshes described in `sut-analysis.md` §4, where every
mutation triggers two extra `GET /api/cart` calls that each take a write lock —
this is a straightforward target.

## Assertion design

Three separate `Always` assertions, one per endpoint family:

- `/api/cart`
- `/api/cart/items`
- `/api/cart/coupons`

Not one shared assertion across all three. `references/property-catalog.md`
requires assertion messages to be unique and specific and warns against reusing
one message at unrelated call sites; more practically, a single message would
report "a cart endpoint 500'd" without saying which, and these three routes fail
for different reasons.

Each assertion's message carries the endpoint, the HTTP method, and the observed
status.

The check has two halves: `status < 500`, **and** on a 4xx the body matches the
documented `{ error: { message, code, details? } }` shape
([errors.ts:24-26](../../../src/lib/api/errors.ts#L24-L26)). The second half
matters because Next's default error response is not that shape, so a
malformed-body check catches cases where a 500 was converted to a 4xx somewhere
without being given the right envelope.

## Relationship to the specific-cause properties

`cart-item-create-no-unique-violation` and `product-delete-cascades-cleanly`
target two named causes and will fire with a diagnosable story attached. This
property is the net beneath them: it catches the causes nobody enumerated,
including `SQLITE_BUSY`, which has no single call site to point at.

Triage order on a failure: if this fires and neither specific property did, the
cause is contention or something unenumerated.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** the three `Always` assertions. Sufficient on their
  own — no SUT changes needed.
- **Missing, SUT-side (would aid triage, not detection):** the SUT has no
  structured logging and no error middleware, so a 500's cause is not recoverable
  from outside. An `Unreachable("unhandled exception escaped a cart route")` in a
  catch-all wrapper would both detect and identify. That is a code change beyond
  instrumentation, so it is a recommendation rather than a requirement.

## Open questions

None. The absence of error handling is verifiable by reading the four files
listed above, the permitted status codes are enumerated in `specs/01` §7.3 and
`specs/02` §6, and the `SQLITE_BUSY` mechanism is documented by the project
itself in `playwright.config.ts`.
