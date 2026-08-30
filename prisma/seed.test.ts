/**
 * Phase 1 tasks 1.2 and 1.3.
 *
 * Runs against a throwaway SQLite file so it can't disturb the dev database.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COUPON_FIXTURES, PRODUCT_FIXTURES } from "./fixtures";
import { seed } from "./seed";

const TEST_DB = path.join(process.cwd(), "prisma", "test-seed.db");
let prisma: PrismaClient;

beforeAll(() => {
  rmSync(TEST_DB, { force: true });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  prisma = new PrismaClient({ datasourceUrl: `file:${TEST_DB}` });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
});

describe("task 1.2 — product deletion cascades out of carts", () => {
  it("removes the CartItem instead of raising P2003", async () => {
    const product = await prisma.product.create({
      data: { slug: "cascade-probe", name: "Cascade Probe", priceCents: 1000 },
    });
    const cart = await prisma.cart.create({ data: {} });
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        quantity: 1,
        unitPriceCentsSnapshot: product.priceCents,
      },
    });

    // Without `onDelete: Cascade` on CartItem.product this throws P2003 —
    // Prisma's default for a required relation is Restrict (§4.2).
    await expect(prisma.product.delete({ where: { id: product.id } })).resolves.toBeTruthy();

    expect(await prisma.cartItem.count({ where: { productId: product.id } })).toBe(0);
    // The cart itself survives; only the line goes.
    expect(await prisma.cart.findUnique({ where: { id: cart.id } })).not.toBeNull();
  });

  it("cascades the other direction too: deleting a cart removes its items", async () => {
    const product = await prisma.product.create({
      data: { slug: "cascade-probe-2", name: "Cascade Probe 2", priceCents: 1000 },
    });
    const cart = await prisma.cart.create({ data: {} });
    await prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        quantity: 1,
        unitPriceCentsSnapshot: product.priceCents,
      },
    });

    await prisma.cart.delete({ where: { id: cart.id } });

    expect(await prisma.cartItem.count({ where: { cartId: cart.id } })).toBe(0);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).not.toBeNull();

    // Probe rows are scaffolding, not fixtures. Left behind they pollute the
    // seed's row-count and category assertions below.
    await prisma.product.delete({ where: { id: product.id } });
  });
});

describe("task 1.3 — the seed", () => {
  it("is idempotent across repeated runs", async () => {
    await seed(prisma);
    const first = {
      products: await prisma.product.count(),
      coupons: await prisma.coupon.count(),
    };

    await seed(prisma);
    const second = {
      products: await prisma.product.count(),
      coupons: await prisma.coupon.count(),
    };

    expect(second).toEqual(first);
    expect(first.products).toBe(PRODUCT_FIXTURES.length);
    expect(first.coupons).toBe(COUPON_FIXTURES.length);
  });

  it("creates 12-20 products across 3-4 categories", async () => {
    await seed(prisma);
    const products = await prisma.product.findMany();
    expect(products.length).toBeGreaterThanOrEqual(12);
    expect(products.length).toBeLessThanOrEqual(20);

    const categories = new Set(products.map((p) => p.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
    expect(categories.size).toBeLessThanOrEqual(4);
  });

  it("creates each of the five named coupons exactly once", async () => {
    await seed(prisma);
    for (const code of ["SAVE10", "TAKE15", "FREESHIP", "VIP25", "ELECTRO20"]) {
      expect(await prisma.coupon.count({ where: { code } }), `coupon ${code}`).toBe(1);
    }
  });

  it("curates relatedIds on at least 3 products, all resolving to real products", async () => {
    // Slice 3 claims it does not require slice 2 because "relatedIds can be set
    // by the seed". If this assertion alone fails, that claim is false and task
    // 11.2's RED cannot go green.
    await seed(prisma);
    const products = await prisma.product.findMany();
    const ids = new Set(products.map((p) => p.id));

    const curated = products.filter((p) => (JSON.parse(p.relatedIds) as string[]).length > 0);
    expect(curated.length).toBeGreaterThanOrEqual(3);

    for (const product of curated) {
      const related = JSON.parse(product.relatedIds) as string[];
      expect(related.length).toBeGreaterThanOrEqual(2);
      expect(related.length).toBeLessThanOrEqual(4);
      for (const id of related) {
        expect(ids.has(id), `${product.slug} -> ${id} must be a real product`).toBe(true);
      }
      expect(related).not.toContain(product.id);
    }
  });

  it("stores every price as an integer number of cents", async () => {
    await seed(prisma);
    for (const product of await prisma.product.findMany()) {
      expect(Number.isInteger(product.priceCents), product.slug).toBe(true);
      expect(product.priceCents).toBeGreaterThan(0);
    }
    for (const coupon of await prisma.coupon.findMany()) {
      expect(Number.isInteger(coupon.value), coupon.code).toBe(true);
    }
  });
});
