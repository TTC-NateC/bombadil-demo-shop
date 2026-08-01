# Implementation Plan

**Derived from:** [the spec index](shopping-cart-demo-spec.md) and slices [1](specs/01-core-shop-and-pricing-engine.md) / [2](specs/02-admin-api-and-data-pipeline.md) / [3](specs/03-merchandising-and-polish.md)
**Shape:** 13 phases across 3 shippable slices. Each phase has an explicit gate; don't start the next one until the gate is green.
**Task format:** RED → GREEN → REFACTOR. See [How to read a task](#how-to-read-a-task).

---

## Two sequencing decisions worth understanding

**1. The container is proven in Phase 2, not at the end.** The instinct is to leave Docker until there's something to containerize. Defect #5 was "the Dockerfile can't boot" — Prisma's query engine isn't traced into Next's standalone output, and `npx prisma` at runtime needs network. Those failures are invisible locally and surface on someone else's laptop. Proving an *empty* app boots in a container costs an hour; discovering it after five phases of feature work costs a demo.

**2. The engine is built bottom-up, and `allocate()` comes first.** Every money invariant in slice 1 §5.2 depends on `Σ lineDiscountCents === discountTotalCents` holding exactly. That's `allocate()`'s job. Build and property-test it before anything calls it, or you'll be debugging one-cent drift through three layers of coupon logic.

## How to read a task

Each task is **RED → GREEN → REFACTOR**:

- **RED** — write the failing test first. It defines the behaviour before any code exists. Each task states *how* it should fail and *what it means if it passes anyway* — an unexpected pass usually means the feature already exists or an assumption is wrong, and both are worth knowing before you write code.
- **GREEN** — the minimum that passes. No anticipatory abstraction; the refactor step is where structure earns its place.
- **REFACTOR** — named, specific cleanups. This is the step that gets skipped unless it's written down.

**Not every task is code.** Provisioning, Dockerfiles, and schema authoring have no meaningful RED step, so they stay imperative and are marked **[infra]**. Forcing a test-first shape onto `npm create next-app` produces ceremony, not safety.

**Phases 6, 10 and 13 invert the pattern.** Their deliverable *is* the test suite, written against features that already work — so a new spec going green immediately is the expected outcome. A spec that stays red there is a genuine coverage gap in an earlier phase, not a normal TDD cycle.

**Watch for `⚙ Amends shared infrastructure`.** Phase 2 creates `entrypoint.sh`, `package.json` and the `Dockerfile`; later phases amend them. Because those files belong to no single phase's subject, requirements that live in them are the ones that go missing — four of the six findings across two alignment passes were exactly this. Where you see the marker, **re-read the file rather than assuming it's finished**.

---

## Build order

```
Phase 0  Scaffold & contracts ─┬─ Phase 1  Schema, data & seed ── Phase 2  Container proof
                               │
                               └─ Phase 3  Pricing engine  (pure — needs only types.ts)
                                              │
                          Phase 1 + 3 ────────┴─ Phase 4  Cart persistence & API
                                                             │
                                                             ├─ Phase 5  UI
                                                             └─ Phase 6  E2E          ══ SLICE 1 SHIPS
                                                                          │
                                       Phase 7  Admin auth + CRUD ────────┤
                                       Phase 8  Uploads                   │
                                       Phase 9  Staging script            │
                                       Phase 10 E2E                       ══ SLICE 2 SHIPS
                                                                          │
                                       Phase 11 Recommendations ──────────┤
                                       Phase 12 Toasts                    │
                                       Phase 13 E2E                       ══ SLICE 3 SHIPS
```

**The fork point is `src/lib/pricing/types.ts`.** Once it exists (Phase 0), Phase 3 (pure engine) and Phase 1→4 (persistence) are genuinely independent. If more than one person or agent is building, that's where to split. Phase 5 can also start against the API contract before Phase 4 finishes, but its gate needs a live API.

| Phase | Size | Blocks |
|---|---|---|
| 0 Scaffold & contracts | S | everything |
| 1 Schema, data layer & seed | M | 2, 4 |
| 2 Container proof | S | slice 1 shipping |
| 3 Pricing engine | **L** | 4 |
| 4 Cart persistence & API | M | 5, 6 |
| 5 UI | M | 6 |
| 6 E2E slice 1 | M | — |
| 7 Admin auth + CRUD | M | 8, 9 |
| 8 Uploads | M | 9, 10 |
| 9 Staging script | M | 10 |
| 10 E2E slice 2 | S | — |
| 11 Recommendations | M | 13 |
| 12 Toasts | S | 13 |
| 13 E2E slice 3 | S | — |

---

# Slice 1 — Core Shop & Pricing Engine

## Phase 0 — Scaffold & contracts

**Files** — `next.config.js`, `tsconfig.json`, `src/lib/pricing/types.ts`, `src/lib/money.ts`, `src/lib/pricing/config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `README.md`

### Task 0.1 — Scaffold **[infra]**
1. `create-next-app` with **Next.js 15**, TS + Tailwind + App Router. Read slice 1 §7.5 before writing any route or cart helper: `cookies()`, route `params`, and page `params`/`searchParams` are all Promises in 15, and getting it wrong is a type error in every file that touches them.
2. `shadcn` init — use the non-interactive defaults flag or pre-write `components.json`; the interactive prompt will hang an unattended run. Next 15 brings React 19, so expect peer-dependency prompts and take the documented resolution rather than hand-editing `package.json`.
3. `next.config.js` with `output: 'standalone'`; `tsconfig.json` with `strict: true`.
4. Scripts: `dev`, `build`, `start`, `test`, `test:e2e`, `db:migrate`, `db:seed`.

### Task 0.2 — The contract **[infra]**
Write `src/lib/pricing/types.ts` **completely** — all of slice 1 §5.1, plus the `COUPON_TYPES`/`TARGET_TYPES` constants and derived Zod schemas from §4.3. Includes `lineDiscountCents`, `lineTotalCents`, `shippingDiscountCents`.

No test: these are type declarations with no runtime behaviour. But this file is the contract every other phase builds against, and changing it later is a spec edit rather than a refactor — so write it in full now rather than growing it.

### Task 0.3 — `money.ts`
**Requirement:** slice 1 §2 (integer cents rule), §5.5 (half-up rounding)

**RED** — assert `roundHalfUp(2.5) === 3`, `roundHalfUp(-2.5) === -2`, `roundHalfUp(0.5) === 1`, and that `formatCents(123456, 'USD') === '$1,234.56'`.
*Expected failure:* module doesn't exist — import error.
*If it passes:* you've imported something else named `money`; check the path.

**GREEN** — `roundHalfUp` and `formatCents` only. No currency-conversion abstraction, no `Money` class.

**REFACTOR** — confirm `formatCents` takes currency as a parameter rather than reading config, so the view layer can pass `PricedCart.currency` straight through. Check no floating-point literal survives outside the rounding function itself.

### Task 0.4 — `config.ts`
**Requirement:** slice 1 §6

**RED** — assert that with a clean env, `loadConfig()` returns every §6 default (`USD`, `800`, `false`, `599`, `5000`); and that setting `TAX_RATE_BPS=1000` overrides only that field.
*Expected failure:* module doesn't exist.
*If it passes:* something is already reading `process.env` with the same defaults — find it before adding a second source of truth.

**GREEN** — read env, coerce to number/boolean, fall back to the §6 defaults.

**REFACTOR** — the coercion is about to be repeated in slice 2 (`MAX_UPLOAD_BYTES`). Make the int/bool readers reusable now rather than duplicating them later. Verify the defaults live in exactly one place and the table in §6 matches.

**Gate** — `npx tsc --noEmit` clean · `npm run build` succeeds · `npm test` green · `.next/standalone/` exists after build.

## Phase 1 — Schema, data layer & seed

**Files** — `prisma/schema.prisma` (slice 1 §4), `src/lib/db.ts`, `prisma/seed.ts` (slice 1 §9)

> **⚙ Amends shared infrastructure:** `package.json` — adds the `prisma.seed` key and `tsx` (task 1.3).

> Phase 2's entrypoint runs `prisma db seed` and its gate requires a booting container. That gate is unreachable until this phase's seed exists, so it belongs here rather than later.

### Task 1.1 — Schema **[infra]**
1. Write the schema exactly as §4 specifies — `generator`/`datasource` blocks, `String` not `enum` (§4.3), `onDelete: Cascade` on **both** `CartItem` relations, `unitPriceCentsSnapshot`.
2. **`npx prisma validate` before anything else.** Seconds, and it catches the connector-capability class of problem.
3. `npx prisma migrate dev --name init`, then `npx prisma generate`.
4. `db.ts` — Prisma client singleton with the dev hot-reload guard.

### Task 1.2 — Product deletion cascades out of carts
**Requirement:** slice 1 §4.2 (defect #4); enables slice 2 §4 `DELETE /api/products/[id]` and `--reset`

**RED** — create a Product, a Cart, and a CartItem linking them; delete the Product; assert the CartItem is gone and no error is raised.
*Expected failure:* `P2003` foreign-key constraint violation — Prisma's default for a required relation is `Restrict`.
*If it passes before you've added `onDelete: Cascade`:* the migration didn't apply, or SQLite foreign keys are off. Check `PRAGMA foreign_keys` — a pass here for the wrong reason hides the bug until slice 2.

**GREEN** — `onDelete: Cascade` on `CartItem.product`, migrate.

**REFACTOR** — assert the `CartItem.cart` cascade in the same test file; both relations are one concern and one regression risk. Extract the create-product-cart-item setup if Phase 4 will reuse it.

### Task 1.3 — Seed is idempotent
**Requirement:** slice 1 §9; acceptance criterion 1

**RED** — run the seed twice against a fresh DB; assert identical row counts after each run, that all five coupon codes (`SAVE10`, `TAKE15`, `FREESHIP`, `VIP25`, `ELECTRO20`) exist exactly once, and that **at least 3 products have non-empty `relatedIds`** whose ids all resolve to real products.
*Expected failure:* `prisma/seed.ts` doesn't exist — `prisma db seed` errors on the missing `prisma.seed` key.
*If it passes:* you're pointed at a stale DB file rather than a fresh one.
*If only the `relatedIds` assertion fails:* that's the slice-3 dependency — task 11.2's RED cannot go green without it, and slice 3 claims it doesn't need slice 2.

**GREEN** — `prisma/seed.ts` per §9: 12–20 products across 3–4 categories, the five named coupons, and curated `relatedIds` on at least 3 products (2–4 peers each), all via `upsert` on `slug`/`code`. Wire `package.json` → `"prisma": { "seed": "tsx prisma/seed.ts" }` and add `tsx` as a dependency — the same `tsx` Phase 2 installs into the runner image, because the seed being TypeScript is *why* the container needs it.

**REFACTOR** — pull the product and coupon fixtures into plain exported arrays so Phase 6's `globalSetup` can reuse them instead of redefining the catalog. Check every price is an integer and no coupon `value` is expressed as a decimal percentage. `relatedIds` must be written after the products exist, so their ids are real — a two-pass seed, not a hand-written guess.

**Gate** — `prisma validate` passes · `prisma migrate deploy` succeeds against a fresh empty file · tasks 1.2 and 1.3 green · `npx prisma db seed` twice leaves identical row counts.

## Phase 2 — Container proof **[infra]**

**Files** — `Dockerfile`, `docker/entrypoint.sh`, `.dockerignore`, `.env.example`, `docker-compose.yml` (optional)

No RED step — this is provisioning. The gate *is* the test, and it's deliberately harsh.

1. Multi-stage on `node:20-slim`: deps → build (`prisma generate` + `next build`) → runner.
2. Runner copies what standalone tracing does **not** provide: `node_modules/.prisma`, `node_modules/@prisma`, `prisma/`.
3. Install `prisma` and `tsx` as real runtime dependencies in the runner image.
4. `mkdir -p public` in build, or omit the `COPY public` line entirely.
5. `entrypoint.sh` per slice 1 §10 — `mkdir -p /data`, `migrate deploy`, `db seed`, `exec node server.js`.

**Gate** — `docker build` succeeds · everything resolves from inside the image, with no network:
```
docker run --rm --entrypoint sh <img> -c \
  'ls node_modules/.bin/prisma node_modules/.bin/tsx && ls node_modules/.prisma/client'
```
· `docker run -v cartdata:/data` boots and serves seeded data · stop, re-run, `/data/app.db` still holds its rows.

## Phase 3 — Pricing engine ← the centerpiece, and the largest phase

Strictly sequential. Each task's tests must be green before the next begins.

### Task 3.1 — `allocate()`
**Requirement:** slice 1 §5.5

**RED** — a property test: for randomised `amount` and `weights`, `Σ allocate(amount, weights) === amount` **exactly**. Cover zero weights, a zero total, a single weight, and amounts smaller than the weight count.
*Expected failure:* module doesn't exist.
*If it passes with a naive proportional implementation:* your generator isn't producing cases with fractional remainders — the whole point. Add weights that don't divide evenly, e.g. `allocate(8200, [80000, 2000])` and `allocate(100, [1, 1, 1])`.

**GREEN** — largest remainder: exact shares, floor, distribute the remainder to the largest fractional parts, ties by lower index.

**REFACTOR** — confirm determinism is explicit, not incidental: the same input must give the same output across runs, so the tie-break must be on index, never on sort stability. Name it `allocate`, not `distribute` — it's referenced by name in the spec.

### Task 3.2 — `priceWithCouponSet`: free shipping (worked example A)
**Requirement:** slice 1 §5.4, §5.7A; acceptance criterion 4 (defect #1)

**RED** — subtotal `4000`, `FREESHIP`, defaults. Assert **all** of: `discountTotalCents === 0`, `shippingDiscountCents === 599`, `shippingCents === 0`, `taxCents === 320`, `totalCents === 4320`.
*Expected failure:* function doesn't exist.
*If it returns `3673`:* you've put the shipping discount into `discountTotalCents` — that is defect #1 exactly, subtracting shipping twice and shrinking the tax base.

**GREEN** — the §5.4 pass for `FREE_SHIPPING` only. Shipping discounts land in `shippingDiscountCents`, never `discountTotalCents`.

**REFACTOR** — none yet; wait until 3.3 shows what the discount branches share.

### Task 3.3 — `priceWithCouponSet`: allocation & stacking (worked example B)
**Requirement:** slice 1 §5.4, §5.5, §5.7B (defect #2)

**RED** — Laptop `100000` (Electronics) + T-shirt `2000` (Apparel), `SAVE10` and `ELECTRO20` both at priority `100`. Assert `lineDiscountCents === [28000, 200]` and `discountTotalCents === 28200`.
*Expected failure:* function handles only `FREE_SHIPPING`.
*If you get `[20000, 8200]` or similar:* the cart-level coupon isn't allocating per line. If the result varies between runs, the priority tie isn't breaking on `code`.

**GREEN** — `PERCENT` and `FIXED` branches. Sort `(priority ASC, code ASC)`. Every coupon — `CART` included — allocates to matched lines through `allocate()`. Base is always `Σ (lineSubtotal − lineDiscount)` over matched lines.

**REFACTOR** — extract the target-matching predicate now shared by `PERCENT` and `FIXED` (`CART` → all, `CATEGORY` → category equality, `PRODUCT` → id equality). Extract the cap-and-clamp sequence (`maxDiscountCents`, then `min(amount, base)`) — it's identical in both branches and will be read closely by anyone auditing the money math.

### Task 3.4 — Eligibility & rejection reasons
**Requirement:** slice 1 §5.3 step 2

**RED** — one case per rule: inactive, expired, not-yet-started, `minSubtotalCents` unmet, target matching nothing, and `FREE_SHIPPING` when `shippingBaseCents === 0`. Assert each lands in `rejectedCoupons` with the §5.3 reason string verbatim.
*Expected failure:* no eligibility filter — coupons apply unconditionally.
*If the free-shipping case passes:* check it's rejected for the right reason and not merely producing a zero-amount line.

**GREEN** — the §5.3 step-2 filter. Compute `shippingBaseCents` in step 1 so the free-shipping rule can be evaluated here rather than at shipping time.

**REFACTOR** — the reason strings are about to be duplicated between the filter and the supersession logic in 3.5. Put them in one table keyed by cause, so the UI (Phase 5) and the toasts (Phase 12) render text that can't drift from the engine.

### Task 3.5 — `priceCart`: candidate sets & best outcome (worked example C)
**Requirement:** slice 1 §5.3, §5.7C; acceptance criteria 5 and 6 (defect #3)

**RED** — subtotal `5000` with `SAVE10`, `TAKE15`, `FREESHIP`, `VIP25`. Assert `totalCents === 3240` (the stackable pair wins), that `VIP25` is rejected with the "better price" reason, and that `FREESHIP` is rejected as already-free. Add the mirror case: an exclusive coupon that *does* beat the stackable set applies alone and rejects the others.
*Expected failure:* only `priceWithCouponSet` exists, so nothing chooses between sets.
*If you get `4050`:* the exclusive coupon is winning unconditionally — defect #3, the shopper paying more for a valid code.

**GREEN** — build `S0` (all stackables) plus each non-stackable alone, price each set, pick the lowest `totalCents`. Tie-break: fewest coupons, then smallest sorted code list. Losers get §5.3 step-6 reasons.

**REFACTOR** — `priceCart` should now read as *filter → build sets → price each → pick winner → attach reasons*, with all arithmetic inside `priceWithCouponSet`. If money math has leaked into the selection layer, move it back. **Write the README note on best-outcome-wins now** (§5.3) — worked example C is the evidence, and it's in front of you. This is the least obvious behaviour in the system and the one most likely to be challenged live; undocumented, a rejected exclusive coupon looks like the bug it exists to prevent.

### Task 3.6 — Invariants & the full matrix
**Requirement:** slice 1 §5.2, §5.8

**RED** — write `assertInvariants(pricedCart)` covering all seven §5.2 invariants, then call it in **every** existing engine test. Add the remaining §5.8 cases not yet covered: empty cart, single item no coupon, `FIXED` exceeding subtotal, `maxDiscountCents` cap, `TAX_ON_SHIPPING=true`, and the priority-tie determinism test across 100 shuffled inputs.
*Expected failure:* expect at least one existing test to break here — most likely `Σ lineDiscountCents === discountTotalCents` under a `FIXED` clamp, or a total that dips below zero on an over-large fixed discount.
*If everything passes first time:* verify the helper actually asserts rather than returning booleans nobody checks.

**GREEN** — fix whatever the invariants caught. Clamp per line at zero; clamp the total at zero.

**REFACTOR** — make `assertInvariants` the default epilogue of every engine test via a shared helper, so a future test can't silently skip it. This helper is what stops defects #1 and #2 from creeping back during Phases 4–13.

**Gate** — every §5.8 test green · `assertInvariants` called in all of them · priority-tie determinism green across 100 shuffles · `allocate` property test green.

## Phase 4 — Cart persistence & API

**Files** — `src/lib/cart.ts`, `src/app/api/products/route.ts`, `products/[slug]/route.ts`, `cart/route.ts`, `cart/items/route.ts`, `cart/coupons/route.ts`

### Task 4.1 — Cart cookie
**Requirement:** slice 1 §7.4, §7.5

**RED** — `GET /api/cart` with no cookie: assert a `cartId` is set with `httpOnly`, `sameSite=lax`, `path=/`, ~30-day `maxAge`; and that a second request carrying it resolves the same cart rather than creating another.
*Expected failure:* route doesn't exist.
*If the cookie is missing but the request succeeds:* the handler created a cart without persisting the cookie — every request will orphan a new row.

**GREEN** — `cart.ts` helpers, `await cookies()` per §7.5. `secure` only when `NODE_ENV === 'production'`.

**REFACTOR** — one `resolveCart(req)` used by every cart route; no route should read the cookie itself. Write the README note on why the cookie is deliberately unsigned (§7.4) **now**, while the reasoning is in front of you.

### Task 4.2 — Price snapshot
**Requirement:** slice 1 §4.1, §7.2

**RED** — add a product to a cart, change `Product.priceCents`, then `PATCH` the quantity. Assert `lineSubtotalCents` reflects the **original** price and the cart total is unchanged.
*Expected failure:* route doesn't exist.
*If the total moves:* the engine is reading `Product.priceCents` through the join instead of `CartItem.unitPriceCentsSnapshot`.

**GREEN** — capture the snapshot on create in `POST /api/cart/items`; never refresh it on `PATCH`.

**REFACTOR** — one mapper from `CartItem` + `Product` to `PricingLineItem`, used by every cart route, so no route can accidentally source the live price.

### Task 4.3 — Coupon pruning
**Requirement:** slice 1 §5.6; acceptance criterion 9

**RED** — apply `TAKE15` at subtotal `6000` (succeeds, persisted), reduce quantity to reach `4000`, re-fetch. Assert `TAKE15` is absent from `Cart.coupons`, absent from `discountLines`, and that the total reflects its removal. Separately: a rejected apply must not persist at all.
*Expected failure:* routes don't exist.
*If the coupon survives:* the prune isn't running on plain reads — it must run on **every** pricing pass, `GET` included.

**GREEN** — after each pricing pass, write back exactly the winning set's codes.

**REFACTOR** — the load → price → prune → persist → respond sequence is identical across all five cart routes. Extract it; a route that forgets the prune is a silent bug with no failing test elsewhere.

### Task 4.4 — Route contracts & validation
**Requirement:** slice 1 §7.1–7.3

**RED** — per route: a malformed body returns `400` in the `{ error: { message, code } }` shape; an unknown product or slug returns `404`; every successful cart mutation returns a `PricedCart` satisfying `assertInvariants`.
*Expected failure:* handlers return raw Prisma errors or `500`s.
*If a bad body succeeds:* Zod is parsing but the result isn't being used, or `safeParse`'s failure branch is unhandled.

**GREEN** — Zod on every body and query param; a single error formatter.

**REFACTOR** — derive request schemas from the §4.3 constants rather than re-listing coupon and target types. Reuse the Phase 3 `assertInvariants` helper in these API tests instead of writing a second copy.

**Gate** — tasks 4.1–4.4 green · `assertInvariants` holds on every `GET /api/cart` response.

## Phase 5 — UI

**Files** — `src/app/page.tsx`, `product/[slug]/page.tsx`, `cart/page.tsx`, `layout.tsx`, components

### Task 5.1 — Breakdown renders from `PricedCart`
**Requirement:** slice 1 §8.3, §8.4; acceptance criteria 3–5

**RED** — render the breakdown against a fixed `PricedCart` fixture built from worked example B. Assert each `data-testid` shows the literal expected string: `breakdown-subtotal`, one `breakdown-discount` per line with its `data-code`, `breakdown-shipping`, `breakdown-tax`, `breakdown-total`.
*Expected failure:* component doesn't exist.
*If a figure is right but you can't trace it to a response field:* the component is computing, which §8.4 forbids.

**GREEN** — render fields directly. `Intl.NumberFormat` with `PricedCart.currency`.

**REFACTOR** — no arithmetic operator in the component tree. All formatting through the one `money.ts` helper.

### Task 5.2 — Free shipping renders as FREE
**Requirement:** slice 1 §8.3

**RED** — with the worked-example-A cart, assert `breakdown-shipping` reads `FREE` with the coupon code attributed, and that **no** `breakdown-discount` row exists for `FREESHIP`. Then assert the threshold-driven case (subtotal ≥ `5000`, no coupon) renders identically.
*Expected failure:* component doesn't exist.
*If a negative `FREESHIP` row appears:* the component is rendering every `discountLine` uniformly, including `appliedTo: 'SHIPPING'`.

**GREEN** — filter `appliedTo === 'SHIPPING'` out of the discount rows; render the shipping row from `shippingCents` and `shippingDiscountCents`.

**REFACTOR** — one branch decides the shipping row for both the coupon and threshold paths; they must not diverge again.

### Task 5.3 — Coupon chips and rejection
**Requirement:** slice 1 §8.3, §5.6

**RED** — assert a `coupon-chip` per `discountLine` carrying `data-code`, and that a rejected apply renders `coupon-error` with the reason verbatim.
*Expected failure:* component doesn't exist.
*If chips render from a field that isn't `discountLines`:* there is no applied-coupons field — §5.6 removed the need for one.

**GREEN** — chips from `discountLines`; error from `rejectedCoupons`.

**REFACTOR** — reason strings pass through untouched. No client-side prettifying, or the UI drifts from the engine's table.

### Task 5.4 — Catalog and detail
**Requirement:** slice 1 §8.1, §8.2, §8.5

**RED** — catalog renders a `product-card` per seeded product, a placeholder when `imageUrl` is null, and a `cart-badge` reflecting item count; the detail page renders name, price, and quantity selector.
*Expected failure:* pages don't exist.

**GREEN** — the two pages, with every §8.5 `data-testid` added as each component is written — not retrofitted in Phase 6, which is how they get missed.

**REFACTOR** — one product-card component shared by catalog and (in Phase 11) the recommendation strips.

**Gate** — tasks 5.1–5.4 green · every rendered figure traceable to a response field · worked examples A/B/C reproducible by hand in the browser · all §8.5 testids present.

## Phase 6 — E2E slice 1

**Files** — `playwright.config.ts`, `e2e/catalog.spec.ts`, `cart.spec.ts`, `coupons.spec.ts`, `e2e/globalSetup.ts`

Inverted pattern — see [How to read a task](#how-to-read-a-task). These specs are written against working features, so **passing on first run is the expected outcome**. A spec that stays red is a coverage gap in Phases 1–5, not a normal cycle: fix it there and add the missing unit test, rather than patching the UI to satisfy the e2e.

1. `webServer` block: build + start against a throwaway SQLite file.
2. `globalSetup` seeds a known catalog and coupon set — reuse the Phase 1 fixture arrays.
3. **Set `workers: 1`** per §12.1. Parallel workers writing one SQLite file produce `SQLITE_BUSY` flake that reads like a product bug. If the suite gets slow later, the fix is WAL mode plus a busy timeout — not more workers.
4. Fresh `context` per spec. Trace/screenshot/video on failure.
5. All §12.2 scenarios, asserting the **literal expected cents** from §5.7 — never numbers the test recomputes.

**Gate** — `npm run test:e2e` green headless · slice 1 acceptance criteria 1–10 all demonstrably covered.

> ### ══ Slice 1 ships here. It is a complete, demonstrable product. ══

---

# Slice 2 — Admin API & Data Pipeline

## Phase 7 — Admin auth + product/coupon CRUD

> **⚙ Amends shared infrastructure:** `docker/entrypoint.sh` — adds the `ADMIN_API_KEY` startup refusal (task 7.1); `.env.example` — adds the admin and upload vars (slice 2 §2.2).

### Task 7.1 — The guard fails closed
**Requirement:** slice 2 §2.1; acceptance criterion 2 (defect #8)

**RED** — for an admin route: no header → `401`; wrong key → `401`; **`ADMIN_API_KEY` unset → `401`**; `change-me` → `401`; correct key → success.
*Expected failure:* routes don't exist, or admit everything.
*If the unset case succeeds:* you've written `if (configured && header !== configured)`, which **fails open**. That is the defect.

**GREEN** — reject unconditionally when unset or `change-me`, then compare. Add the startup check to `entrypoint.sh` per §2.1.

**REFACTOR** — one `requireAdmin(req)` guard, first line of every admin handler. Write the README note on the demo-grade guard now. Ship `.env.example` with `ADMIN_API_KEY=""`.

### Task 7.2 — Bulk is all-or-nothing
**Requirement:** slice 2 §4, §5; acceptance criterion 1

**RED** — a batch with one invalid row returns `400` with per-index errors and creates **zero** rows; an all-valid batch returns `201` with the correct `created` count.
*Expected failure:* endpoints don't exist.
*If a partial batch persists:* validation is per-row inside the write loop rather than up front, or there's no transaction.

**GREEN** — validate the whole array, then write in one transaction.

**REFACTOR** — one bulk handler shape shared by products and coupons; they differ only in schema and model.

### Task 7.3 — CRUD without repricing carts
**Requirement:** slice 2 §4, §5; acceptance criterion 10

**RED** — `PATCH` a product's price while it sits in a cart; assert the cart total is unchanged. `PATCH` a coupon to a colliding code → `409`. `DELETE` an unknown id → `404`.
*Expected failure:* endpoints don't exist.
*If the cart total moves:* Phase 4's snapshot isn't being honoured — fix it there, not here.

**GREEN** — the `PATCH`/`DELETE` handlers per §4 and §5.

**REFACTOR** — share the not-found and conflict responses with Phase 4's error formatter.

**Gate** — tasks 7.1–7.3 green · **AC3, the boot refusal, observed at container level** (it can't live in a RED alongside in-process 401 tests, so it gates here like Phase 2's infra checks):
```
docker run --rm -e NODE_ENV=production -e ADMIN_API_KEY= <img>            # expect non-zero exit + message
docker run --rm -e NODE_ENV=production -e ADMIN_API_KEY=change-me <img>   # same
```
This one is worth actually running rather than reasoning about: defect #8's whole character was that the broken guard is silent, so a control that has never been observed refusing is indistinguishable from one that doesn't.

## Phase 8 — Uploads

> **⚙ Amends shared infrastructure:** `docker/entrypoint.sh` — adds `mkdir -p /data/uploads` (task 8.2, slice 2 §8.4). Phase 7 also edits this file; don't assume it's settled.

### Task 8.1 — Traversal is unrepresentable
**Requirement:** slice 2 §8.2; acceptance criterion 5 (defect #7)

**RED** — `GET /uploads/..%2fapp.db` → `404`; `GET /uploads/../app.db` → `404`; `GET /uploads/nested/path.png` → `404`; a valid `<cuid>.png` → `200` **carrying `Content-Type: image/png` and `X-Content-Type-Options: nosniff`** (AC5).
*Expected failure:* route doesn't exist.
*If a traversal returns `200` or leaks bytes:* you have a catch-all route. Next's pathname normalisation is not a defence you can rely on across versions.
*If the `200` lacks the headers:* the route is streaming bytes without setting them — serving user-uploaded content from the app's own origin with no `nosniff` is the sniffing surface §8.2's MIME table exists to close.

**GREEN** — single-segment `[filename]` route, filename regex, `path.resolve` containment check, `Content-Type` from the MIME table, `nosniff`.

**REFACTOR** — the MIME table is the single source for both the served `Content-Type` and the extension derived at upload time. One table, both directions.

### Task 8.2 — Upload validation and round-trip
**Requirement:** slice 2 §8.1, §8.3; acceptance criterion 4

**RED** — **against a brand-new volume**: a `.txt` part → `415`; an oversized file → `413`; a valid PNG → `201` with a `/uploads/<cuid>.png` URL that then serves `200` and renders on the catalog.
*Expected failure:* endpoint doesn't exist.
*If a `.png`-named text file is accepted:* validation is reading the filename rather than the MIME type.
*If the valid PNG fails with `ENOENT`:* `UPLOAD_DIR` was never created — that's §8.4, and it only reproduces on a clean volume. A machine with `/data/uploads` already lying around will pass this test while the demo-day path stays broken.

**GREEN** — `POST /api/uploads` per §8.3, extension derived from the validated MIME type, server-side `<cuid>` naming. **Amend `docker/entrypoint.sh` (from Phase 2) to `mkdir -p /data/uploads`** per §8.4.

**REFACTOR** — one `storeUpload()` used by both `/api/uploads` and multipart `POST /api/products`, so the two paths can't validate differently.

**Gate** — tasks 8.1–8.2 green **on a fresh volume** · round-trip upload renders on the catalog · image survives a container restart.

## Phase 9 — Staging script

### Task 9.1 — Pure helpers
**Requirement:** slice 2 §9.3, §9.6

**RED** — with a fixed seed: the name composer is deterministic; the price picker respects bounds and charm-rounds to `roundTo`; the template resolver fills `valueRange`/`minSubtotalRange`; the slug de-duplicator suffixes on collision.
*Expected failure:* modules don't exist.
*If output varies between runs at a fixed seed:* something is calling global `Math.random` rather than the seeded generator.

**GREEN** — the helpers in `src/lib/staging/`, all taking the RNG as a parameter.

**REFACTOR** — no helper touches `fetch` or the filesystem; the script wires them to I/O. That's what makes them testable at all.

### Task 9.2 — Script behaviour
**Requirement:** slice 2 §9.1, §9.3, §9.5; acceptance criteria 7–9

**RED** — `--dry-run` writes nothing and emits schema-valid payloads; `--seed S` twice gives byte-identical payloads; `--reset --seed S` on a clean instance creates exactly N with `skipped: 0`; **running twice without `--reset` creates the full count both times**; `--products 0 --coupons 15` resolves category templates without failing.
*Expected failure:* script doesn't exist.
*If the second no-reset run reports skips:* slugs aren't being pre-fetched — §9.3 step 2.

**GREEN** — arg parsing, pool loading with built-in fallbacks, pre-fetch of existing slugs, create loop, summary.

**REFACTOR** — one payload builder shared by the dry-run and live paths, so dry-run can't drift from what actually gets posted.

**Gate** — tasks 9.1–9.2 green.

## Phase 10 — E2E slice 2

Inverted pattern. `e2e/admin-api.spec.ts` per slice 2 §11, including the traversal negatives and the delete-with-cart-reference case.

> ### ══ Slice 2 ships here. ══

---

# Slice 3 — Merchandising & Polish

## Phase 11 — Recommendations

### Task 11.1 — `recommend()`
**Requirement:** slice 3 §2.1, §2.4

**RED** — the full §2.4 set: `relatedIds` honoured and ordered first; category fill excludes the source; fallback triggers when the category is thin; cart aggregation excludes cart items and ranks multi-hit items higher; never exceeds `limit`; never duplicates; never returns inactive products; identical output across 100 shuffled catalog inputs.
*Expected failure:* module doesn't exist.
*If the determinism test fails:* a tie isn't breaking on `id` — §2.1.

**GREEN** — the three layers in order, de-duplicating as you go.

**REFACTOR** — layers as separate named functions composed in sequence, so "swap it out later" (§2) is real rather than aspirational.

### Task 11.2 — Endpoints and UI
**Requirement:** slice 3 §2.3, §3.1, §3.2; acceptance criteria 1–2

**RED** — `GET /api/products/[slug]/recommendations` returns a non-empty list honouring `relatedIds` and `404`s on an unknown slug; `GET /api/recommendations?productIds=…` ignores unknown ids; the PDP row and cart strip render `recommendation-card` with `data-product-id`; the cart strip excludes items already in the cart.
*Expected failure:* routes and components don't exist.

**GREEN** — both routes load the catalog and pass it to the pure function; both UI strips reuse the Phase 5 product card.

**REFACTOR** — one `<RecommendationStrip>` for PDP and cart, differing only in its data source.

**Gate** — tasks 11.1–11.2 green.

## Phase 12 — Toasts

### Task 12.1 — Toasts reflect outcomes
**Requirement:** slice 3 §4; acceptance criteria 4–5, 7

**RED** — each row of §4's table fires its toast **after** the API responds, with the product or coupon name in the text; an accepted coupon shows the amount saved; a rejected one shows the reason verbatim; auto-dismiss at ~3 s / ~5 s; hover pauses; manual close works; `aria-live` is `polite`, `assertive` for errors.
*Expected failure:* no `<Toaster />` mounted.
*If a toast fires before the response:* it's wired to the click, not the outcome — it will lie whenever the server disagrees.

**GREEN** — `<Toaster />` in `layout.tsx`; fire from mutation results.

**REFACTOR** — one `toastForMutation(result)` mapping responses to messages, so no call site invents its own wording.

### Task 12.2 — No false positives
**Requirement:** slice 3 §4.1; acceptance criterion 6

**RED** — apply `TAKE15` at `6000`, then reduce the cart to `4000` so it's pruned. Assert the chip disappears, the total updates, and the toast region has **`toHaveCount(0)`**.
*Expected failure:* a warning toast fires on the quantity change.
*If it passes immediately:* good — §5.6's prune design is what makes it structurally impossible. Keep the test; it guards the design.

**GREEN** — fire rejected-coupon toasts only from an explicit `POST /api/cart/coupons` response, never from `GET` or item mutations.

**REFACTOR** — make the constraint explicit at the call site so a future contributor can't wire the toast to a generic response handler.

**Gate** — tasks 12.1–12.2 green.

## Phase 13 — E2E slice 3

Inverted pattern. `e2e/recommendations.spec.ts` and `e2e/toasts.spec.ts` per slice 3 §6, including the no-false-positive assertion.

> ### ══ Slice 3 ships here. ══

---

## Traps — do not reintroduce

Each of these was a defect found in review. They're listed because they are all things an implementer will naturally write if they aren't watching for them.

| Don't | Do | Defect | Caught by |
|---|---|---|---|
| Add `FREE_SHIPPING` amounts into `discountTotalCents` | Keep it in `shippingDiscountCents` | #1 | 3.2 |
| Round each line's share half-up independently | `allocate()` with largest remainder | #2 | 3.1, 3.3 |
| Leave `priority` ties to database order | Sort `(priority ASC, code ASC)` | #2 | 3.3, 3.6 |
| Let any exclusive coupon win unconditionally | Price all candidate sets; lowest `totalCents` wins | #3 | 3.5 |
| Read `Product.priceCents` in the engine | Read `CartItem.unitPriceCentsSnapshot` | #4 | 4.2, 7.3 |
| `npx prisma …` in the container `CMD` | `prisma` + `tsx` as runtime deps | #5 | Phase 2 gate |
| Declare `enum` in a SQLite Prisma schema | `String` + TS union + Zod (§4.3) | §4.3 | 1.1 |
| Call the cart cookie "signed" | Unsigned with documented rationale | #6 | 4.1 |
| `GET /uploads/[...path]` | `GET /uploads/[filename]` + regex + resolve-check | #7 | 8.1 |
| `if (configured && header !== configured) return 401` | Reject unconditionally when unset — this **fails open** | #8 | 7.1 |
| Toast on a coupon pruned by a quantity change | Toast only from an explicit apply | #9 | 12.2 |
| Assert `products.length === N` after staging | Assert `created + skipped === N` | #10 | 9.2 |

## Early-validation checklist

Five things that are cheap to check now and expensive to discover later:

- [ ] `npx prisma validate` — connector capability (task 1.1, first action)
- [ ] Prisma engine + `tsx` resolve inside the built image, offline (Phase 2 gate)
- [ ] Next 15 async `cookies()`/`params` shape understood before Phase 4 writes cart helpers (task 0.1)
- [ ] `allocate()` property test green before any coupon logic calls it (task 3.1)
- [ ] Playwright `workers: 1` set before the suite grows (Phase 6)

## Alignment status

**Aligned.** Two [alignment passes](paad/alignment-reviews/2026-07-31-demo-shop-alignment.md) found six issues; all are resolved in the specs or in this plan. Every acceptance criterion has an owning task and a gate that verifies it, and every task traces to a stated requirement.

Four of the six were requirements sitting in a seam between phases — which is why the `⚙ Amends shared infrastructure` markers exist. If you add a phase that touches `entrypoint.sh`, `package.json`, or the `Dockerfile`, add the marker too.
