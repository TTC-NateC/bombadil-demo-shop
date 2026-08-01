# Slice 2 — Admin API & Data Pipeline

**Version:** 2.0
**Status:** Ready to hand to build agents
**Depends on:** slice 1 (schema, config, Docker, engine, cart)
**Ships on its own:** yes — it turns a fixed seeded demo into one you can fill with arbitrary data in seconds, including images.

> Adds **no** Prisma migrations. Every field it writes (`imageUrl`, `relatedIds`) is already in slice 1's schema.

---

## 1. Goals & Non-Goals

### Goals
- Admin API endpoints to create, update and delete products and coupons, individually and in bulk.
- Image upload and serving from the container's own volume — no S3, no CDN.
- A standalone staging script that fills a running instance with a large, varied, randomized catalog by driving the real admin API.

### Non-Goals
- No admin UI. The API and the staging script are the interface.
- No multi-tenant auth, roles, or audit trail. A single shared secret, documented as demo-grade.

---

## 2. Admin Authentication

All admin endpoints require the header `x-admin-key`, compared against the env var `ADMIN_API_KEY`. This is a **demo-grade guard** and is documented as such in the README.

### 2.1 Fail closed — in both places

**At startup** (`docker/entrypoint.sh`, extending slice 1 §10):
```sh
if [ "$NODE_ENV" = "production" ]; then
  case "$ADMIN_API_KEY" in
    ""|"change-me")
      echo "FATAL: ADMIN_API_KEY must be set to a non-default value." >&2
      exit 1 ;;
  esac
fi
```

**At request time**, unconditionally:
```ts
const configured = process.env.ADMIN_API_KEY;
if (!configured || configured === 'change-me') return unauthorized();  // never fail open
if (req.headers.get('x-admin-key') !== configured)  return unauthorized();
```

Note the shape deliberately avoided: `if (configured && header !== configured) return 401` **fails open** when the variable is unset. It is a pattern people write for local-dev convenience, and it is silent. Do not write it.

### 2.2 `.env.example`
```
ADMIN_API_KEY=""     # required — the container will refuse to start in production without this
UPLOAD_DIR="/data/uploads"
MAX_UPLOAD_BYTES="5242880"
```

Ship it **empty**. A `.env.example` exists to be copied to `.env`; shipping `change-me` in it means the documented happy path yields a container where a publicly-known string grants bulk catalog deletion and arbitrary file writes. §9's staging script explicitly targets "local **or a deployed container**", so a reachable instance is a scenario this spec plans for.

Constant-time comparison is the usual companion recommendation and is deliberately **not** specified: against a demo-grade shared secret with no rate limit it buys nothing.

---

## 3. Repository Additions

```
/
├── scripts/
│   └── stage-data.ts            # §9
├── staging/                     # sample input pools
│   ├── product-names.json
│   ├── descriptions.json
│   ├── categories.json
│   ├── adjectives.json
│   ├── coupons.json
│   ├── price-config.json
│   └── images/
├── e2e/
│   └── admin-api.spec.ts
└── src/
    ├── app/
    │   ├── uploads/[filename]/route.ts        # §8.2 — single segment, NOT catch-all
    │   └── api/
    │       ├── products/route.ts              # + POST, DELETE
    │       ├── products/bulk/route.ts
    │       ├── products/[id]/route.ts         # PATCH, DELETE
    │       ├── coupons/route.ts               # GET, POST, DELETE
    │       ├── coupons/bulk/route.ts
    │       ├── coupons/[id]/route.ts          # PATCH, DELETE
    │       └── uploads/route.ts               # POST
    └── lib/
        ├── admin-auth.ts
        ├── uploads.ts
        └── staging/                           # pure helpers, unit-tested (§9.6)
```

---

## 4. Products API

**`POST /api/products`** (admin) — create one. Accepts **either** JSON or `multipart/form-data`:
- **JSON:** `{ slug?, name, description?, priceCents, category?, imageUrl?, active?, relatedIds? }`
- **multipart/form-data:** same fields as form fields, plus an optional `image` file part (§8). When `image` is present it is stored and its served path becomes `imageUrl`. If both are provided, the uploaded `image` wins.

→ `201 { product }`. `slug` auto-generated from `name` if omitted. No image → `imageUrl` null, UI shows a placeholder.

**`POST /api/products/bulk`** (admin) — body `{ products: NewProduct[] }` → `201 { created, products }`. Validates every row; any invalid row returns `400` with per-index errors and creates **nothing** (all-or-nothing). JSON only — image uploads go through `POST /api/uploads` first (§8.3).

**`PATCH /api/products/[id]`** (admin) — partial update, JSON or multipart. → `200 { product }`, `404` if unknown.

> Changing `priceCents` does **not** reprice existing carts — they hold `unitPriceCentsSnapshot` (slice 1 §4.1).

**`DELETE /api/products/[id]`** (admin) → `200 { deleted: true }`, `404` if unknown. Cascades out of any carts via `onDelete: Cascade` (slice 1 §4.2) and deletes the uploaded image file if the product owns one.

**`DELETE /api/products`** (admin) — bulk. Body `{ ids: string[] }` **or** `?all=true` to clear the catalog (used by `--reset`). → `200 { deleted: number }`.

---

## 5. Coupons API

**`GET /api/coupons`** (admin) → `{ coupons }`.

**`POST /api/coupons`** (admin) — body mirrors the `Coupon` model. → `201 { coupon }`. `code` normalized to uppercase; duplicate → `409`.

**`POST /api/coupons/bulk`** (admin) — same all-or-nothing validation as products.

**`PATCH /api/coupons/[id]`** (admin) — partial update. → `200`, `404` unknown, `409` on code collision.

**`DELETE /api/coupons/[id]`** (admin) → `200 { deleted: true }`, `404` if unknown.

**`DELETE /api/coupons`** (admin) — body `{ ids }` or `{ codes }`, or `?all=true`. → `200 { deleted: number }`.

> A cart holding a deleted or deactivated code drops it on the next pricing pass — this is just slice 1 §5.6's prune rule, which needs no special case for deletion.

---

## 6. Validation & Errors

- **Zod** on all request bodies and query params; form fields parsed off `formData` and validated identically.
- Error shape `{ error: { message, code, details? } }`.
- Codes: `200` ok, `201` created, `400` validation, `401` bad/missing admin key, `404` unknown, `409` duplicate/collision, `413` file too large, `415` unsupported media type.

---

## 7. Store Configuration Additions

| Setting | Env var | Default |
|---|---|---|
| Admin key | `ADMIN_API_KEY` | *(none — required)* |
| Upload directory | `UPLOAD_DIR` | `/data/uploads` |
| Max upload size | `MAX_UPLOAD_BYTES` | `5242880` (5 MB) |

---

## 8. Image Uploads & Serving

Dead simple for a single container — no S3, no external CDN.

### 8.1 Storage
- Files are written to `UPLOAD_DIR` (`/data/uploads`), under the same `/data` volume as the SQLite DB, so one `-v cartdata:/data` persists both.
- The stored name is generated **server-side** as `<cuid>.<ext>`; the client's filename is never trusted or reflected.
- The extension is derived from the **validated MIME type**, not the original filename.
- **Validation:** `image/png`, `image/jpeg`, `image/webp`, `image/gif` only (→ `415`); max `MAX_UPLOAD_BYTES` (→ `413`).
- `imageUrl` is stored as a relative path: `/uploads/<cuid>.<ext>`.

### 8.2 Serving — `GET /uploads/[filename]`

A **single-segment** dynamic route. Not a catch-all.

```ts
// src/app/uploads/[filename]/route.ts   — Next 15: params is a Promise (slice 1 §7.5)
const NAME = /^[a-z0-9]+\.(png|jpe?g|webp|gif)$/;
const MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
               webp:'image/webp', gif:'image/gif' };

const { filename } = await params;
if (!NAME.test(filename)) return notFound();

const root     = path.resolve(process.env.UPLOAD_DIR!);
const resolved = path.resolve(root, filename);
if (!resolved.startsWith(root + path.sep)) return notFound();   // defence in depth

// Content-Type from the extension via MIME — never from the request.
// Always send X-Content-Type-Options: nosniff.
```

**Why this shape.** A `[...path]` catch-all hands attacker-controlled path segments straight to `path.join(UPLOAD_DIR, ...)`. `UPLOAD_DIR` is `/data/uploads` and the database is at `/data/app.db` — one level up. `GET /uploads/../app.db`, or `%2e%2e%2fapp.db` if the plain form is normalised away, is the entire store in one request. Next's pathname normalisation may block it today, but that is version-dependent behaviour nobody has a test for. The filename regex makes traversal unrepresentable (stored names are flat cuids; there are no subdirectories to support), and the resolve-check covers whoever later "just adds" a folder.

**Do not** use Next's `public/` static mechanism as an alternative. `public/` is baked into the image at build time, so files written to a mounted volume at runtime will never be served from it.

### 8.3 Standalone upload endpoint
**`POST /api/uploads`** (admin, multipart with an `image` part) → `201 { url }`. Callers reference the returned `url` as `imageUrl` in `POST /api/products` or the bulk endpoint. This keeps `/api/products/bulk` pure JSON.

### 8.4 Docker additions
Extend slice 1's entrypoint: `mkdir -p /data/uploads` before starting, so the first upload doesn't fail on a fresh volume.

---

## 9. Test Data Staging Script

A standalone script that fills a *running* instance with a large randomized catalog by driving the **real admin API** — so it exercises the actual endpoints, including image upload. This is the tool used to fill a demo before showing it off.

### 9.1 Invocation
`scripts/stage-data.ts`, run via `npm run stage` (`tsx scripts/stage-data.ts`).

```
npm run stage -- \
  --base-url http://localhost:3000 \
  --admin-key secret \
  --products 50 \       # alias: -p / --num-products
  --coupons 15 \        # alias: -c / --num-coupons
  --input-dir ./staging \
  --seed 1234 \         # RNG seed for reproducible payloads
  --reset \             # clear catalog + coupons first
  --dry-run
```

Defaults: `--base-url http://localhost:3000`, `--products 40`, `--coupons 12`, `--input-dir ./staging`. Reads `ADMIN_API_KEY` from env if `--admin-key` is omitted. `--products 0` / `--coupons 0` skips that entity entirely.

### 9.2 Input pools
Under `--input-dir` (a sample set ships in `./staging`): `product-names.json`, `descriptions.json`, `categories.json`, `adjectives.json` (optional), `coupons.json` (templates, §9.4), `price-config.json` (`{ minCents, maxCents, roundTo: 99, perCategory? }`), and `images/`.

Every file is optional; missing files fall back to small built-in defaults. These are pools of **possible** values — the script samples from them, it does not use them one-to-one.

### 9.3 Product generation
For each of `--products`:
1. **Compose a name** by sampling `product-names.json`, optionally prefixed by an `adjectives.json` entry; derive a slug.
2. **Ensure the slug is free.** Before generating, `GET /api/products?all=true` and collect existing slugs; also track slugs generated during this run. On collision, append a variant suffix and retry.
   > Without this, a second `npm run stage` without `--reset` collides on `slug @unique` for most rows — the most likely real-world failure of this script, since §9.5 says append mode is the default.
3. **Pick a category** at random from `categories.json`.
4. **Pick a description**, optionally concatenating 1–2 fragments.
5. **Pick a price** within `price-config.json` bounds (honouring `perCategory`), applying charm rounding (`roundTo`, e.g. always end in `99`). Integer cents throughout.
6. **Pick an image** from `staging/images/` — without replacement until exhausted, then reuse.
7. **Upload then create:** `POST /api/uploads` → reference the returned `url` in `POST /api/products`. (Direct multipart to `POST /api/products` is also acceptable; the standalone endpoint is the default for clean separation.)
8. After all products exist, optionally wire **`relatedIds`** for a random subset — 2–4 same-category peers, so slice 3's recommendations have curated data.

### 9.4 Coupon generation
`coupons.json` holds templates; each may fix some fields and randomize others:
```json
[
  { "type": "PERCENT", "valueRange": [500, 3000], "stackable": true },
  { "type": "FIXED", "valueRange": [500, 2000], "minSubtotalRange": [3000, 8000] },
  { "type": "FREE_SHIPPING" },
  { "type": "PERCENT", "value": 2500, "stackable": false, "maxDiscountCents": 3000 },
  { "type": "PERCENT", "valueRange": [1000, 2000], "targetType": "CATEGORY" }
]
```
- Generates unique human-ish codes (`SAVE10`, `SUMMER20`, `FREESHIP`, random-suffixed to avoid collisions).
- Guarantees at least one of each interesting case — stackable percent, min-spend fixed, free shipping, exclusive, category-targeted — so the demo always shows the full engine.
- **`targetType: CATEGORY` resolution:** pick a category that exists in the catalog. If the catalog is empty (e.g. `--products 0`), fall back to a category from `categories.json`; if that is also unavailable, skip the template and log a warning. Do not fail the run.

### 9.5 Behaviour
- **`--reset`** clears via `DELETE /api/products?all=true` and `DELETE /api/coupons?all=true`, then creates fresh data. Without it, the script **appends** — see §9.3 step 2.
- **`--seed`** seeds the RNG. Reproducibility means **identical generated payloads**, not identical database rows: product IDs are `@default(cuid())`, generated by the database, so rows differ every run regardless of seed. Verify via `--dry-run` (§9.6).
- **Resilience:** validate inputs up front; on a failed API call, log the offending item and continue, then print `created: N products, M coupons; skipped: X`.
- **`--dry-run`** prints what would be created without calling the API.
- Uses only the public admin API + `fetch` — no direct DB access — so it works against any running instance.

### 9.6 Tests
- Unit-test the pure helpers (name composer, slug de-duplicator, price picker with charm rounding, template resolver) with a fixed seed for deterministic output.
- A smoke test that runs `--dry-run` against sample inputs and asserts every generated payload is schema-valid.
- Assert `--seed S` twice produces **byte-identical dry-run payloads**.

---

## 10. Acceptance Criteria

1. `POST /api/products/bulk` and `POST /api/coupons/bulk` create many records in one call, guarded by `x-admin-key`, with all-or-nothing validation.
2. Every admin write endpoint returns `401` without a valid `x-admin-key`; with `ADMIN_API_KEY` unset, admin writes return `401` rather than succeeding.
3. With `NODE_ENV=production` and `ADMIN_API_KEY` unset or `change-me`, the container **refuses to start** with a clear message.
4. `POST /api/products` with multipart including an `image` creates the product, persists the file under `/data/uploads`, sets `imageUrl` to the served path, and the image renders on the catalog and product page **after a container restart**. Invalid type → `415`, oversized → `413`.
5. `GET /uploads/..%2fapp.db` (and `../app.db`) returns `404`; served images carry a correct `Content-Type` and `X-Content-Type-Options: nosniff`.
6. `DELETE /api/products/[id]` succeeds for a product **currently sitting in a cart**, and the cart no longer contains it.
7. `npm run stage --reset --seed S` against a clean instance creates exactly `--products` products and `--coupons` coupons, reporting `skipped: 0`. On any run, `created + skipped === N`.
8. Running `npm run stage` **twice without `--reset`** creates the full requested count on both runs — slugs are de-duplicated, not skipped.
9. `--seed S` produces byte-identical `--dry-run` payloads across runs; `--dry-run` writes nothing.
10. Changing a product's price via `PATCH` does not alter the total of a cart that already contains it.

---

## 11. Acceptance Tests (Playwright)

`e2e/admin-api.spec.ts`, using the same `webServer` harness as slice 1 (§12.1 there), with `ADMIN_API_KEY` set to a known test value and a temp `UPLOAD_DIR`.

- **Auth:** admin write with no header → `401`; with a wrong key → `401`; with the right key → `201`.
- **Bulk:** valid batch → `201` with correct `created` count; one invalid row → `400` with per-index errors and **zero** rows created.
- **Upload happy path:** multipart create → `201`; `GET` the returned `imageUrl` → `200` with the right `Content-Type`; the image renders on the catalog.
- **Upload rejection:** a `.txt` part → `415`; an oversized file → `413`.
- **Traversal (negative):** `GET /uploads/..%2fapp.db` → `404`. `GET /uploads/../app.db` → `404`.
- **Delete with cart reference:** add a product to a cart, `DELETE` the product → `200`, and the cart renders without it.
- **Price snapshot:** add to cart, `PATCH` the price, re-fetch the cart → total unchanged.
- **Persistence smoke (optional):** an uploaded image and created product survive a restart, if the harness supports restarting within the suite.
