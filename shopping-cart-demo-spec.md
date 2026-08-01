# Demo Shopping Cart — Build Spec

**Version:** 1.0
**Status:** Ready to hand to build agents
**Target:** A self-contained demo web app: browse products, manage a cart, apply/remove coupons, and see a fully itemized price breakdown. No real payments and no checkout flow. A robust, flexible coupon/pricing engine is the centerpiece. Admin API endpoints allow bulk-creating products and coupons.

---

## 1. Goals & Non-Goals

### Goals
- Browse a catalog of products.
- Add/remove/update quantities in a cart.
- Show **recommended / related products** when viewing an item and in the cart.
- Apply and remove coupons.
- Show a clear, itemized price breakdown (subtotal, per-discount lines, shipping, tax, total).
- Provide a **robust, flexible, well-tested pricing engine** that is the source of truth for all totals.
- Provide **admin API endpoints** to bulk-create products and coupons (for seeding demos quickly).
- Deploy as a **single Docker container**, no external services required.

### Non-Goals
- No real payment processing (no Stripe/PayPal).
- No full checkout / order-placement flow. (The cart is the terminal screen.)
- No user accounts / authentication for shoppers (cart is per-session).
- No inventory management, shipping carrier integration, or fulfillment.

---

## 2. Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Next.js 14+ (App Router)** | Single app serves UI + API routes. |
| Language | **TypeScript** (strict) | Shared types across UI, API, and engine. |
| Styling | **Tailwind CSS + shadcn/ui** | Fast, consistent, agent-friendly components. |
| Data | **SQLite + Prisma** | File-based DB inside the container. No external service. |
| Cart storage | **Session cookie** (signed, httpOnly) holding a `cartId` | Cart rows persisted in SQLite, keyed by cartId. |
| Money | **Integer minor units (cents)** everywhere | Never use floats for money. Format only at the view layer. |
| Testing | **Vitest** unit tests (engine + recommendations) **and Playwright** acceptance tests (both required) | Pure logic covered by unit tests; end-to-end flows covered by Playwright (§13). |
| Container | **Single Docker image**, Next.js standalone output | SQLite file lives on a volume or baked-in seed. |

> **Rule for all agents:** money is stored and computed as **integer cents**. Currency formatting happens only when rendering. This avoids floating-point drift in discounts and tax.

---

## 3. Repository Layout

```
/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                # minimal baseline seed (products + coupons)
├── scripts/
│   └── stage-data.ts          # bulk staging script (drives admin API) — §9b
├── e2e/                       # Playwright acceptance tests — §13
│   ├── catalog.spec.ts
│   ├── cart.spec.ts
│   ├── coupons.spec.ts
│   ├── recommendations.spec.ts
│   ├── admin-api.spec.ts
│   └── fixtures/              # seeded state + sample upload image
├── playwright.config.ts
├── staging/                   # sample input pools for stage-data.ts
│   ├── product-names.json
│   ├── descriptions.json
│   ├── categories.json
│   ├── coupons.json
│   ├── price-config.json
│   └── images/                # sample product images
├── src/
│   ├── app/
│   │   ├── page.tsx           # catalog (product grid)
│   │   ├── product/[slug]/page.tsx
│   │   ├── cart/page.tsx      # cart + coupon + breakdown
│   │   ├── layout.tsx
│   │   └── api/
│   │       ├── products/route.ts          # GET list, POST create
│   │       ├── products/bulk/route.ts      # POST bulk create (admin)
│   │       ├── coupons/route.ts            # GET list, POST create
│   │       ├── coupons/bulk/route.ts       # POST bulk create (admin)
│   │       ├── cart/route.ts               # GET current cart (priced)
│   │       ├── cart/items/route.ts         # POST add, PATCH qty, DELETE remove
│   │       └── cart/coupons/route.ts       # POST apply, DELETE remove
│   ├── lib/
│   │   ├── pricing/
│   │   │   ├── engine.ts       # pure pricing engine (no I/O)
│   │   │   ├── rules.ts        # coupon rule evaluators
│   │   │   ├── types.ts        # PricedCart, DiscountLine, etc.
│   │   │   └── engine.test.ts  # Vitest unit tests
│   │   ├── db.ts               # Prisma client singleton
│   │   ├── cart.ts             # cart persistence + cookie helpers
│   │   └── money.ts            # cents math + formatting
│   └── components/ui/...       # shadcn components
├── Dockerfile
├── docker-compose.yml         # optional convenience
├── .env.example
└── README.md
```

---

## 4. Data Model (Prisma)

```prisma
model Product {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  description String?
  priceCents  Int                       // unit price in cents
  currency    String   @default("USD")
  category    String?
  imageUrl    String?
  active      Boolean  @default(true)
  relatedIds  String   @default("[]")  // JSON array of productIds: manual recommendations
  createdAt   DateTime @default(now())
  cartItems   CartItem[]
}

model Coupon {
  id            String   @id @default(cuid())
  code          String   @unique          // case-insensitive match at apply time
  description   String?
  type          CouponType                 // see enum
  // value semantics depend on type:
  //  PERCENT      -> value = basis points off (e.g. 1000 = 10%)
  //  FIXED        -> value = cents off
  //  FREE_SHIPPING-> value ignored
  value         Int      @default(0)
  // Targeting: null = whole cart. Otherwise restrict to matching items.
  targetType    TargetType @default(CART) // CART | CATEGORY | PRODUCT
  targetValue   String?                    // category name or productId
  // Eligibility rules:
  minSubtotalCents Int?                     // minimum cart subtotal to qualify
  maxDiscountCents Int?                     // cap on discount amount
  stackable     Boolean  @default(true)     // can combine with other coupons
  priority      Int      @default(100)      // lower applies first
  startsAt      DateTime?
  endsAt        DateTime?
  usageLimit    Int?                        // optional global cap (demo: informational)
  active        Boolean  @default(true)
  createdAt     DateTime @default(now())
}

enum CouponType { PERCENT FIXED FREE_SHIPPING }
enum TargetType { CART CATEGORY PRODUCT }

model Cart {
  id        String     @id @default(cuid())
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  items     CartItem[]
  coupons   String     @default("[]")   // JSON array of applied coupon codes
}

model CartItem {
  id        String  @id @default(cuid())
  cartId    String
  productId String
  quantity  Int     @default(1)
  cart      Cart    @relation(fields: [cartId], references: [id], onDelete: Cascade)
  product   Product @relation(fields: [productId], references: [id])
  @@unique([cartId, productId])
}
```

> **Store settings** (tax rate, shipping rule, free-shipping threshold) are read from env / a small config module (`src/lib/pricing/config.ts`) so agents don't hardcode them. Defaults in §6.

---

## 5. The Pricing Engine (centerpiece)

The engine is a **pure function**: given a cart snapshot + applicable coupons + store config, it returns a fully itemized `PricedCart`. It performs **no I/O** — the API layer loads data and passes it in. This keeps it trivially unit-testable and reusable.

### 5.1 Signature

```ts
// src/lib/pricing/types.ts
export interface PricingLineItem {
  productId: string;
  name: string;
  category?: string;
  unitPriceCents: number;
  quantity: number;
  lineSubtotalCents: number;      // unit * qty, pre-discount
}

export interface DiscountLine {
  couponCode: string;
  description: string;
  type: 'PERCENT' | 'FIXED' | 'FREE_SHIPPING';
  amountCents: number;            // positive number representing amount removed
  appliedTo: 'CART' | 'CATEGORY' | 'PRODUCT' | 'SHIPPING';
}

export interface RejectedCoupon {
  couponCode: string;
  reason: string;                 // human-readable, e.g. "Minimum spend of $50 not met"
}

export interface PricedCart {
  items: PricingLineItem[];
  subtotalCents: number;          // sum of line subtotals
  discountLines: DiscountLine[];  // one per successfully applied coupon
  discountTotalCents: number;
  shippingCents: number;          // after free-shipping coupons
  taxCents: number;               // computed on (subtotal - discounts), configurable
  totalCents: number;             // final amount, never below 0
  rejectedCoupons: RejectedCoupon[];
  currency: string;
}

export function priceCart(input: {
  items: PricingLineItem[];
  coupons: Coupon[];              // candidate coupons (already looked up by code)
  config: StoreConfig;
}): PricedCart;
```

### 5.2 Evaluation order (deterministic)

1. **Compute line subtotals** → `subtotalCents`.
2. **Filter coupons for eligibility**, collecting reasons for any rejected:
   - `active === true`
   - within `startsAt`/`endsAt` window (if set)
   - `subtotalCents >= minSubtotalCents` (if set)
   - target actually matches something in the cart (a PRODUCT/CATEGORY coupon with no matching items is rejected).
3. **Resolve stacking:** sort eligible coupons by `priority` (asc), then apply. If a coupon has `stackable === false`, only it applies among coupons — a non-stackable coupon cannot be combined; the engine keeps the single best-value non-stackable coupon if multiple non-stackables are present, and rejects the rest with a reason. (See §5.4 for the exact rule.)
4. **Apply discounts in order**, each computed against the **current running discountable base** (so percentage coupons stack sensibly and never drive a line below zero):
   - `PERCENT`: `round(base * value / 10000)` where base = the targeted amount (whole cart, or sum of matching items' current discounted value). Basis points avoid rounding surprises (1000 = 10%).
   - `FIXED`: `min(value, currentTargetedAmount)` cents.
   - `FREE_SHIPPING`: sets a flag; handled at shipping step, produces a `DiscountLine` with `appliedTo: 'SHIPPING'`.
   - Apply `maxDiscountCents` cap if set.
5. **Shipping:** compute base shipping from config; if any FREE_SHIPPING coupon applied OR subtotal ≥ free-shipping threshold, shipping = 0 (record the discount line for the coupon case).
6. **Tax:** `round((subtotal - discountTotal) * taxRateBps / 10000)`, on the post-discount, pre-shipping amount by default (configurable to include shipping).
7. **Total:** `max(0, subtotal - discountTotal + shipping + tax)`.
8. Return the fully populated `PricedCart`, including `rejectedCoupons` so the UI can explain why a code didn't apply.

### 5.3 Rounding rules
- All rounding is **half-up** on the final cents of each computed discount/tax line.
- Never allow any line or the grand total to go negative.
- Percentages use **basis points** (integer) to keep math exact.

### 5.4 Stacking rule (make it explicit for agents)
- Coupons with `stackable: true` combine in `priority` order.
- If one or more `stackable: false` coupons are present, the engine picks the **single** non-stackable coupon that yields the **largest discount**, applies it **alone** (no other coupons), and rejects all other applied coupons with reason `"Coupon X cannot be combined with other coupons"`. This makes "exclusive" promo codes behave predictably. Document this in the README so it's a deliberate, testable decision.

### 5.5 Required unit tests (Vitest)
Agents must cover at least:
- Empty cart → zeros.
- Single item, no coupon.
- PERCENT on whole cart; verify basis-point rounding.
- FIXED larger than subtotal → clamps, total not negative.
- Two stackable coupons → correct sequential base.
- Non-stackable vs stackable → exclusive one wins, others rejected with reasons.
- CATEGORY/PRODUCT-targeted coupon with and without matching items.
- `minSubtotalCents` gating (met vs not met).
- `maxDiscountCents` cap.
- FREE_SHIPPING coupon and free-shipping threshold.
- Tax computed on discounted subtotal.

---

## 5b. Recommendations

When a shopper views a product (or their cart), the app surfaces additional recommended items. Like pricing, this lives in a small **pure module** (`src/lib/recommend.ts`) so it's easy to test and swap out later.

### 5b.1 Strategy (layered, deterministic fallback)
Given a source product (or a set of cart product IDs), build the recommendation list in this order, de-duplicating and excluding items already in the source/cart, until `limit` is reached:
1. **Manual overrides:** any IDs listed in the product's `relatedIds` (curated "goes well with" picks). Highest priority.
2. **Same category:** other active products sharing the source `category`.
3. **Fallback:** other active products (e.g., newest or a stable pseudo-random order) so the section is never empty.

For the **cart** endpoint, aggregate across all cart items: union each item's recommendations, exclude anything already in the cart, and rank items that are recommended by multiple cart items first.

### 5b.2 Signature
```ts
// src/lib/recommend.ts
export function recommend(input: {
  sourceProductIds: string[];   // one for PDP, many for cart
  catalog: Product[];           // active products (passed in, no I/O in the pure fn)
  limit: number;                // default 4
}): Product[];
```
Keep it a pure function; the API route loads the catalog from Prisma and passes it in.

### 5b.3 Tests
- Manual `relatedIds` are honored and ordered first.
- Category fill works and excludes the source item(s).
- Fallback triggers when category yields too few.
- Cart aggregation excludes items already in the cart and ranks multi-hit items higher.
- Never returns more than `limit`; never returns duplicates.

---

## 6. Store Configuration (defaults)

`src/lib/pricing/config.ts`, overridable via env:

| Setting | Env var | Default |
|---|---|---|
| Currency | `STORE_CURRENCY` | `USD` |
| Tax rate (bps) | `TAX_RATE_BPS` | `800` (8.00%) |
| Tax includes shipping | `TAX_ON_SHIPPING` | `false` |
| Flat shipping (cents) | `SHIPPING_FLAT_CENTS` | `599` |
| Free shipping threshold (cents) | `FREE_SHIPPING_THRESHOLD_CENTS` | `5000` |

---

## 7. API Specification

All endpoints return JSON. Money fields are integer cents. Admin endpoints are guarded by a shared secret header `x-admin-key` (compared to env `ADMIN_API_KEY`); this is a demo-grade guard, documented as such.

### 7.1 Products

**`GET /api/products`** → `{ products: Product[] }` (active only, `?all=true` to include inactive).

**`POST /api/products`** (admin) — create one product. Accepts **either** JSON or `multipart/form-data`:
- **JSON:** `{ slug?, name, description?, priceCents, category?, imageUrl?, active?, relatedIds? }` — `imageUrl` references an existing/external image.
- **multipart/form-data:** the same fields as form fields, plus an optional `image` file part. When an `image` is present it is saved (see §7.5) and the stored path becomes the product's `imageUrl`. If both `image` and `imageUrl` are provided, the uploaded `image` wins.

→ `201 { product }`. `slug` auto-generated from name if omitted. Image is optional; omitted → `imageUrl` is null and the UI shows a placeholder.

**`POST /api/products/bulk`** (admin) — bulk create.
Body: `{ products: NewProduct[] }` (array).
→ `201 { created: number, products: Product[] }`. Validates every row; on any invalid row returns `400` with per-index errors and creates nothing (all-or-nothing).

**`PATCH /api/products/[id]`** (admin) — update a product. Body: any subset of the product fields (partial update); JSON or `multipart/form-data` if replacing the image. → `200 { product }`, `404` if unknown.

**`DELETE /api/products/[id]`** (admin) — delete a product. → `200 { deleted: true }`, `404` if unknown. Cascades to remove it from any carts. Optionally deletes its uploaded image file.

**`DELETE /api/products`** (admin) — bulk delete. Body `{ ids: string[] }` **or** `?all=true` to clear the whole catalog (used by staging `--reset`). → `200 { deleted: number }`.

**`GET /api/products/[slug]/recommendations`** → `{ products: Product[] }` — recommended items for a single product (see §5b for the strategy). Supports `?limit=` (default 4).

**`GET /api/recommendations?productIds=a,b,c`** → `{ products: Product[] }` — recommendations for a set of items (used by the cart to suggest add-ons). Supports `?limit=` (default 4).

### 7.2 Coupons

**`GET /api/coupons`** (admin) → `{ coupons: Coupon[] }`.

**`POST /api/coupons`** (admin) — create one.
Body mirrors the Coupon model (code, type, value, targetType, targetValue, minSubtotalCents, maxDiscountCents, stackable, priority, startsAt, endsAt, active).
→ `201 { coupon }`. `code` normalized to uppercase; duplicate code → `409`.

**`POST /api/coupons/bulk`** (admin) — bulk create, same all-or-nothing validation as products.

**`PATCH /api/coupons/[id]`** (admin) — update a coupon (partial update, any subset of fields). → `200 { coupon }`, `404` if unknown, `409` on code collision.

**`DELETE /api/coupons/[id]`** (admin) — delete a coupon. → `200 { deleted: true }`, `404` if unknown. Any cart referencing the removed code simply drops it on next pricing pass.

**`DELETE /api/coupons`** (admin) — bulk delete. Body `{ ids: string[] }` or `{ codes: string[] }`, **or** `?all=true` to clear all coupons (used by staging `--reset`). → `200 { deleted: number }`.

### 7.3 Cart

Cart is resolved from the `cartId` cookie; if none, one is created and the cookie set.

**`GET /api/cart`** → `PricedCart` (runs the pricing engine over current items + applied coupons).

**`POST /api/cart/items`** — add item. Body `{ productId, quantity=1 }`. Upserts quantity. → `PricedCart`.

**`PATCH /api/cart/items`** — set quantity. Body `{ productId, quantity }`. `quantity=0` removes. → `PricedCart`.

**`DELETE /api/cart/items?productId=...`** — remove item. → `PricedCart`.

**`POST /api/cart/coupons`** — apply coupon. Body `{ code }`. Looks up coupon; adds to cart's applied list; returns `PricedCart`. If the coupon is ineligible it still returns `PricedCart` with the code listed under `rejectedCoupons` (so UI shows why) and does **not** persist it.

**`DELETE /api/cart/coupons?code=...`** — remove an applied coupon. → `PricedCart`.

> **Every cart-mutating endpoint returns the freshly-priced cart** so the client never computes totals itself. The pricing engine is the single source of truth.

### 7.4 Validation & errors
- Use a schema validator (Zod) on all request bodies (parse form fields the same way after reading them off `formData`).
- Standard error shape: `{ error: { message, code, details? } }`.
- HTTP codes: 200 ok (update/delete), 201 created, 400 validation, 401 bad/missing admin key, 404 unknown product/coupon, 409 duplicate/code collision, 413 file too large, 415 unsupported media type.
- All admin write endpoints (POST/PATCH/DELETE on products and coupons) require the `x-admin-key` header.

### 7.5 Image uploads & storage
Kept dead simple for a single container — no S3, no external CDN.
- Uploaded files are written to a persistent uploads directory on the mounted volume: `/data/uploads` (configurable via `UPLOAD_DIR`). This lives under the same `/data` volume as the SQLite DB so images survive restarts.
- The stored `imageUrl` is a relative path like `/uploads/<cuid>.<ext>`.
- Files are served back by a lightweight route handler **`GET /uploads/[...path]`** (or Next's public/static mechanism) that streams the file from `UPLOAD_DIR` with the correct `Content-Type`. Do not trust or reflect the client's filename into the path — generate the stored name server-side (`<cuid>.<ext>`) to avoid path traversal.
- **Validation:** accept `image/png`, `image/jpeg`, `image/webp`, `image/gif` only (→ 415 otherwise); max size `MAX_UPLOAD_BYTES` default 5 MB (→ 413 otherwise). Derive the extension from the validated MIME type, not the original filename.
- **Optional standalone endpoint** for decoupled/bulk flows: **`POST /api/uploads`** (admin, multipart with an `image` part) → `201 { url }`. Callers can then reference that `url` as `imageUrl` in `POST /api/products` or the bulk endpoint. This keeps `/api/products/bulk` pure JSON.
- Config additions: `UPLOAD_DIR` (default `/data/uploads`), `MAX_UPLOAD_BYTES` (default `5242880`).

---

## 8. UI Specification

Three screens, all using shadcn/ui + Tailwind. Keep it clean and demo-friendly.

### 8.1 Catalog (`/`)
- Responsive product grid (card: image, name, price, category badge, "Add to cart").
- Optional category filter chips.
- Cart badge in the header showing item count; links to `/cart`.

### 8.2 Product detail (`/product/[slug]`)
- Larger image, description, price, quantity selector, "Add to cart".
- **"You might also like" section** below the fold: a row of recommended product cards from `GET /api/products/[slug]/recommendations`. Each card has an inline "Add to cart" so a shopper can add a recommendation without leaving the page.

### 8.3 Cart (`/cart`) — the important screen
- Line items: image, name, unit price, quantity stepper (updates via API), remove button.
- **Coupon box:** text input + "Apply". Shows applied coupons as removable chips. If a code is rejected, show an inline message with the reason from `rejectedCoupons`.
- **Price breakdown panel** (right/side), rendered directly from `PricedCart`:
  ```
  Subtotal                     $XX.XX
  ─ Coupon SAVE10 (10% off)   -$X.XX
  ─ Coupon FREESHIP           -$X.XX
  Shipping                      $X.XX   (or "FREE")
  Tax (8%)                      $X.XX
  ─────────────────────────────────────
  Total                        $XX.XX
  ```
- Each discount is its own line, labeled with the coupon code + human description.
- **"Frequently bought together" / "Add to your order" strip** below the line items, populated from `GET /api/recommendations?productIds=...` for the current cart, each with an inline "Add" button that updates the cart and breakdown.
- Empty-cart state with a link back to the catalog.

### 8.4 UX rules
- All totals come from the API/engine — the client never recomputes money.
- Optimistic UI is optional; simplest correct approach is: mutate → receive `PricedCart` → re-render.
- Format currency with `Intl.NumberFormat` using `PricedCart.currency`.

### 8.5 Notifications (toasts)
A global, non-blocking notification area confirms cart actions and auto-dismisses.
- Use **shadcn/ui Toast (or Sonner)** mounted once in `layout.tsx` via a `<Toaster />`, anchored bottom-right (top on mobile). Toasts stack and never block interaction with the page.
- **Trigger on the outcome of every cart mutation** (after the API returns the fresh `PricedCart`), so the message reflects what actually happened, not just what was clicked:
  - Add item → success toast: `Added "<Product name>" to your cart` (include quantity if > 1).
  - Increase/decrease quantity → `Updated "<Product name>" (x<qty>)`.
  - Remove item → `Removed "<Product name>" from your cart`, with an optional **Undo** action that re-adds it.
  - Apply coupon (accepted) → success: `Coupon <CODE> applied — you saved $X.XX`.
  - Apply coupon (rejected, from `rejectedCoupons`) → warning/destructive toast with the reason, e.g. `Coupon <CODE> not applied: minimum spend of $50 not met`.
  - Remove coupon → `Coupon <CODE> removed`.
  - Add a recommended item from the PDP/cart strip → same "Added" success toast.
- **Auto-dismiss:** success/info after ~3s, warning/error after ~5s (longer so it can be read). A hover pauses the timer; a manual close (×) is always available.
- **Variants:** success (add/apply), info (quantity/remove-coupon), destructive/warning (rejected coupon, errors). Failed API calls (network/500) also surface a destructive toast: `Something went wrong — please try again`.
- **Accessibility:** the toast region uses an `aria-live="polite"` container so screen readers announce the outcome; error toasts use `aria-live="assertive"`.
- Keep messages short and specific; include the product/coupon name so the user sees exactly what changed. No more than a few visible at once (older ones collapse/expire).

### 8.6 Test hooks (`data-testid`)
So the Playwright suite (§13) has stable selectors, components expose consistent `data-testid` attributes. Suggested set (agents may extend, not rename):
- `product-card`, `product-card-add`, `cart-badge`
- `cart-line-item` (with `data-product-id`), `cart-qty-input`, `cart-qty-increase`, `cart-qty-decrease`, `cart-item-remove`
- `coupon-input`, `coupon-apply`, `coupon-chip` (with `data-code`), `coupon-remove`
- `breakdown-subtotal`, `breakdown-discount` (one per line, with `data-code`), `breakdown-shipping`, `breakdown-tax`, `breakdown-total`
- `recommendation-card` (with `data-product-id`), `recommendation-add`
- `toast` (with `data-variant`) inside the `aria-live` region

---

## 9. Seed Data

`prisma/seed.ts` inserts, on first run:
- ~12–20 sample products across 3–4 categories (e.g., Apparel, Electronics, Home, Accessories) with realistic prices. A few products should have curated `relatedIds` so manual recommendations are demonstrable; the rest rely on category/fallback.
- A representative set of coupons exercising every code path:
  - `SAVE10` — PERCENT, 10%, whole cart, stackable.
  - `TAKE15` — FIXED, $15 off, `minSubtotalCents = 5000`, stackable.
  - `FREESHIP` — FREE_SHIPPING, stackable.
  - `VIP25` — PERCENT, 25%, `stackable: false` (exclusive), `maxDiscountCents = 3000`.
  - `ELECTRO20` — PERCENT, 20%, `targetType: CATEGORY`, `targetValue: "Electronics"`.
- Seed is **idempotent** (upsert by slug/code) so container restarts don't duplicate.

---

## 9b. Test Data Staging Script

Beyond the minimal `prisma/seed.ts` (which guarantees a working baseline), provide a **standalone staging script** that populates a running demo environment with a large, varied, randomized catalog by driving the **admin API** (so it exercises the real endpoints, including image upload). This is the tool used to fill a demo before showing it off.

### 9b.1 Location & invocation
- `scripts/stage-data.ts`, runnable via `npm run stage` (e.g., `tsx scripts/stage-data.ts`).
- Targets a base URL and admin key from flags/env so it works against local or a deployed container:
  ```
  npm run stage -- \
    --base-url http://localhost:3000 \
    --admin-key secret \
    --products 50 \       # how many products to create (alias: -p / --num-products)
    --coupons 15 \        # how many coupons to create  (alias: -c / --num-coupons)
    --input-dir ./staging \
    --seed 1234 \         # optional RNG seed for reproducible runs
    --reset               # optional: clear existing catalog + coupons first
  ```
- **`--products` and `--coupons` are the count controls** — the caller passes exactly how many of each to create. Defaults: `--base-url http://localhost:3000`, `--products 40`, `--coupons 12`, `--input-dir ./staging`. Reads `ADMIN_API_KEY` from env if `--admin-key` omitted. `--products 0` / `--coupons 0` skips that entity entirely.

### 9b.2 Input files (the "possible inputs" pools)
Under `--input-dir` (a sample set ships in `./staging`):
```
staging/
├── product-names.json      # array of candidate product names (or name fragments)
├── descriptions.json       # array of candidate descriptions / sentence fragments
├── categories.json         # array of category names
├── adjectives.json         # optional: for composing names like "Matte Ceramic Mug"
├── coupons.json            # array of coupon TEMPLATES (see 9b.4)
├── price-config.json       # { minCents, maxCents, roundTo: 99, perCategory?: {...} }
└── images/                 # directory of image files (.png/.jpg/.jpeg/.webp/.gif)
```
- Every file is optional; if missing, the script falls back to small built-in defaults so it still runs.
- Files are pools of **possible** values — the script samples from them, it does not use them one-to-one.

### 9b.3 Product generation behavior
For each of `--products` products the script:
1. **Composes a name** by sampling `product-names.json` (optionally prefixing an `adjectives.json` entry), ensuring uniqueness (dedupe / append variant suffix); derives a slug.
2. **Picks a category** at random from `categories.json`.
3. **Picks a description** at random from `descriptions.json` (optionally concatenating 1–2 fragments).
4. **Picks a random price** within `price-config.json` bounds (respecting `perCategory` overrides if present) and applies charm rounding (`roundTo`, e.g. always end in `99`). Money stays in integer cents.
5. **Picks a random image** from `staging/images/` (sampling with or without replacement — configurable; without-replacement until exhausted, then reuse).
6. **Uploads + creates** via `POST /api/products` as `multipart/form-data` with the image file part (per §7.5), OR uploads via `POST /api/uploads` then references the returned `url` — either path is acceptable; default to the standalone upload endpoint for clean separation.
7. Optionally wires **`relatedIds`** after all products exist: for a random subset, attach 2–4 same-category peers so recommendations have curated data to show.

### 9b.4 Coupon generation behavior
- `coupons.json` holds templates; each template may fix some fields and leave others to be randomized, e.g.:
  ```json
  [
    { "type": "PERCENT", "valueRange": [500, 3000], "stackable": true },
    { "type": "FIXED", "valueRange": [500, 2000], "minSubtotalRange": [3000, 8000] },
    { "type": "FREE_SHIPPING" },
    { "type": "PERCENT", "value": 2500, "stackable": false, "maxDiscountCents": 3000 },
    { "type": "PERCENT", "valueRange": [1000, 2000], "targetType": "CATEGORY" }
  ]
  ```
- The script generates unique human-ish codes (e.g. `SAVE10`, `SUMMER20`, `FREESHIP`, random-suffixed to avoid collisions), fills `valueRange`/`minSubtotalRange` by sampling, resolves `targetType: CATEGORY` by picking a real category that exists in the catalog, and creates each via `POST /api/coupons` (or the bulk endpoint).
- Guarantees at least one of each interesting case (a stackable percent, a min-spend fixed, a free-shipping, an exclusive/non-stackable, and a category-targeted) so the demo always shows the full pricing engine.

### 9b.5 Behavior & ergonomics
- **Idempotency / cleanliness:** `--reset` clears the existing catalog and coupons before staging by calling `DELETE /api/products?all=true` and `DELETE /api/coupons?all=true` (§7.1/§7.2), then creates fresh data. Without `--reset` the script appends.
- **Reproducibility:** `--seed` seeds the RNG so a run can be reproduced exactly.
- **Resilience:** validate inputs up front; on a failed API call, log the offending item and continue (don't abort the whole run), then print a summary (`created: N products, M coupons; skipped: X`).
- **Dry run:** `--dry-run` prints what would be created without calling the API.
- Uses only the public admin API + `fetch` — no direct DB access — so it works against any running instance, local or containerized.

### 9b.6 Tests
- Unit-test the pure helpers (name composer, price picker with charm rounding, template resolver) with a fixed seed for deterministic output.
- A smoke test that runs `--dry-run` against sample inputs and asserts the generated payloads are schema-valid.

---

## 10. Docker (single container)

- Use Next.js `output: 'standalone'` for a small runtime image.
- Multi-stage Dockerfile: deps → build (runs `prisma generate`) → runner.
- On container start: run `prisma migrate deploy` (or `prisma db push`) then `prisma db seed`, then start the server. SQLite file at `/data/app.db`.
- Mount `/data` as a volume so the DB persists across restarts (or accept ephemeral for a pure demo).

**`.env.example`**
```
DATABASE_URL="file:/data/app.db"
ADMIN_API_KEY="change-me"
STORE_CURRENCY="USD"
TAX_RATE_BPS="800"
SHIPPING_FLAT_CENTS="599"
FREE_SHIPPING_THRESHOLD_CENTS="5000"
UPLOAD_DIR="/data/uploads"
MAX_UPLOAD_BYTES="5242880"
```

> Uploaded product images live in `UPLOAD_DIR` under the same `/data` volume, so a single `-v cartdata:/data` mount persists both the database and images.

**Dockerfile (sketch)**
```dockerfile
# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---- run ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
VOLUME /data
EXPOSE 3000
# entrypoint runs migrate + seed then starts server
CMD ["sh", "-c", "npx prisma db push && npx prisma db seed && node server.js"]
```

Run:
```
docker build -t demo-cart .
docker run -p 3000:3000 -e ADMIN_API_KEY=secret -v cartdata:/data demo-cart
```

---

## 11. Acceptance Criteria

1. `docker run` produces a working app at `localhost:3000` with seeded products and coupons — no external services.
2. User can browse, add/update/remove cart items; the breakdown updates on every change.
3. Applying `SAVE10`, `FREESHIP`, and a category coupon simultaneously produces a correct, itemized breakdown; removing any coupon updates totals.
4. An exclusive coupon (`VIP25`) correctly refuses to stack and rejects other coupons with a visible reason.
5. `POST /api/products/bulk` and `POST /api/coupons/bulk` create many records in one call, guarded by `x-admin-key`, with all-or-nothing validation.
6. `GET /api/cart` totals exactly match what the pricing engine unit tests assert; the client never computes money.
7. Pricing engine unit tests (§5.5) all pass.
8. The product detail page shows a non-empty "You might also like" row (honoring `relatedIds`, then category, then fallback), and the cart shows recommendations excluding items already in the cart. Recommendation unit tests (§5b.3) all pass.
9. `POST /api/products` with a `multipart/form-data` body including an `image` file creates the product, persists the file under `/data/uploads`, sets `imageUrl` to the served path, and the image renders on the catalog and product page after a container restart (persistence). Invalid type → 415, oversized → 413.
10. `npm run stage` against a running instance creates exactly `--products` products and `--coupons` coupons (randomized names, categories, descriptions, charm-rounded prices, images from `staging/images/`, coupons covering every pricing-engine case). `--reset` first clears the catalog and coupons via the bulk DELETE endpoints, then re-stages. A `--seed` value reproduces an identical run; `--dry-run` produces schema-valid payloads without writing.
11. Every cart action surfaces an auto-dismissing toast reflecting the actual outcome: adding/removing/updating items, and applying/removing coupons. An **accepted coupon** shows a success toast with the amount saved; a **rejected coupon** shows a warning toast with the reason from `rejectedCoupons`. Toasts auto-dismiss (~3s success / ~5s warning), pause on hover, and can be closed manually.
12. The **Playwright acceptance suite (§13) passes** headless via `npm run test:e2e`, covering catalog, add/update/remove, breakdown correctness, accepted/rejected/exclusive coupons, recommendations, toasts, and the admin API including image upload.

---

## 12. Work Breakdown (suggested agent split)

- **Agent A — Foundation:** Next.js + TS + Tailwind + shadcn scaffold, Prisma schema, `money.ts`, config, seed script, Dockerfile.
- **Agent B — Pricing engine + recommendations:** `engine.ts`, `rules.ts`, `types.ts`, `recommend.ts`, full Vitest suites. Both pure, no I/O. (Can start in parallel against the contracts in §5.1 and §5b.2.)
- **Agent C — API layer + staging script:** all `/api/*` routes, image upload/serving (§7.5), Zod validation, cart cookie/persistence, wires engine into cart endpoints, and the `scripts/stage-data.ts` staging tool with sample `staging/` inputs (§9b).
- **Agent D — UI:** catalog, product detail, and cart screens consuming the API, toasts (§8.5), and `data-testid` hooks (§8.6).
- **Agent E — Acceptance tests:** Playwright config, fixtures, and the `e2e/` suite (§13). Depends on the UI test hooks and API being in place; can scaffold against the contracts early.

Shared contract that must not drift: the **types in §5.1** and the **API shapes in §7**. Agents should treat these as the interface boundary.

---

## 13. Acceptance Tests (Playwright)

In addition to the Vitest unit tests (pricing engine §5.5, recommendations §5b.3, staging helpers §9b.6), the app ships **end-to-end acceptance tests in Playwright** that drive a real browser against a running instance and verify the user-facing flows and the admin API.

### 13.1 Setup & running
- `@playwright/test` with `playwright.config.ts`. Tests live in `e2e/`.
- The config uses a **`webServer`** block to build and start the app (against a throwaway SQLite DB and a temp `UPLOAD_DIR`) before the suite, and tears it down after — so `npm run test:e2e` is one command with no manual server juggling. `ADMIN_API_KEY` is set to a known test value for the run.
- **Deterministic fixtures:** seed a known catalog/coupon set before tests (call the admin API in a `globalSetup`, or run the staging script with a fixed `--seed`) so assertions on names, prices, and discounts are stable. Prefer the API for setup speed; reserve the browser for the behavior under test.
- Run headless in CI across at least Chromium (Firefox/WebKit optional). Capture trace/screenshot/video on failure. Each spec is isolated (fresh cart cookie / `context`).
- To keep selectors robust, UI components expose stable **`data-testid`** hooks (see §8.6) — Playwright targets those and `aria-live` roles rather than brittle CSS/text.

### 13.2 Required scenarios (map 1:1 to acceptance criteria §11)
- **Catalog & navigation:** catalog renders seeded products with prices and images; clicking a card opens the product detail page.
- **Add to cart:** add an item → cart badge increments, item appears in cart, and a **success toast** shows `Added "<name>"` and auto-dismisses (assert it appears then disappears).
- **Quantity & remove:** increase/decrease quantity updates the line and breakdown; remove empties the line; toasts fire for each; the **Undo** on remove restores the item.
- **Price breakdown correctness:** for a known cart, assert the on-screen subtotal, each discount line, shipping, tax, and total match the values the engine unit tests assert (single source of truth — the E2E test reads the rendered breakdown, not its own math).
- **Coupons — accepted:** apply `SAVE10`/`FREESHIP` → discount lines appear, total drops correctly, and a **success toast** shows the amount saved; removing a coupon reverts totals and toasts.
- **Coupons — rejected:** apply a coupon that fails eligibility (e.g. min-spend not met) → it is **not** applied, appears under the rejected reason, and a **warning toast** shows the reason.
- **Coupons — exclusive/stacking:** apply an exclusive coupon (`VIP25`) alongside others → only it applies, others are rejected with a visible reason (validates §5.4 through the UI).
- **Recommendations:** product page shows a non-empty "You might also like" row honoring `relatedIds`/category; adding a recommendation adds it to the cart (with toast). Cart recommendations exclude items already in the cart.
- **Admin API:** `POST /api/products` (JSON and **multipart with an image upload**) and the bulk endpoints — assert 201/created counts, that admin key is enforced (401 without it), that an uploaded image is served back and renders on the catalog, and validation errors return 400/409/413/415 as specified.
- **Persistence smoke (optional):** an uploaded image and created product survive a server restart (only if the webServer setup supports restart within the suite).

### 13.3 Conventions
- Assert on **user-visible outcomes** (rendered text, toast presence/absence, badge counts), not internal state.
- For auto-dismissing toasts, assert both that the toast becomes visible and that it disappears within the expected window; never rely on fixed `sleep`s — use Playwright's auto-waiting and `toBeVisible`/`toHaveCount(0)`.
- Keep money assertions on formatted strings derived from the API response where possible, to avoid duplicating pricing logic in tests.