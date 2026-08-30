# Slice 3 — Merchandising & Polish

**Version:** 2.0
**Status:** Ready to hand to build agents
**Depends on:** slice 1 (catalog, cart, engine, UI). Benefits from slice 2 but does not require it — `relatedIds` can be set by the seed.
**Ships on its own:** yes — recommendations and toasts are additive UX on a shop that already works.

> Adds **no** Prisma migrations. `Product.relatedIds` is already in slice 1's schema, inert until now.

---

## 1. Goals & Non-Goals

### Goals
- Surface **recommended / related products** when viewing an item and in the cart.
- Confirm every cart action with a non-blocking, auto-dismissing toast reflecting the **actual outcome**.

### Non-Goals
- No personalization, no behavioural tracking, no collaborative filtering. Deterministic rules only.
- No notification centre or history. Toasts are ephemeral.

---

## 2. Recommendations

Like pricing, this lives in a small **pure module** (`src/lib/recommend.ts`) so it is easy to test and swap out later.

### 2.1 Strategy (layered, deterministic fallback)
Given a source product (or a set of cart product IDs), build the list in this order, de-duplicating and excluding items already in the source/cart, until `limit` is reached:
1. **Manual overrides:** IDs in the product's `relatedIds` (curated "goes well with" picks). Highest priority, in the order listed.
2. **Same category:** other active products sharing the source `category`.
3. **Fallback:** other active products, in a stable order (newest first), so the section is never empty.

For the **cart**, aggregate across all cart items: union each item's recommendations, exclude anything already in the cart, and rank items recommended by multiple cart items first. Ties break by product `id` ascending so output is deterministic.

### 2.2 Signature
```ts
// src/lib/recommend.ts
export function recommend(input: {
  sourceProductIds: string[];   // one for PDP, many for cart
  catalog: Product[];           // active products, passed in — no I/O in the pure fn
  limit: number;                // default 4
}): Product[];
```

The API route loads the catalog from Prisma and passes it in.

### 2.3 API
**`GET /api/products/[slug]/recommendations`** → `{ products: Product[] }`. Supports `?limit=` (default 4). `404` if the slug is unknown.
**`GET /api/recommendations?productIds=a,b,c`** → `{ products: Product[] }`. Supports `?limit=` (default 4). Unknown IDs are ignored, not an error.

Both are public — no admin key.

### 2.4 Tests (Vitest)
- Manual `relatedIds` are honoured and ordered first.
- Category fill works and excludes the source item(s).
- Fallback triggers when the category yields too few.
- Cart aggregation excludes items already in the cart and ranks multi-hit items higher.
- Deterministic: the same input produces the same order across 100 shuffled catalog inputs.
- Never returns more than `limit`; never returns duplicates; never returns inactive products.

---

## 3. UI Additions

### 3.1 Product detail (`/product/[slug]`)
- **"You might also like"** below the fold: a row of recommended product cards from `GET /api/products/[slug]/recommendations`. Each card has an inline "Add to cart" so a shopper can add a recommendation without leaving the page.

### 3.2 Cart (`/cart`)
- **"Add to your order"** strip below the line items, from `GET /api/recommendations?productIds=...` for the current cart, each with an inline "Add" that updates the cart and the breakdown.

### 3.3 Test hooks
Extending slice 1 §8.5: `recommendation-card` (with `data-product-id`), `recommendation-add`, `toast` (with `data-variant`) inside the `aria-live` region.

---

## 4. Notifications (Toasts)

A global, non-blocking notification area confirms cart actions and auto-dismisses.

- **shadcn/ui Toast (or Sonner)** mounted once in `layout.tsx` via `<Toaster />`, anchored bottom-right (top on mobile). Toasts stack and never block interaction.
- **Trigger on the outcome of every cart mutation** — *after* the API returns the fresh `PricedCart`, so the message reflects what actually happened, not what was clicked:

| Action | Toast |
|---|---|
| Add item | success — `Added "<name>" to your cart` (include quantity if > 1) |
| Increase/decrease quantity | info — `Updated "<name>" (x<qty>)` |
| Remove item | info — `Removed "<name>" from your cart`, with an optional **Undo** that re-adds it |
| Apply coupon, accepted | success — `Coupon <CODE> applied — you saved $X.XX` |
| Apply coupon, rejected | warning — `Coupon <CODE> not applied: <reason>` |
| Remove coupon | info — `Coupon <CODE> removed` |
| Add a recommended item | success — same "Added" toast |
| Network/500 failure | destructive — `Something went wrong — please try again` |

### 4.1 Toast triggers vs. coupon state — read this before wiring it up

Fire the rejected-coupon toast **only** from `rejectedCoupons` on the response to an explicit `POST /api/cart/coupons`. Never from a `GET /api/cart`, and never from a quantity mutation.

Slice 1 §5.6 makes this safe by construction: `rejectedCoupons` means exactly one thing — *this apply attempt failed and was not persisted* — because any coupon that stops qualifying is **pruned** from `Cart.coupons` rather than lingering in the rejected list. So there is no population of "coupons I still hold but that didn't apply this pass" to accidentally toast about on every quantity tweak.

When pruning removes a coupon as a side effect of a quantity change, the chip simply disappears and the breakdown updates. Do not toast for it — the shopper did not attempt anything, and a warning they didn't ask for on every stepper click is noise.

### 4.2 Behaviour
- **Auto-dismiss:** success/info after ~3 s, warning/error after ~5 s. Hover pauses the timer; a manual close (×) is always available.
- **Variants:** success (add/apply), info (quantity, remove-coupon), destructive/warning (rejected coupon, errors).
- **Accessibility:** the toast region uses `aria-live="polite"`; error toasts use `aria-live="assertive"`.
- Keep messages short and specific; include the product or coupon name. No more than a few visible at once — older ones collapse or expire.

---

## 5. Acceptance Criteria

1. The product detail page shows a non-empty "You might also like" row, honouring `relatedIds`, then category, then fallback.
2. The cart shows recommendations excluding items already in the cart, ranking multi-hit items first.
3. Recommendation unit tests (§2.4) all pass, including the determinism test.
4. Every cart action surfaces an auto-dismissing toast reflecting the actual outcome: adding, removing and updating items, and applying and removing coupons.
5. An **accepted** coupon shows a success toast with the amount saved; a **rejected** coupon shows a warning toast with the reason from `rejectedCoupons` verbatim.
6. Changing a quantity in a way that prunes a coupon (slice 1 §5.6) fires **no** coupon toast — the chip disappears and the breakdown updates silently.
7. Toasts auto-dismiss (~3 s success / ~5 s warning), pause on hover, and can be closed manually.
8. The Playwright suite (§6) passes headless.

---

## 6. Acceptance Tests (Playwright)

`e2e/recommendations.spec.ts` and `e2e/toasts.spec.ts`, on slice 1's `webServer` harness.

- **Recommendations — PDP:** the row is non-empty; a product with curated `relatedIds` shows those first; adding a recommendation adds it to the cart.
- **Recommendations — cart:** the strip excludes items already in the cart; adding from it updates the breakdown.
- **Toast — add:** success toast shows `Added "<name>"`, then disappears within the expected window.
- **Toast — quantity and remove:** correct toasts fire; **Undo** on remove restores the item.
- **Toast — coupon accepted:** success toast shows the amount saved.
- **Toast — coupon rejected:** warning toast shows the reason verbatim.
- **Toast — no false positives:** apply `TAKE15` at `6000`, then drop the cart to `4000` so it is pruned → the chip disappears, the total updates, and **no toast appears** (`toHaveCount(0)` on the toast region).
- **Accessibility:** the toast region carries the expected `aria-live` value per variant.

### Conventions
- Assert both that a toast becomes visible **and** that it disappears. Never use fixed `sleep`s — rely on Playwright auto-waiting with `toBeVisible` / `toHaveCount(0)`.
- Assert on user-visible text, not internal state.
