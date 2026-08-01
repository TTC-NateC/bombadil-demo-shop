import type { APIRequestContext, Page } from "@playwright/test";

/** Resolve a seeded product id by slug, through the public API. */
export async function productIdBySlug(request: APIRequestContext, slug: string): Promise<string> {
  const response = await request.get("/api/products");
  const { products } = (await response.json()) as { products: { id: string; slug: string }[] };
  const match = products.find((p) => p.slug === slug);
  if (!match) throw new Error(`No seeded product with slug "${slug}"`);
  return match.id;
}

/**
 * Build a known cart through the API rather than the browser. §12.1: prefer the
 * API for setup speed, reserve the browser for the behaviour under test.
 */
export async function addToCart(page: Page, productId: string, quantity = 1): Promise<void> {
  const response = await page.request.post("/api/cart/items", {
    data: { productId, quantity },
  });
  if (!response.ok()) throw new Error(`add to cart failed: ${response.status()}`);
}

export async function applyCoupon(page: Page, code: string): Promise<void> {
  await page.request.post("/api/cart/coupons", { data: { code } });
}

export const text = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).innerText()).trim();
