import { expect, test } from "@playwright/test";
import { addToCart, applyCoupon, productIdBySlug } from "./helpers";

/** specs/03 §6. */
test.describe("toasts", () => {
  test("adding an item toasts, then auto-dismisses", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("product-card-add").first().click();

    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Added");
    await expect(toast).toHaveAttribute("data-variant", "success");

    // Assert it goes away too — success dismisses at ~3s (§4.2). No sleeps.
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
  });

  test("a manual close dismisses immediately", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("product-card-add").first().click();

    await expect(page.getByTestId("toast")).toBeVisible();
    await page.getByTestId("toast-close").click();
    await expect(page.getByTestId("toast")).toHaveCount(0);
  });

  test("hovering pauses the dismiss timer", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("product-card-add").first().click();

    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible();
    await toast.hover();

    // Well past the 3s success window; the hover must hold it open.
    await page.waitForTimeout(4_500);
    await expect(toast).toBeVisible();
  });

  test("quantity changes and removal toast, and Undo restores the item", async ({
    page,
    request,
  }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("cart-qty-increase").click();
    await expect(page.getByTestId("toast")).toContainText("Updated");
    await page.getByTestId("toast-close").click();

    await page.getByTestId("cart-item-remove").click();
    const removeToast = page.getByTestId("toast");
    await expect(removeToast).toContainText("Removed");
    await expect(page.getByText("Your cart is empty.")).toBeVisible();

    await page.getByTestId("toast-action").click();
    await expect(page.getByTestId("cart-line-item")).toHaveCount(1);
  });

  test("an accepted coupon toasts the amount saved", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie"); // 2400
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("coupon-input").fill("SAVE10");
    await page.getByTestId("coupon-apply").click();

    const toast = page.getByTestId("toast");
    await expect(toast).toHaveAttribute("data-variant", "success");
    await expect(toast).toContainText("Coupon SAVE10 applied — you saved $2.40");
  });

  test("a rejected coupon toasts the reason verbatim, as a warning", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie"); // below TAKE15's $50 min
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("coupon-input").fill("TAKE15");
    await page.getByTestId("coupon-apply").click();

    const toast = page.getByTestId("toast");
    await expect(toast).toHaveAttribute("data-variant", "warning");
    await expect(toast).toContainText("Coupon TAKE15 not applied: Minimum spend of $50.00 not met");
  });

  test("removing a coupon toasts", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 1);
    await applyCoupon(page, "SAVE10");
    await page.goto("/cart");

    await page.getByTestId("coupon-remove").click();
    await expect(page.getByTestId("toast")).toContainText("Coupon SAVE10 removed");
  });

  /**
   * specs/03 AC6 — the guarantee §5.6's prune design makes structural.
   *
   * A coupon dropped by a quantity change must produce NO coupon toast. The
   * quantity change itself legitimately toasts "Updated" per §4's table, so the
   * assertion is scoped to coupon toasts: nothing warning-variant, and nothing
   * naming the coupon.
   */
  test("a coupon pruned by a quantity change fires no coupon toast", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 3); // 7200 — TAKE15 qualifies
    await applyCoupon(page, "TAKE15");
    await page.goto("/cart");

    await expect(page.getByTestId("coupon-chip")).toHaveAttribute("data-code", "TAKE15");

    await page.getByTestId("cart-qty-decrease").click(); // 4800 — below the minimum
    await expect(page.getByTestId("cart-qty-input")).toHaveText("2");

    // The chip goes, the total updates...
    await expect(page.getByTestId("coupon-chip")).toHaveCount(0);
    await expect(page.getByTestId("coupon-error")).toHaveCount(0);
    // ...and the shopper is not warned about something they never attempted.
    await expect(page.locator('[data-testid="toast"][data-variant="warning"]')).toHaveCount(0);
    await expect(page.getByTestId("toast").filter({ hasText: "TAKE15" })).toHaveCount(0);
  });

  test("toast regions carry the right aria-live values", async ({ page, request }) => {
    await page.goto("/");

    await expect(page.getByTestId("toast-region-polite")).toHaveAttribute("aria-live", "polite");
    await expect(page.getByTestId("toast-region-assertive")).toHaveAttribute(
      "aria-live",
      "assertive",
    );

    // A warning lands in the assertive region, a success in the polite one.
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 1);
    await page.goto("/cart");
    await page.getByTestId("coupon-input").fill("TAKE15");
    await page.getByTestId("coupon-apply").click();

    await expect(
      page.getByTestId("toast-region-assertive").getByTestId("toast"),
    ).toHaveAttribute("data-variant", "warning");
  });
});
