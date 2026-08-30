import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { addToCart } from "./helpers";

/** specs/02 §11. */
const KEY = "e2e-admin-key";
const admin = { "x-admin-key": KEY };
const SAMPLE_IMAGE = path.join(process.cwd(), "staging", "images", "sample-1.png");
const SAMPLE_BYTES = readFileSync(SAMPLE_IMAGE);

/**
 * Playwright runs spec files alphabetically, so this one goes first and would
 * otherwise leave products and coupons behind that catalog.spec.ts's exact
 * counts would then trip over. Snapshot the seeded state and restore it.
 */
let seededProductIds = new Set<string>();
let seededCouponIds = new Set<string>();

test.beforeAll(async () => {
  const api = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const { products } = await (await api.get("/api/products?all=true")).json();
  const { coupons } = await (await api.get("/api/coupons", { headers: admin })).json();
  seededProductIds = new Set(products.map((p: { id: string }) => p.id));
  seededCouponIds = new Set(coupons.map((c: { id: string }) => c.id));
  await api.dispose();
});

test.afterAll(async () => {
  const api = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });

  const { products } = await (await api.get("/api/products?all=true")).json();
  const strayProducts = products
    .filter((p: { id: string }) => !seededProductIds.has(p.id))
    .map((p: { id: string }) => p.id);
  if (strayProducts.length) {
    await api.delete("/api/products", { headers: admin, data: { ids: strayProducts } });
  }

  const { coupons } = await (await api.get("/api/coupons", { headers: admin })).json();
  const strayCoupons = coupons
    .filter((c: { id: string }) => !seededCouponIds.has(c.id))
    .map((c: { id: string }) => c.id);
  if (strayCoupons.length) {
    await api.delete("/api/coupons", { headers: admin, data: { ids: strayCoupons } });
  }

  await api.dispose();
});

test.describe("admin auth", () => {
  test("rejects a write with no header, and with a wrong key", async ({ request }) => {
    const body = { name: "Unauthorised", priceCents: 1000 };

    expect((await request.post("/api/products", { data: body })).status()).toBe(401);
    expect(
      (await request.post("/api/products", { data: body, headers: { "x-admin-key": "nope" } })).status(),
    ).toBe(401);
  });

  test("accepts the correct key", async ({ request }) => {
    const response = await request.post("/api/products", {
      headers: admin,
      data: { name: "Authorised Widget", priceCents: 1234 },
    });
    expect(response.status()).toBe(201);
    const { product } = await response.json();
    expect(product.slug).toBe("authorised-widget");
  });

  test("guards every admin surface", async ({ request }) => {
    expect((await request.get("/api/coupons")).status()).toBe(401);
    expect((await request.post("/api/products/bulk", { data: {} })).status()).toBe(401);
    expect((await request.post("/api/coupons/bulk", { data: {} })).status()).toBe(401);
    expect((await request.post("/api/uploads")).status()).toBe(401);
    expect((await request.delete("/api/products?all=true")).status()).toBe(401);
  });
});

test.describe("bulk endpoints", () => {
  test("create many in one call", async ({ request }) => {
    const response = await request.post("/api/products/bulk", {
      headers: admin,
      data: {
        products: [
          { name: "Bulk One", priceCents: 1000, category: "Home" },
          { name: "Bulk Two", priceCents: 2000, category: "Home" },
          { name: "Bulk Three", priceCents: 3000, category: "Home" },
        ],
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.created).toBe(3);
  });

  test("one invalid row creates ZERO rows", async ({ request }) => {
    const before = await (await request.get("/api/products?all=true")).json();

    const response = await request.post("/api/products/bulk", {
      headers: admin,
      data: {
        products: [
          { name: "Should Not Exist", priceCents: 1000 },
          { name: "Bad Row", priceCents: -5 },
        ],
      },
    });
    expect(response.status()).toBe(400);

    const after = await (await request.get("/api/products?all=true")).json();
    expect(after.products.length).toBe(before.products.length);
    expect(after.products.some((p: { name: string }) => p.name === "Should Not Exist")).toBe(false);
  });

  test("duplicate coupon codes are rejected with 409", async ({ request }) => {
    const data = {
      coupons: [
        { code: "DUPE1", type: "PERCENT", value: 500 },
        { code: "DUPE1", type: "PERCENT", value: 600 },
      ],
    };
    expect((await request.post("/api/coupons/bulk", { headers: admin, data })).status()).toBe(409);
  });
});

test.describe("uploads", () => {
  test("round-trips an image and serves it with the right headers", async ({ request }) => {
    const upload = await request.post("/api/uploads", {
      headers: admin,
      multipart: { image: { name: "sample-1.png", mimeType: "image/png", buffer: SAMPLE_BYTES } },
    });
    expect(upload.status()).toBe(201);
    const { url } = await upload.json();
    expect(url).toMatch(/^\/uploads\/[a-z0-9-]+\.png$/);

    const served = await request.get(url);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/png");
    // Serving user-uploaded content from the app's own origin without nosniff
    // is the sniffing surface the MIME table exists to close (§8.2).
    expect(served.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("rejects a non-image and an oversized file", async ({ request }) => {
    const text = await request.post("/api/uploads", {
      headers: admin,
      multipart: { image: { name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("nope") } },
    });
    expect(text.status()).toBe(415);

    // Validation reads the MIME type, never the client's filename.
    const disguised = await request.post("/api/uploads", {
      headers: admin,
      multipart: { image: { name: "sneaky.png", mimeType: "text/plain", buffer: Buffer.from("nope") } },
    });
    expect(disguised.status()).toBe(415);

    const big = await request.post("/api/uploads", {
      headers: admin,
      multipart: { image: { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(6 * 1024 * 1024) } },
    });
    expect(big.status()).toBe(413);
  });

  /** specs/02 AC5 / defect #7. UPLOAD_DIR is /data/uploads; the DB is one level up. */
  test("path traversal is a 404, in every encoding", async ({ request }) => {
    for (const attempt of [
      "..%2fapp.db",
      "..%252fapp.db",
      "%2e%2e%2fapp.db",
      "nested/path.png",
      "not-a-uuid.exe",
    ]) {
      const response = await request.get(`/uploads/${attempt}`);
      expect(response.status(), attempt).toBe(404);
    }
  });
});

test.describe("product lifecycle", () => {
  /** defect #4 — Prisma's default Restrict would raise P2003 here. */
  test("deleting a product removes it from live carts", async ({ page, request }) => {
    const created = await request.post("/api/products", {
      headers: admin,
      data: { name: "Doomed Product", priceCents: 4200, category: "Home" },
    });
    const { product } = await created.json();

    await addToCart(page, product.id, 2);
    let cart = await (await page.request.get("/api/cart")).json();
    expect(cart.items).toHaveLength(1);

    const deleted = await request.delete(`/api/products/${product.id}`, { headers: admin });
    expect(deleted.status()).toBe(200);

    cart = await (await page.request.get("/api/cart")).json();
    expect(cart.items).toHaveLength(0);
  });

  /** specs/02 AC10 — the price snapshot (§4.1). */
  test("changing a price does not reprice an existing cart", async ({ page, request }) => {
    const created = await request.post("/api/products", {
      headers: admin,
      data: { name: "Stable Price Item", priceCents: 5000, category: "Home" },
    });
    const { product } = await created.json();

    await addToCart(page, product.id, 1);
    const before = await (await page.request.get("/api/cart")).json();

    await request.patch(`/api/products/${product.id}`, {
      headers: admin,
      data: { priceCents: 9999 },
    });

    const after = await (await page.request.get("/api/cart")).json();
    expect(after.totalCents).toBe(before.totalCents);
    expect(after.items[0].unitPriceCents).toBe(5000);
  });

  test("unknown ids are 404", async ({ request }) => {
    expect((await request.patch("/api/products/nope", { headers: admin, data: {} })).status()).toBe(404);
    expect((await request.delete("/api/products/nope", { headers: admin })).status()).toBe(404);
    expect((await request.delete("/api/coupons/nope", { headers: admin })).status()).toBe(404);
  });

  test("a duplicate coupon code is a 409", async ({ request }) => {
    const data = { code: "UNIQUE1", type: "PERCENT", value: 500 };
    expect((await request.post("/api/coupons", { headers: admin, data })).status()).toBe(201);
    expect((await request.post("/api/coupons", { headers: admin, data })).status()).toBe(409);
  });
});
