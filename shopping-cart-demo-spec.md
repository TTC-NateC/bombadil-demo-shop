# Demo Shopping Cart — Build Spec (index)

**Version:** 2.0
**Status:** Ready to hand to build agents
**Target:** A self-contained demo web app: browse products, manage a cart, apply/remove coupons, and see a fully itemized price breakdown. No real payments and no checkout flow. A robust, flexible coupon/pricing engine is the centerpiece.

> **v1.0 was a single 12-criterion document.** It has been split into three slices, each of which ships something useful on its own, and ten defects found in review have been resolved. See [Changelog](#changelog).

---

## The three slices

| # | Spec | Delivers | Depends on |
|---|---|---|---|
| 1 | [Core Shop & Pricing Engine](specs/01-core-shop-and-pricing-engine.md) | Catalog, cart, coupons, itemized breakdown, Docker. **The point of the project.** | — |
| 2 | [Admin API & Data Pipeline](specs/02-admin-api-and-data-pipeline.md) | Admin CRUD + bulk, image upload/serving, staging script | slice 1 |
| 3 | [Merchandising & Polish](specs/03-merchandising-and-polish.md) | Recommendations, toasts | slice 1 |

Build them in order — see the **[Implementation Plan](IMPLEMENTATION-PLAN.md)** for the 13 phases, their gates, and the traps list. Slice 1 is a complete, demonstrable product by itself; 2 and 3 are additive and neither is required to show the engine off.

**Neither slice 2 nor slice 3 adds a Prisma migration.** Slice 1 defines the full schema, including fields (`imageUrl` writes, `relatedIds`) that stay inert until later.

---

## Cross-cutting rules

These bind every slice and every agent.

1. **Money is integer cents**, everywhere, always. Formatting happens only at the view layer. Percentages are basis points (`1000 = 10%`).
2. **The pricing engine is the single source of truth for totals.** The client never computes money. Every cart-mutating endpoint returns a freshly-priced cart.
3. **The engine is pure.** No I/O. The API layer loads data and passes it in. Same for `recommend()`.
4. **The shared contract is slice 1 §5.1 (types) and §7 (API shapes).** Treat these as the interface boundary between agents; changing them is a spec edit, not an implementation detail.
5. **Tests ship with the feature that needs them**, not at the end. Each slice carries its own Vitest and Playwright specs. There is no terminal test-writing phase — see [Work breakdown](#work-breakdown).

---

## Work breakdown

Within a slice, agents can split along these lines:

**Slice 1** — Foundation (scaffold, Prisma, `money.ts`, config, seed, Dockerfile) · Engine (`engine.ts`, `allocate.ts`, `types.ts` + Vitest) · API + cart persistence · UI (three screens + test hooks) — each owning its own e2e specs.

**Slice 2** — Admin API + uploads · Staging script + pools — each with its own tests.

**Slice 3** — Recommendations (module, endpoints, UI) · Toasts — each with its own tests.

> **v1.0 assigned all Playwright work to a terminal "Agent E."** That agent was blocked until everyone else finished and then stood alone between the project and "done" — exactly where schedule pressure lands and coverage gets cut. Tests now belong to whoever builds the feature.

---

## Changelog

### Split (v1.0 → v2.0)
The original bundled ~20 endpoints, 3 screens, an engine, a recommendations module, an image pipeline, a CLI data generator, Docker, and two test frameworks behind 12 acceptance criteria — and conceded it needed five parallel agents. Cohesion was fine (everything served one product goal), but the size wasn't: nothing shipped until nearly all of it did. The three slices above each stand alone.

### Defects resolved

| # | Defect | Resolution |
|---|---|---|
| 1 | `FREE_SHIPPING` was subtracted **twice** from the total — once by zeroing shipping, once via `discountTotal` — and wrongly shrank the tax base. A `4000` cart came out `647` low. | `discountTotalCents` is items-only; new `shippingDiscountCents`. Slice 1 §5.2, worked example A. |
| 2 | "Current running discountable base" was undefined — no rule attributed cart-level discounts to lines, and `PricingLineItem` had nowhere to record them. Two honest readings differed by `2000` cents on one cart. | Per-line `lineDiscountCents`/`lineTotalCents`; every coupon allocates to lines with largest-remainder pennies; `priority` ties break on `code`. Slice 1 §5.4–5.5, worked example B. |
| 3 | Any exclusive coupon won unconditionally, so a shopper entering a valid code could **pay $8.10 more** on the spec's own seed data — and the acceptance criteria certified it. | `priceWithCouponSet` inner contract; N+1 candidate sets; winner is the lowest `totalCents`. Slice 1 §5.3, worked example C. |
| 4 | `CartItem.product` had no `onDelete`, so Prisma's default `Restrict` made `DELETE /api/products/[id]` throw `P2003` — breaking `--reset` precisely when you'd use it, right after a demo. | `onDelete: Cascade`, plus `unitPriceCentsSnapshot` so admin price edits can't reprice live carts or destabilize fixtures. Slice 1 §4.1–4.2. |
| 5 | The Dockerfile sketch couldn't boot: `npx prisma` had no CLI (network required at start), no `tsx` for the TS seed, the Prisma query engine wasn't copied, `COPY public` failed on a missing directory, and the schema had no `generator`/`datasource` block at all. | `node:20-slim`, real entrypoint script, `prisma`+`tsx` as runtime deps, explicit engine copies, complete schema blocks. Slice 1 §4, §10. |
| 6 | The cart cookie was specified as "signed" with no secret defined anywhere and no signing primitive in Next's `cookies()` — a security claim the build would not deliver. | Claim dropped; explicit attributes (`httpOnly`, `lax`, 30 d, `secure` in prod) with the rationale documented. Slice 1 §7.4. |
| 7 | The path-traversal mitigation guarded the **upload** path while the read route was a `[...path]` catch-all — and `/data/app.db` sits one level above `/data/uploads`. | Single-segment `[filename]` route, strict regex, resolve-containment, MIME table, `nosniff`, plus a negative test. Slice 2 §8.2. |
| 8 | `ADMIN_API_KEY` unset was undefined behaviour (one common implementation fails **open**), and `.env.example` shipped `change-me` — a known credential granting bulk catalog deletion on any instance built from the documented happy path. | Fail closed at startup *and* per request; `.env.example` ships empty and required. Slice 2 §2. |
| 9 | A coupon that stopped qualifying after being applied had no defined behaviour, and `rejectedCoupons` was carrying four distinct meanings — so every quantity tweak would re-fire a warning toast. | `Cart.coupons` holds exactly what applied last pass; everything else is pruned. `rejectedCoupons` narrows to transient apply-failures. Slice 1 §5.6, slice 3 §4.1. |
| 10 | Criterion 10 demanded "**exactly** N products" while the script was specified to skip failures and report `skipped: X`; append mode also collided on `slug @unique` every second run. | Criterion narrowed to `created + skipped === N` (and exactly N on a clean `--reset --seed` run); slugs pre-fetched and de-duplicated; seed reproducibility defined as identical **payloads**. Slice 2 §9.3, §9.5, §10. |

### Consequential changes

Two behaviours were not in the original and follow directly from the fixes above. They are called out because nobody chose them explicitly:

- **A `FREE_SHIPPING` coupon on an order that already qualifies for free shipping is now rejected** with `"Shipping is already free on this order"` (slice 1 §5.3). Once shipping discounts are separated from item discounts, a shipping discount of zero has no coherent meaning — rejecting it is honest and testable. It also means worked example C rejects `FREESHIP` at a `5000` subtotal.
- **The cart breakdown no longer renders `FREE_SHIPPING` as a negative row.** It renders `Shipping: FREE` with the coupon attributed beside it (slice 1 §8.3), which matches how threshold-driven free shipping already displayed — the original showed the two paths differently.
