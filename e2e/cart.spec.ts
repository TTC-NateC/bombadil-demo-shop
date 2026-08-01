import { expect, test } from "@playwright/test";
import { addToCart, productIdBySlug } from "./helpers";

/** specs/01 §12.2 — add to cart, quantity & remove, breakdown correctness. */
test.describe("cart", () => {
  test("adding an item increments the badge and shows it in the cart", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("product-card-add").first().click();

    await expect(page.getByTestId("cart-badge")).toHaveText("Cart (1)");

    await page.goto("/cart");
    await expect(page.getByTestId("cart-line-item")).toHaveCount(1);
  });

  test("quantity steppers update the line and the breakdown", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie"); // 2400
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await expect(page.getByTestId("breakdown-subtotal")).toHaveText("$24.00");

    await page.getByTestId("cart-qty-increase").click();
    await expect(page.getByTestId("cart-qty-input")).toHaveText("2");
    await expect(page.getByTestId("breakdown-subtotal")).toHaveText("$48.00");

    await page.getByTestId("cart-qty-decrease").click();
    await expect(page.getByTestId("cart-qty-input")).toHaveText("1");
    await expect(page.getByTestId("breakdown-subtotal")).toHaveText("$24.00");
  });

  test("removing the last item empties the cart", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("cart-item-remove").click();

    await expect(page.getByText("Your cart is empty.")).toBeVisible();
    await expect(page.getByTestId("cart-line-item")).toHaveCount(0);
  });

  /**
   * Worked example A (§5.7A / defect #1). Literal expected cents from the spec —
   * the test does not recompute them.
   */
  test("worked example A — free shipping is subtracted exactly once", async ({ page, request }) => {
    const candle = await productIdBySlug(request, "cedar-candle"); // 2800
    await addToCart(page, candle, 1);
    await page.goto("/cart");

    await expect(page.getByTestId("breakdown-subtotal")).toHaveText("$28.00");
    await expect(page.getByTestId("breakdown-shipping")).toHaveText("$5.99");
    await expect(page.getByTestId("breakdown-tax")).toHaveText("$2.24");
    await expect(page.getByTestId("breakdown-total")).toHaveText("$36.23");

    await page.getByTestId("coupon-input").fill("FREESHIP");
    await page.getByTestId("coupon-apply").click();

    // Shipping renders FREE with the coupon attributed — NOT as a negative row.
    await expect(page.getByTestId("breakdown-shipping")).toHaveText("FREE (FREESHIP)");
    await expect(page.getByTestId("breakdown-discount")).toHaveCount(0);
    // Tax is unchanged: the shipping discount must not shrink the taxable base.
    await expect(page.getByTestId("breakdown-tax")).toHaveText("$2.24");
    // 3623 - 599 = 3024. If this reads $24.25 the shipping discount is being
    // subtracted twice — defect #1.
    await expect(page.getByTestId("breakdown-total")).toHaveText("$30.24");
  });

  test("the free-shipping threshold renders FREE without a coupon", async ({ page, request }) => {
    const sweater = await productIdBySlug(request, "merino-crew-sweater"); // 8900
    await addToCart(page, sweater, 1);
    await page.goto("/cart");

    await expect(page.getByTestId("breakdown-shipping")).toHaveText("FREE");
    await expect(page.getByTestId("breakdown-discount")).toHaveCount(0);
  });
});
