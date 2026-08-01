import { expect, test } from "@playwright/test";
import { addToCart, productIdBySlug } from "./helpers";

/** specs/03 §6. */
test.describe("recommendations", () => {
  test("the PDP row is non-empty and honours curated relatedIds first", async ({ page }) => {
    // aurora-wireless-headphones is seeded with relatedIds:
    // [pulse-bluetooth-speaker, halo-webcam, nimbus-usbc-hub] (specs/01 §9).
    await page.goto("/product/aurora-wireless-headphones");

    await expect(page.getByText("You might also like")).toBeVisible();
    const cards = page.getByTestId("recommendation-card");
    await expect(cards).toHaveCount(4);

    // The three curated picks lead, in the order they are listed.
    await expect(cards.nth(0)).toContainText("Pulse Bluetooth Speaker");
    await expect(cards.nth(1)).toContainText("Halo 1440p Webcam");
    await expect(cards.nth(2)).toContainText("Nimbus USB-C Hub");
  });

  test("the row never contains the product being viewed", async ({ page }) => {
    await page.goto("/product/aurora-wireless-headphones");
    await expect(page.getByTestId("recommendation-card").first()).toBeVisible();

    // Count-based, not `not.toContainText`: the latter trips strict mode on a
    // locator that resolves to several elements.
    await expect(
      page.getByTestId("recommendation-card").filter({ hasText: "Aurora Wireless Headphones" }),
    ).toHaveCount(0);
  });

  test("a product with no curated picks still gets a non-empty row", async ({ page }) => {
    // wool-beanie has no relatedIds — the category and fallback layers must
    // keep the section from ever being empty (§2.1).
    await page.goto("/product/wool-beanie");
    await expect(page.getByTestId("recommendation-card").first()).toBeVisible();
  });

  test("adding a recommendation adds it to the cart", async ({ page }) => {
    await page.goto("/product/aurora-wireless-headphones");

    const first = page.getByTestId("recommendation-card").first();
    const name = (await first.locator("a").nth(1).innerText()).trim();
    await first.getByTestId("recommendation-add").click();

    await expect(page.getByTestId("cart-badge")).toHaveText("Cart (1)");

    await page.goto("/cart");
    await expect(page.getByTestId("cart-line-item")).toContainText(name);
  });

  test("the cart strip excludes items already in the cart", async ({ page, request }) => {
    const headphones = await productIdBySlug(request, "aurora-wireless-headphones");
    const speaker = await productIdBySlug(request, "pulse-bluetooth-speaker");
    await addToCart(page, headphones, 1);
    await addToCart(page, speaker, 1);

    await page.goto("/cart");
    await expect(page.getByText("Add to your order")).toBeVisible();

    const cards = page.getByTestId("recommendation-card");
    await expect(cards.first()).toBeVisible();
    await expect(cards.filter({ hasText: "Aurora Wireless Headphones" })).toHaveCount(0);
    await expect(cards.filter({ hasText: "Pulse Bluetooth Speaker" })).toHaveCount(0);
  });

  test("the API honours ?limit and ignores unknown ids", async ({ request }) => {
    const limited = await request.get("/api/products/aurora-wireless-headphones/recommendations?limit=2");
    expect((await limited.json()).products).toHaveLength(2);

    const unknown = await request.get("/api/recommendations?productIds=ghost,also-ghost&limit=3");
    expect(unknown.status()).toBe(200);
    expect((await unknown.json()).products).toHaveLength(3);

    expect((await request.get("/api/products/nope/recommendations")).status()).toBe(404);
  });
});
