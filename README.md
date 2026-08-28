# demo-shop

A shopping-cart demo: Next.js 15 (App Router) + Prisma + SQLite, packaged as a
single container with no external services. The interesting part is the pricing
engine — line-item discounts, stacking rules, category targeting, tax, and
shipping thresholds.

- Spec: [shopping-cart-demo-spec.md](shopping-cart-demo-spec.md) and [specs/](specs/)
- Implementation notes: [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)

## Requirements

- Node.js 20+
- npm

Nothing else. The database is a SQLite file; there is no service to stand up.

## Run it locally

```bash
npm install
cp .env.example .env      # then set ADMIN_API_KEY — see "Environment" below
npm run db:deploy         # apply migrations
npm run db:seed           # 16 products, 5 coupons
npm run dev
```

Open <http://localhost:3000>.

For local development the checked-in [.env](.env) already points at
`file:./dev.db` with `ADMIN_API_KEY="local-dev-key"`, so if you have that file
you can skip straight to `npm run dev`. `.env.example` targets the container
paths (`/data`) instead, and deliberately ships an empty admin key.

If Prisma's client is missing or stale after a schema change:

```bash
npx prisma generate
```

## What to look at

| Route | What it does |
| --- | --- |
| `/` | Catalog listing |
| `/product/[slug]` | Product detail plus recommendations |
| `/cart` | Cart, coupon entry, and the full pricing breakdown |

Seeded coupon codes — one per pricing-engine code path:

| Code | Behaviour |
| --- | --- |
| `SAVE10` | 10% off the cart |
| `TAKE15` | $15 off orders over $50 |
| `FREESHIP` | Free shipping |
| `VIP25` | 25% off, capped at $30, **not** stackable |
| `ELECTRO20` | 20% off the Electronics category |

Default pricing rules come from the environment: 8% tax, not applied to
shipping, $5.99 flat shipping, free over $50.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file path, e.g. `file:./dev.db` |
| `STORE_CURRENCY` | Display currency (`USD`) |
| `TAX_RATE_BPS` | Tax rate in basis points (`800` = 8%) |
| `TAX_ON_SHIPPING` | Whether shipping is taxable |
| `SHIPPING_FLAT_CENTS` | Flat shipping charge |
| `FREE_SHIPPING_THRESHOLD_CENTS` | Subtotal at which shipping is free |
| `ADMIN_API_KEY` | Required for every admin endpoint |
| `UPLOAD_DIR` | Where uploaded product images are written |
| `MAX_UPLOAD_BYTES` | Upload size ceiling (5 MB default) |

`ADMIN_API_KEY` has no safe default on purpose. When `NODE_ENV=production` the
container entrypoint refuses to boot if it is unset or left as `change-me`,
because a known default would hand anyone bulk catalog deletion and arbitrary
file writes.

## API

Public:

```
GET             /api/products
GET             /api/products/[idOrSlug]
GET             /api/products/[idOrSlug]/recommendations
GET             /api/recommendations
GET             /api/cart
POST PATCH DEL  /api/cart/items
POST DEL        /api/cart/coupons
GET             /uploads/[filename]
```

Admin — these require an `x-admin-key` header:

```
POST DEL        /api/products             (DELETE = bulk delete)
POST            /api/products/bulk
PATCH DEL       /api/products/[idOrSlug]
GET POST DEL    /api/coupons
POST            /api/coupons/bulk
PATCH DEL       /api/coupons/[id]
POST            /api/uploads
```

```bash
curl -H "x-admin-key: local-dev-key" http://localhost:3000/api/coupons
```

## Test data

`npm run stage` fills a **running** instance by driving the real admin API
(including image upload), so it works against a local server or a deployed
container:

```bash
npm run stage -- --base-url http://localhost:3000 --admin-key local-dev-key \
                 --products 40 --coupons 12 --seed 1
```

Useful flags: `--reset` to clear first, `--dry-run` to preview, `--input-dir`
to point at a different image/source directory (defaults to [staging/](staging/)).

## Tests

```bash
npm test           # vitest — unit tests under src/, prisma/, scripts/
npm run test:e2e   # playwright — builds, starts on :3311 against prisma/e2e.db
```

The e2e suite runs single-worker on purpose. SQLite is single-writer, and
parallel workers against one database file produce `SQLITE_BUSY` errors that
surface as intermittent, plausible-looking *pricing* bugs. If it gets too slow,
the fix is WAL mode plus a busy timeout — not more workers.

## Property-based tests (Bombadil)

[Bombadil](https://antithesishq.github.io/bombadil/) drives a real browser and
generates its own clicks, scrolls, typing and navigation, checking the
properties in [bombadil/spec.ts](bombadil/spec.ts) against every state it
captures. Where the Playwright suite asserts that *a* scripted scenario works,
these properties must hold *whatever* the shopper does.

Unlike Playwright, Bombadil does not start the server for you:

```bash
npm run build && npm start   # in one terminal
npm run test:bombadil        # in another
```

Prefer a production build over `npm run dev`. The properties are timing
sensitive, and dev-mode recompilation adds multi-second page loads that both
wipe toasts before they can be sampled and blur the auto-dismiss window.

Useful flags — see `bombadil browser test --help` for the rest:

| Flag | Why |
| --- | --- |
| `--time-limit 5m` | How long to explore. Longer runs reach more states. |
| `--exit-on-violation` | Stop at the first failure. Good for CI. |
| `--headless` | No visible window. |
| `--output-path <dir>` | Where the trace, screenshots and downloads land. |
| `--reproduce <dir>` | Replay a previous run's trace instead of exploring. |

A run prints a `bombadil browser inspect <dir>` command for stepping through the
trace, and a `--reproduce` command for replaying a violation deterministically.

**On Windows**, `npm run test:bombadil` fails with `unsupported platform
win32-x64`: the npm package only ships Linux and macOS binaries, and npm puts
its own shim first on `PATH`. Install the CLI with `cargo install bombadil` and
invoke it directly instead — the npm dependency is still needed, because it
carries the TypeScript definitions the specification is written against.

## Run in production mode (Docker)

The image is the real production artifact: `NODE_ENV=production`, a Next
standalone build, no hot reload. Code changes require a rebuild. There is no
dev-mode container — for iterating, use `npm run dev` above.

Build and run:

```bash
docker build -t demo-shop:local .

docker run -d --name demo-shop \
  -p 3000:3000 \
  -v demo-shop-data:/data \
  -e ADMIN_API_KEY=choose-a-real-key \
  --restart unless-stopped \
  demo-shop:local
```

Open <http://localhost:3000>. First boot takes a few seconds while the
entrypoint prepares the database; after that Next itself starts in well under a
second.

`ADMIN_API_KEY` is the only variable you must supply. The image already sets
`DATABASE_URL=file:/data/app.db` and `UPLOAD_DIR=/data/uploads`, and every
pricing variable falls back to the defaults in
[src/lib/pricing/config.ts](src/lib/pricing/config.ts) — which match `.env`, so
tax and shipping behave identically to local. Override any of them with more
`-e` flags if you want to explore different store rules:

```bash
docker run -d --name demo-shop -p 3000:3000 -v demo-shop-data:/data \
  -e ADMIN_API_KEY=choose-a-real-key \
  -e TAX_RATE_BPS=0 -e FREE_SHIPPING_THRESHOLD_CENTS=0 \
  demo-shop:local
```

Note that `.env` is listed in `.dockerignore` and is **not** baked into the
image — nothing leaks in from your local file.

### What happens at boot

The entrypoint ([docker/entrypoint.sh](docker/entrypoint.sh)) in order:

1. Refuses to start if `ADMIN_API_KEY` is unset or `change-me`, since
   `NODE_ENV=production`. This is a hard exit, not a warning.
2. Creates `/data` and the upload directory on the mounted volume.
3. Runs `prisma migrate deploy`, then `prisma db seed`. The seed upserts by
   slug and code, so it is idempotent and safe on every restart.
4. Execs `node server.js`.

Migrations and the seed run with `npx --no-install` on purpose: at boot the
container should fail loudly rather than reach for the network.

### State

State lives in the `demo-shop-data` volume, **not** in your working copy — it is
completely separate from the local `prisma/dev.db`. Carts, uploads, and any
catalog edits made through the admin API persist across restarts.

```bash
docker logs -f demo-shop            # follow logs
docker exec -it demo-shop sh        # shell inside
docker stop demo-shop               # stop (restarts on boot until removed)
docker rm -f demo-shop              # remove the container
docker volume rm demo-shop-data     # wipe all data, back to a fresh seed
```

`--restart unless-stopped` means the container comes back after a reboot. Drop
that flag if you would rather start it by hand.

### Verifying it came up

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/products
curl -s -H "x-admin-key: choose-a-real-key" http://localhost:3000/api/coupons
```

A correct key returns the five seeded coupons; a missing or wrong key returns
401.

### Why node:20-slim

Not Alpine. Prisma's musl query engine is the most common Next+Prisma container
failure and it only shows up on someone else's machine. Debian's glibc/openssl3
removes that whole class of bug for about 40MB. The built image is roughly
800MB.

## Useful scripts

| Command | Effect |
| --- | --- |
| `npm run dev` | Dev server with hot reload on :3000 |
| `npm run build` / `npm start` | Production build and serve |
| `npm run db:migrate` | Create and apply a migration (dev) |
| `npm run db:deploy` | Apply existing migrations |
| `npm run db:seed` | Load baseline products and coupons |
| `npm run db:studio` | Prisma Studio |
| `npm run stage` | Populate a running instance via the admin API |
