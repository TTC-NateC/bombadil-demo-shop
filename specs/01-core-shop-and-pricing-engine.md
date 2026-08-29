# Slice 1 — Core Shop & Pricing Engine

**Version:** 2.0
**Status:** Ready to hand to build agents
**Depends on:** nothing — this is the foundation slice
**Ships on its own:** yes. A browsable catalog, a working cart, coupons, and a fully itemized price breakdown, in a single container.

> This slice is the point of the project. Slices 2 and 3 are additive and neither is required for a demo.

---

## 1. Goals & Non-Goals

### Goals
- Browse a catalog of products.
- Add/remove/update quantities in a cart.
- Apply and remove coupons.
- Show a clear, itemized price breakdown (subtotal, per-discount lines, shipping, tax, total).
- Provide a **robust, flexible, well-tested pricing engine** that is the single source of truth for all totals.
- Deploy as a **single Docker container**, no external services required.

### Non-Goals
- No real payment processing (no Stripe/PayPal).
- No full checkout / order-placement flow. (The cart is the terminal screen.)
- No user accounts / authentication for shoppers (cart is per-browser).
- No inventory management, shipping carrier integration, or fulfillment.
- No admin write API — see slice 2. This slice is read-only over seeded data.
- No recommendations, no toasts — see slice 3.

---

## 2. Tech Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | Single app serves UI + API routes. `cookies()` and route `params` are **async** — see §7.5. |
| Language | **TypeScript** (strict) | Shared types across UI, API, and engine. |
| Styling | **Tailwind CSS + shadcn/ui** | Fast, consistent, agent-friendly components. |
| Data | **SQLite + Prisma** | File-based DB inside the container. No external service. |
| Cart storage | **`cartId` cookie** (httpOnly, unsigned — see §7.5) | Cart rows persisted in SQLite, keyed by cartId. |
| Money | **Integer minor units (cents)** everywhere | Never use floats for money. Format only at the view layer. |
| Testing | **Vitest** unit tests (engine) **and Playwright** acceptance tests (both required) | Pure logic covered by unit tests; end-to-end flows covered by Playwright (§12). |
| Container | **Single Docker image**, Next.js standalone output on `node:20-slim` | SQLite file and uploads live on the `/data` volume. |

> **Rule for all agents:** money is stored and computed as **integer cents**. Currency formatting happens only when rendering. This avoids floating-point drift in discounts and tax.

---

## 3. Repository Layout (this slice)

```
/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                # baseline seed (products + coupons)
├── e2e/
│   ├── catalog.spec.ts
│   ├── cart.spec.ts
│   └── coupons.spec.ts
├── playwright.config.ts
├── docker/
│   └── entrypoint.sh          # §10
├── src/
│   ├── app/
│   │   ├── page.tsx           # catalog (product grid)
│   │   ├── product/[slug]/page.tsx
│   │   ├── cart/page.tsx      # cart + coupon + breakdown
│   │   ├── layout.tsx
│   │   └── api/
│   │       ├── products/route.ts            # GET list
│   │       ├── products/[slug]/route.ts     # GET one
│   │       ├── cart/route.ts                # GET current cart (priced)
│   │       ├── cart/items/route.ts          # POST add, PATCH qty, DELETE remove
│   │       └── cart/coupons/route.ts        # POST apply, DELETE remove
│   ├── lib/
│   │   ├── pricing/
│   │   │   ├── engine.ts       # pure pricing engine (no I/O)
│   │   │   ├── allocate.ts     # largest-remainder penny allocation
│   │   │   ├── config.ts       # store config from env
│   │   │   ├── types.ts        # PricedCart, DiscountLine, etc.
│   │   │   ├── engine.test.ts  # Vitest unit tests
│   │   │   └── allocate.test.ts
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

The **full** schema is defined here, including fields that stay inert until later slices (`relatedIds` — slice 3; `imageUrl` writes — slice 2). Later slices add no migrations.

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x"]
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Product {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  description String?
  priceCents  Int                       // current unit price in cents
  currency    String   @default("USD")
  category    String?
  imageUrl    String?
  active      Boolean  @default(true)
  relatedIds  String   @default("[]")   // JSON array of productIds — inert until slice 3
  createdAt   DateTime @default(now())
  cartItems   CartItem[]
}

model Coupon {
  id            String   @id @default(cuid())
  code          String   @unique          // stored uppercase; input uppercased at apply time
  description   String?
  type          String                     // CouponType — see §4.3
  // value semantics depend on type:
  //  PERCENT      -> value = basis points off (e.g. 1000 = 10%)
  //  FIXED        -> value = cents off
  //  FREE_SHIPPING-> value ignored
  value         Int      @default(0)
  targetType    String   @default("CART")  // TargetType — see §4.3
  targetValue   String?                    // category name or productId
  minSubtotalCents Int?
  maxDiscountCents Int?
  stackable     Boolean  @default(true)
  priority      Int      @default(100)     // lower applies first
  startsAt      DateTime?
  endsAt        DateTime?
  usageLimit    Int?                       // informational only in this demo
  active        Boolean  @default(true)
  createdAt     DateTime @default(now())
}

model Cart {
  id        String     @id @default(cuid())
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  items     CartItem[]
  coupons   String     @default("[]")   // JSON array of applied coupon codes — see §5.6
}

model CartItem {
  id                     String  @id @default(cuid())
  cartId                 String
  productId              String
  quantity               Int     @default(1)
  unitPriceCentsSnapshot Int                          // captured when the item is first added
  cart      Cart    @relation(fields: [cartId],    references: [id], onDelete: Cascade)
  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  @@unique([cartId, productId])
}
```

### 4.1 Why `unitPriceCentsSnapshot`
The pricing engine reads the snapshot, **never** `Product.priceCents`. Two consequences, both deliberate:
- An admin price change (slice 2) does not silently reprice carts that already exist.
- Playwright fixtures are stable: a cart's arithmetic cannot move underneath a running test.

The snapshot is captured on `POST /api/cart/items` when the row is created. Quantity changes do **not** refresh it.

### 4.2 Why `onDelete: Cascade` on `CartItem.product`
Prisma's default for a required relation is `Restrict`. Without the explicit cascade, deleting a product that sits in any cart raises `P2003`, which would break slice 2's `DELETE /api/products/[id]` and the staging script's `--reset` precisely when someone wants to reset — right after a demo. A deleted product silently disappears from live carts; acceptable for a demo.

### 4.3 Why `String` instead of `enum`
**Prisma's SQLite connector does not support `enum`.** Declaring one fails schema validation, so `prisma generate` never runs and nothing downstream of it builds. `type` and `targetType` are therefore `String` columns, constrained in TypeScript and at the API boundary instead:

```ts
// src/lib/pricing/types.ts
export const COUPON_TYPES = ['PERCENT', 'FIXED', 'FREE_SHIPPING'] as const;
export const TARGET_TYPES = ['CART', 'CATEGORY', 'PRODUCT'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];
export type TargetType = (typeof TARGET_TYPES)[number];

// Zod schemas derive from the same constants — one source of truth:
export const couponTypeSchema = z.enum(COUPON_TYPES);
export const targetTypeSchema = z.enum(TARGET_TYPES);
```

Every write path (the seed, and slice 2's admin endpoints) validates through these schemas; every read path narrows through them before the value reaches the engine. The engine's signatures use the TS union types, so an invalid string cannot reach `priceWithCouponSet` without failing validation first.

Run `npx prisma validate` as the first check of Phase 1 — it catches this class of problem in seconds.

---

## 5. The Pricing Engine (centerpiece)

The engine is a **pure function**: given a cart snapshot + candidate coupons + store config, it returns a fully itemized `PricedCart`. It performs **no I/O** — the API layer loads data and passes it in.

### 5.1 Types

```ts
// src/lib/pricing/types.ts
export interface PricingLineItem {
  productId: string;
  name: string;
  category?: string;
  unitPriceCents: number;         // from CartItem.unitPriceCentsSnapshot
  quantity: number;
  lineSubtotalCents: number;      // unitPriceCents * quantity, pre-discount
  lineDiscountCents: number;      // this line's allocated share of all item discounts
  lineTotalCents: number;         // lineSubtotalCents - lineDiscountCents, never < 0
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
  reason: string;                 // human-readable, shown to the shopper verbatim
}

export interface PricedCart {
  items: PricingLineItem[];
  subtotalCents: number;          // sum of line subtotals
  discountLines: DiscountLine[];  // one per applied coupon, item and shipping alike
  discountTotalCents: number;     // ITEM discounts only — excludes appliedTo: 'SHIPPING'
  shippingDiscountCents: number;  // shipping discounts only
  shippingCents: number;          // shippingBase - shippingDiscountCents, never < 0
  taxCents: number;
  totalCents: number;             // final amount, never below 0
  rejectedCoupons: RejectedCoupon[];
  currency: string;
}

export function priceCart(input: {
  items: PricingLineItem[];       // lineDiscountCents/lineTotalCents ignored on input
  coupons: Coupon[];              // candidate coupons (already looked up by code)
  config: StoreConfig;
}): PricedCart;
```

### 5.2 Invariants (assert these in tests)

```
discountTotalCents    === Σ discountLines where appliedTo !== 'SHIPPING'
discountTotalCents    === Σ items[].lineDiscountCents          // exact, no drift
shippingDiscountCents === Σ discountLines where appliedTo === 'SHIPPING'
shippingCents         === max(0, shippingBaseCents - shippingDiscountCents)
items[i].lineTotalCents === lineSubtotalCents - lineDiscountCents,  and >= 0
totalCents            === max(0, subtotal - discountTotal + shipping + tax)
```

**`discountTotalCents` never includes shipping.** Shipping is discounted by zeroing `shippingCents`; counting it in `discountTotalCents` as well would subtract it twice from the total *and* shrink the tax base, which §5.5 says is pre-shipping by default.

### 5.3 Top-level algorithm — best outcome wins

```
priceCart(items, candidateCoupons, config):
  1. lineSubtotalCents[i] = unitPriceCents * quantity;  subtotalCents = Σ
     shippingBaseCents = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS
                           ? 0
                           : SHIPPING_FLAT_CENTS
     (the free-shipping threshold tests the PRE-discount subtotal)

  2. Eligibility filter over candidateCoupons → eligible[], rejected[]:
       - active === true                     → "Coupon <C> is not active"
       - now within startsAt/endsAt if set    → "Coupon <C> has expired" /
                                                "Coupon <C> is not yet available"
       - subtotalCents >= minSubtotalCents    → "Minimum spend of $X not met"
       - target matches >= 1 line in the cart → "Coupon <C> doesn't apply to anything in your cart"
       - FREE_SHIPPING and shippingBaseCents > 0
                                              → "Shipping is already free on this order"

  3. Build candidate coupon sets:
       S0 = every eligible STACKABLE coupon, together
       Si = [each eligible NON-STACKABLE coupon, alone]   for i = 1..n
       If both are empty, the single candidate set is [].

  4. For each candidate set: priceWithCouponSet(items, set, config) → PricedCart

  5. Winner = the result with the LOWEST totalCents.
     Tie-break: fewest coupons, then the lexicographically smallest sorted code list.

  6. Every eligible coupon not in the winning set is added to rejectedCoupons:
       - if the winner is a non-stackable set {X}:
           "Coupon X can't be combined with other coupons"
       - if the winner is S0 and the loser C is non-stackable:
           "Coupon C can't be combined with your other coupons, which give a better price"

  7. Return the winning PricedCart with rejectedCoupons = step-2 + step-6 rejections.
```

**Why N+1 passes.** The original rule ("any exclusive coupon wins unconditionally") could charge the shopper *more* for entering a valid code — see the worked example in §5.7. Evaluating each candidate set and taking the lowest total means the shopper is never penalised, and it makes "best value" well-defined once shipping and tax are in play, which raw `discountTotalCents` is not. Carts are small and the engine is pure, so the extra passes are free. Document this behaviour in the README as a deliberate decision.

### 5.4 `priceWithCouponSet` — deterministic inner pass

```
priceWithCouponSet(items, coupons, config):
  1. lineDiscount[i] = 0 for all lines
  2. sort coupons by (priority ASC, code ASC)      // code breaks priority ties — required
  3. for each coupon in order:

     PERCENT | FIXED:
       matched = lines matching the target
                   CART     -> every line
                   CATEGORY -> lines whose category === targetValue
                   PRODUCT  -> lines whose productId === targetValue
       base    = Σ over matched of (lineSubtotal - lineDiscount)   // the RUNNING base
       raw     = PERCENT ? roundHalfUp(base * value / 10000)
                         : min(value, base)
       amount  = maxDiscountCents ? min(raw, maxDiscountCents) : raw
       amount  = min(amount, base)                                 // never exceed the base
       allocate `amount` across `matched` proportional to each line's
         (lineSubtotal - lineDiscount), using largest-remainder (§5.5)
       lineDiscount[i] += allocation[i]
       if amount > 0 -> push DiscountLine{ appliedTo: targetType }
       if amount === 0 -> reject: "No discountable amount remaining for coupon <C>"

     FREE_SHIPPING:
       shippingDiscountCents = shippingBaseCents
       push DiscountLine{ appliedTo: 'SHIPPING', amountCents: shippingBaseCents }
       a second FREE_SHIPPING coupon in the same set is rejected:
         "Shipping is already free on this order"

  4. discountTotalCents    = Σ lineDiscount
  5. shippingCents         = shippingBaseCents - shippingDiscountCents
  6. taxableBase = subtotalCents - discountTotalCents
                   + (TAX_ON_SHIPPING ? shippingCents : 0)
     taxCents    = roundHalfUp(taxableBase * TAX_RATE_BPS / 10000)
  7. totalCents  = max(0, subtotalCents - discountTotalCents + shippingCents + taxCents)
```

Every coupon — `CART`, `CATEGORY`, and `PRODUCT` alike — reduces **specific lines**. There is no unallocated cart-level discount, so "the current running discountable base" always has exactly one meaning, and the per-line zero floor is enforceable.

### 5.5 Rounding and allocation
- All rounding is **half-up** on the final cents of each computed discount/tax line.
- Percentages use **basis points** (integer) — `1000 = 10%`.
- Allocation uses **largest remainder**, so the parts sum to the whole exactly:

```
allocate(amount, weights[]):
  total = Σ weights
  if total === 0 -> return zeros
  exact[i]  = amount * weights[i] / total
  floor[i]  = Math.floor(exact[i])
  remainder = amount - Σ floor
  give 1 extra cent to the `remainder` lines with the largest fractional part,
    breaking ties by lower index (deterministic)
```

Naive per-line half-up rounding drifts by a cent or two and breaks the
`discountTotalCents === Σ lineDiscountCents` invariant. Use largest remainder.

- No line and no total may go negative.

### 5.6 Applied-coupon lifecycle
`Cart.coupons` holds **exactly the codes that applied on the last pricing pass** — nothing else.

- On every pricing pass, any held code that is not in the winning set is **pruned** from `Cart.coupons`. This covers all four cases uniformly: it stopped qualifying, it was superseded by a better exclusive coupon, the underlying coupon was deleted, or it was deactivated.
- `rejectedCoupons` therefore means exactly one thing: **this apply attempt failed and was not persisted.** It is transient, per-response, and safe to surface as a one-shot message.
- Consequence: removing an exclusive coupon does not restore previously superseded codes — the shopper re-enters them. Because §5.3 only ever supersedes when the exclusive produces a *lower total*, nothing of value was lost at eviction time.
- Consequence: the UI can render applied-coupon chips directly from `discountLines` (`couponCode` + `description`). `PricedCart` needs no separate applied-coupons field.

### 5.7 Worked examples (encode these as tests verbatim)

**A — free shipping is subtracted once, and doesn't shrink the tax base**
```
subtotal 4000, FREESHIP applied, SHIPPING_FLAT 599, TAX 800bps, threshold 5000
shippingBase = 599 (4000 < 5000)
discountTotalCents    = 0
shippingDiscountCents = 599
shippingCents         = 0
taxCents              = roundHalfUp(4000 * 0.08) = 320
totalCents            = 4000 - 0 + 0 + 320 = 4320
```

**B — stacked coupons have exactly one defensible base**
```
Laptop 100000 (Electronics), T-shirt 2000 (Apparel).  subtotal 102000
SAVE10 (CART, 1000bps, priority 100), ELECTRO20 (CATEGORY Electronics, 2000bps, priority 100)
priority tie -> code ASC -> ELECTRO20 first
  ELECTRO20: base 100000            -> 20000   lineDiscount [20000, 0]
  SAVE10   : base 80000 + 2000 = 82000 -> 8200 allocated [8000, 200]
  lineDiscount [28000, 200];  discountTotalCents 28200
```

**C — the exclusive coupon loses when it's worse**
```
subtotal 5000. SAVE10, TAKE15 (min 5000), FREESHIP, VIP25 (non-stackable, 2500bps, cap 3000)
shippingBase = 0 (5000 >= 5000) -> FREESHIP rejected: "Shipping is already free on this order"
S0 {SAVE10, TAKE15} : 500 + min(1500, 4500) = 2000; tax 240; TOTAL 3240
S1 {VIP25}          : 1250 (cap not binding);        tax 300; TOTAL 4050
Winner = S0. VIP25 -> "Coupon VIP25 can't be combined with your other coupons,
                       which give a better price"
```

### 5.8 Required unit tests (Vitest)
- Empty cart → zeros.
- Single item, no coupon.
- PERCENT on whole cart; verify basis-point rounding.
- FIXED larger than subtotal → clamps, total not negative.
- Two stackable coupons → **worked example B**, asserted on exact `lineDiscountCents`.
- Priority tie → `code ASC` ordering is deterministic across 100 shuffled inputs.
- Non-stackable that wins (beats the stackable set) → applies alone, others rejected with reasons.
- Non-stackable that **loses** → **worked example C**, stackable set wins.
- CATEGORY/PRODUCT-targeted coupon with and without matching items.
- `minSubtotalCents` gating (met vs not met).
- `maxDiscountCents` cap.
- FREE_SHIPPING → **worked example A**; and FREE_SHIPPING when shipping is already free → rejected.
- Tax computed on discounted subtotal; `TAX_ON_SHIPPING=true` variant.
- **Invariants (§5.2) asserted on every one of the above**, ideally via a shared helper.
- `allocate()`: parts always sum to the whole, across randomised weights (property test).

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

All endpoints return JSON. Money fields are integer cents. **No endpoint in this slice requires authentication** — the catalog is read-only and the cart is per-browser. Admin auth arrives in slice 2.

### 7.1 Products (read-only)
**`GET /api/products`** → `{ products: Product[] }` (active only, `?all=true` to include inactive).
**`GET /api/products/[slug]`** → `{ product }`, `404` if unknown or inactive.

### 7.2 Cart
Cart is resolved from the `cartId` cookie; if none, one is created and the cookie set.

**`GET /api/cart`** → `PricedCart`.
**`POST /api/cart/items`** — add. Body `{ productId, quantity=1 }`. Upserts quantity; on **create** captures `unitPriceCentsSnapshot` from the product's current price. → `PricedCart`.
**`PATCH /api/cart/items`** — set quantity. Body `{ productId, quantity }`. `quantity=0` removes. Does **not** refresh the price snapshot. → `PricedCart`.
**`DELETE /api/cart/items?productId=...`** — remove. → `PricedCart`.
**`POST /api/cart/coupons`** — apply. Body `{ code }` (uppercased before lookup). Runs the engine with the code added to the candidate set. If it lands in the winning set, persist it; otherwise it appears in `rejectedCoupons` and is **not** persisted. → `PricedCart`.
**`DELETE /api/cart/coupons?code=...`** — remove an applied coupon. → `PricedCart`.

> **Every cart-mutating endpoint returns the freshly-priced cart** so the client never computes totals itself. Every pass prunes `Cart.coupons` per §5.6.

### 7.3 Validation & errors
- Use **Zod** on all request bodies and query params.
- Standard error shape: `{ error: { message, code, details? } }`.
- HTTP codes in this slice: `200` ok, `400` validation, `404` unknown product/coupon.

### 7.4 Cart cookie

| Attribute | Value |
|---|---|
| name | `cartId` |
| `httpOnly` | `true` |
| `sameSite` | `lax` |
| `path` | `/` |
| `maxAge` | 30 days |
| `secure` | `true` when `NODE_ENV === 'production'` |

**The cookie is deliberately unsigned.** Next.js App Router's `cookies()` provides no signing primitive, so signing would mean a new dependency and a new secret to configure. The `cartId` is an unguessable cuid, and §1's non-goals rule out accounts, PII, and payments — so signing defends nothing here. **State this in the README, alongside the note that a real store handling money would need it.** Do not describe the cookie as "signed" anywhere.

Abandoned `Cart` rows are never reaped; they are cheap and a demo database is disposable.

### 7.5 Next.js 15 async APIs

Pin **Next.js 15**. Three of its changes touch code in this slice directly, and all three are silent type errors rather than runtime surprises — so get them right the first time rather than discovering them across every route:

```ts
// cookies() returns a Promise — every cart helper is async
const jar      = await cookies();
const cartId   = jar.get('cartId')?.value;

// Route handler params is a Promise
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
}

// Page/layout params and searchParams are Promises too
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
}
```

Also: **`fetch` and route-handler `GET` are no longer cached by default** in 15. That is the behaviour this app wants everywhere — cart and catalog reads must never serve stale data — so it needs no opt-out. Do not add caching back without a reason.

Next 15 brings **React 19**. `shadcn/ui` supports it, but the initializer may raise peer-dependency prompts; take the documented resolution rather than hand-editing `package.json`.

---

## 8. UI Specification

Three screens, shadcn/ui + Tailwind.

### 8.1 Catalog (`/`)
- Responsive product grid (card: image, name, price, category badge, "Add to cart").
- Products with no `imageUrl` render a placeholder.
- Optional category filter chips.
- Cart badge in the header showing item count **and the running item subtotal**;
  links to `/cart`. It lives in the root layout, so it renders on every page.
  The subtotal is `PricedCart.subtotalCents` rendered verbatim — the same figure
  as the cart's `breakdown-subtotal` row, so the header and the breakdown can
  never disagree. It is pre-discount and pre-tax by design: the header does not
  restate `totalCents`, because deriving an items-after-discount figure would
  mean computing money on the client (§8.4). The subtotal is omitted until the
  first `/api/cart` read resolves, so no placeholder amount is ever shown.

### 8.2 Product detail (`/product/[slug]`)
- Larger image, description, price, quantity selector, "Add to cart".

### 8.3 Cart (`/cart`) — the important screen
- Line items: image, name, unit price, quantity stepper (updates via API), remove button.
- **Coupon box:** text input + "Apply". Applied coupons render as removable chips, sourced from `PricedCart.discountLines` (§5.6). If a code is rejected, show an inline message with the reason from `rejectedCoupons` verbatim.
- **Price breakdown panel**, rendered directly from `PricedCart`:
  ```
  Subtotal                     $XX.XX
  ─ Coupon SAVE10 (10% off)   -$X.XX
  Shipping                      $X.XX   (or "FREE")
  Tax (8%)                      $X.XX
  ─────────────────────────────────────
  Total                        $XX.XX
  ```
- Item discount lines render above Shipping. A `FREE_SHIPPING` discount line is **not** rendered as a negative row — render `Shipping: FREE`, attributing the coupon code beside it. This keeps the display consistent with the threshold-driven free-shipping case, which produces no discount line at all.
- Empty-cart state with a link back to the catalog.

### 8.4 UX rules
- All totals come from the API/engine — the client never recomputes money.
- Simplest correct approach: mutate → receive `PricedCart` → re-render.
- Format currency with `Intl.NumberFormat` using `PricedCart.currency`.

### 8.5 Test hooks (`data-testid`)
Stable selectors for §12. Agents may extend, not rename.
- `product-card`, `product-card-add`, `cart-badge` (count only), `cart-badge-subtotal`
- `cart-line-item` (with `data-product-id`), `cart-qty-input`, `cart-qty-increase`, `cart-qty-decrease`, `cart-item-remove`
- `coupon-input`, `coupon-apply`, `coupon-chip` (with `data-code`), `coupon-remove`, `coupon-error`
- `breakdown-subtotal`, `breakdown-discount` (one per line, with `data-code`), `breakdown-shipping`, `breakdown-tax`, `breakdown-total`

---

## 9. Seed Data

`prisma/seed.ts`, idempotent (upsert by slug/code) so restarts don't duplicate:
- ~12–20 products across 3–4 categories (Apparel, Electronics, Home, Accessories) with realistic prices. `imageUrl` may reference external URLs or be null in this slice.
- **At least 3 products carry curated `relatedIds`** (2–4 peers each), so slice 3's manual-override layer — the first and highest-priority rule in its §2.1, and the only one that shows curation rather than a heuristic — is demonstrable without slice 2. The rest rely on category and fallback. This is also the only thing in slice 1 that exercises the JSON-array column.
- Coupons exercising every code path:
  - `SAVE10` — PERCENT, 10%, whole cart, stackable.
  - `TAKE15` — FIXED, $15 off, `minSubtotalCents = 5000`, stackable.
  - `FREESHIP` — FREE_SHIPPING, stackable.
  - `VIP25` — PERCENT, 25%, `stackable: false`, `maxDiscountCents = 3000`.
  - `ELECTRO20` — PERCENT, 20%, `targetType: CATEGORY`, `targetValue: "Electronics"`.

---

## 10. Docker (single container)

- Next.js `output: 'standalone'`.
- Multi-stage: deps → build (`prisma generate` + `next build`) → runner on **`node:20-slim`**.
- **`node:20-slim`, not alpine.** Prisma's musl query-engine binary is the single most common Next+Prisma container failure, and it surfaces as a confusing runtime error on someone else's laptop. Debian's glibc/openssl3 removes that class of bug for roughly 40 MB — the wrong thing to economise on in an artefact whose entire purpose is being demoed elsewhere.
- The runner needs artefacts standalone tracing does **not** include. Copy them explicitly:
  - `node_modules/.prisma` and `node_modules/@prisma` (the query engine)
  - `prisma/` (schema + seed)
  - install `prisma` and `tsx` as genuine runtime dependencies — **never** rely on `npx` fetching them at container start, which would make booting require network access and pull an unpinned version.
- `mkdir -p public` in the build stage, or drop the `COPY public` line — Docker `COPY` fails outright on a missing source.
- `docker/entrypoint.sh` runs on start:
  ```sh
  #!/bin/sh
  set -e
  mkdir -p /data                     # /data/uploads is added in slice 2
  npx prisma migrate deploy
  npx prisma db seed                 # idempotent upserts (§9)
  exec node server.js
  ```
- Mount `/data` as a volume so the DB persists across restarts.

**`.env.example`**
```
DATABASE_URL="file:/data/app.db"
STORE_CURRENCY="USD"
TAX_RATE_BPS="800"
TAX_ON_SHIPPING="false"
SHIPPING_FLAT_CENTS="599"
FREE_SHIPPING_THRESHOLD_CENTS="5000"
```

Run:
```
docker build -t demo-cart .
docker run -p 3000:3000 -v cartdata:/data demo-cart
```

---

## 11. Acceptance Criteria

1. `docker run` produces a working app at `localhost:3000` with seeded products and coupons — no external services, **no network access required at container start**.
2. User can browse, add/update/remove cart items; the breakdown updates on every change.
3. Applying `SAVE10` and `ELECTRO20` together produces a correct, itemized breakdown matching **worked example B**; removing either updates totals.
4. `FREESHIP` on a sub-threshold cart matches **worked example A** — shipping shown FREE, total reduced by the shipping amount exactly once, tax unchanged.
5. `VIP25` alongside `SAVE10` + `TAKE15` on a `5000` cart matches **worked example C** — the stackable pair wins, `VIP25` is rejected with a visible reason.
6. An exclusive coupon that *does* beat the stackable set applies alone and rejects the others with a visible reason.
7. Every §5.2 invariant holds on every `GET /api/cart` response; the client never computes money.
8. Pricing engine unit tests (§5.8) all pass.
9. Reducing a cart below a coupon's `minSubtotalCents` prunes that coupon from `Cart.coupons` (§5.6); the chip disappears and the total reflects it.
10. The Playwright suite (§12) passes headless via `npm run test:e2e`.

---

## 12. Acceptance Tests (Playwright)

### 12.1 Setup
- `@playwright/test`, specs in `e2e/`, config with a **`webServer`** block that builds and starts the app against a throwaway SQLite DB, then tears it down — `npm run test:e2e` is one command.
- Seed a known catalog/coupon set before the run (`globalSetup`) so assertions on names, prices and discounts are stable. The price snapshot (§4.1) guarantees a cart's arithmetic cannot move mid-test.
- Headless Chromium minimum. Trace/screenshot/video on failure. Each spec isolated with a fresh `context` (fresh cart cookie).
- **Run `workers: 1`.** SQLite is single-writer: parallel Playwright workers hitting one database file produce `SQLITE_BUSY` errors that surface as intermittent, plausible-looking pricing and cart bugs. If the suite later becomes slow enough to matter, the fix is WAL mode plus a busy timeout — **not** raising the worker count.
- Target `data-testid` (§8.5), not CSS or text.

### 12.2 Required scenarios
- **Catalog & navigation:** catalog renders seeded products with prices; clicking a card opens the detail page.
- **Add to cart:** cart badge increments and its subtotal rises; item appears in the cart.
- **Quantity & remove:** increase/decrease updates the line and the breakdown; remove empties the line.
- **Breakdown correctness:** for the carts in worked examples A, B and C, assert the rendered subtotal, each discount line, shipping, tax and total against the **literal expected cents** from §5.7 — not against numbers recomputed in the test.
- **Coupons — accepted:** apply `SAVE10` → a discount line appears and the total drops correctly; removing it reverts totals.
- **Coupons — rejected:** apply `TAKE15` under its min-spend → not applied, inline reason shown.
- **Coupons — exclusive loses:** worked example C through the UI.
- **Coupons — exclusive wins:** an exclusive that beats the stackable set applies alone; the others' chips disappear.
- **Pruning:** apply `TAKE15` at `6000`, drop the cart to `4000` → the chip disappears and the total reflects it (§5.6).

### 12.3 Conventions
- Assert on **user-visible outcomes** (rendered text, badge counts), not internal state.
- Never use fixed `sleep`s — rely on Playwright auto-waiting.
- Money assertions compare formatted strings against the literal expected values in §5.7.
