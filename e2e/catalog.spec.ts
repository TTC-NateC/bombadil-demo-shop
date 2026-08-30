import { expect, test } from "@playwright/test";

/** specs/01 §12.2 — catalog & navigation. */
test.describe("catalog", () => {
  test("renders the seeded products with prices", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("product-card")).toHaveCount(16);
    await expect(page.getByText("Aurora Wireless Headphones").first()).toBeVisible();
    await expect(page.getByText("$249.99")).toBeVisible();
  });

  test("clicking a card opens the product detail page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Aurora Wireless Headphones" }).first().click();

    await expect(page).toHaveURL(/\/product\/aurora-wireless-headphones$/);
    await expect(page.getByRole("heading", { name: "Aurora Wireless Headphones" })).toBeVisible();
    await expect(page.getByTestId("pdp-add-to-cart")).toBeVisible();
  });

  test("category chips filter the grid", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Electronics", exact: true }).click();

    await expect(page.getByTestId("product-card")).toHaveCount(5);
  });

  test("the cart badge starts empty", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("cart-badge")).toHaveText("Cart (0)");
  });
});
