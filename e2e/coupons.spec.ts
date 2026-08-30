import { expect, test } from "@playwright/test";
import { addToCart, applyCoupon, productIdBySlug } from "./helpers";

/** specs/01 §12.2 — accepted, rejected, exclusive coupons, and pruning. */
test.describe("coupons", () => {
  test("an accepted coupon adds a discount line and drops the total", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie"); // 2400
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await expect(page.getByTestId("breakdown-total")).toHaveText("$31.91"); // 2400+599+192

    await page.getByTestId("coupon-input").fill("SAVE10");
    await page.getByTestId("coupon-apply").click();

    const discount = page.getByTestId("breakdown-discount");
    await expect(discount).toHaveCount(1);
    await expect(discount).toHaveAttribute("data-code", "SAVE10");
    await expect(discount).toHaveText("−$2.40");
    await expect(page.getByTestId("coupon-chip")).toHaveAttribute("data-code", "SAVE10");
    // 2400 - 240 + 599 + tax(8% of 2160 = 173) = 2932
    await expect(page.getByTestId("breakdown-total")).toHaveText("$29.32");
  });

  test("removing a coupon reverts the totals", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 1);
    await applyCoupon(page, "SAVE10");
    await page.goto("/cart");

    await expect(page.getByTestId("breakdown-total")).toHaveText("$29.32");
    await page.getByTestId("coupon-remove").click();

    await expect(page.getByTestId("coupon-chip")).toHaveCount(0);
    await expect(page.getByTestId("breakdown-discount")).toHaveCount(0);
    await expect(page.getByTestId("breakdown-total")).toHaveText("$31.91");
  });

  test("a coupon that fails eligibility is not applied and shows the reason", async ({
    page,
    request,
  }) => {
    const beanie = await productIdBySlug(request, "wool-beanie"); // 2400, below TAKE15's $50 min
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("coupon-input").fill("TAKE15");
    await page.getByTestId("coupon-apply").click();

    await expect(page.getByTestId("coupon-error")).toHaveText("Minimum spend of $50.00 not met");
    await expect(page.getByTestId("coupon-chip")).toHaveCount(0);
    await expect(page.getByTestId("breakdown-total")).toHaveText("$31.91");
  });

  test("an unknown code is rejected", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("coupon-input").fill("NOPE");
    await page.getByTestId("coupon-apply").click();

    await expect(page.getByTestId("coupon-error")).toContainText("not a valid code");
  });

  /**
   * Defect #3 through the UI. The exclusive coupon is worth LESS than the
   * stackable pair, so it must lose — the shopper is never punished for
   * entering a valid code.
   */
  test("an exclusive coupon loses when the stackable set is cheaper", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 3); // 7200
    await applyCoupon(page, "SAVE10");
    await applyCoupon(page, "TAKE15");
    await page.goto("/cart");

    await expect(page.getByTestId("breakdown-total")).toHaveText("$53.78");

    await page.getByTestId("coupon-input").fill("VIP25");
    await page.getByTestId("coupon-apply").click();

    await expect(page.getByTestId("coupon-error")).toHaveText(
      "Coupon VIP25 can't be combined with your other coupons, which give a better price",
    );
    await expect(page.getByTestId("coupon-chip")).toHaveCount(2);
    await expect(page.getByTestId("breakdown-total")).toHaveText("$53.78"); // NOT $58.32
  });

  test("an exclusive coupon that IS cheaper applies alone", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 3); // 7200
    await applyCoupon(page, "SAVE10");
    await page.goto("/cart");

    await page.getByTestId("coupon-input").fill("VIP25");
    await page.getByTestId("coupon-apply").click();

    // VIP25 gives 1800 vs SAVE10's 720, so it wins and evicts SAVE10.
    const chips = page.getByTestId("coupon-chip");
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveAttribute("data-code", "VIP25");
    await expect(page.getByTestId("breakdown-total")).toHaveText("$58.32");
  });

  test("a category coupon applies only to matching items", async ({ page, request }) => {
    const hub = await productIdBySlug(request, "nimbus-usbc-hub"); // 4599, Electronics
    const beanie = await productIdBySlug(request, "wool-beanie"); // 2400, Apparel
    await addToCart(page, hub, 1);
    await addToCart(page, beanie, 1);
    await page.goto("/cart");

    await page.getByTestId("coupon-input").fill("ELECTRO20");
    await page.getByTestId("coupon-apply").click();

    // 20% of 4599 = 920 (half-up), not 20% of the 6999 subtotal.
    await expect(page.getByTestId("breakdown-discount")).toHaveText("−$9.20");
  });

  /**
   * §5.6 pruning, and the guarantee slice 3 §4.1 depends on: a coupon dropped by
   * a quantity change produces NO rejection, so no toast can fire for it.
   */
  test("a coupon that stops qualifying is pruned silently", async ({ page, request }) => {
    const beanie = await productIdBySlug(request, "wool-beanie");
    await addToCart(page, beanie, 3); // 7200 — TAKE15 qualifies
    await applyCoupon(page, "TAKE15");
    await page.goto("/cart");

    await expect(page.getByTestId("coupon-chip")).toHaveAttribute("data-code", "TAKE15");

    await page.getByTestId("cart-qty-decrease").click(); // 4800 — below the $50 minimum
    await expect(page.getByTestId("cart-qty-input")).toHaveText("2");

    await expect(page.getByTestId("coupon-chip")).toHaveCount(0);
    await expect(page.getByTestId("coupon-error")).toHaveCount(0);
    await expect(page.getByTestId("breakdown-discount")).toHaveCount(0);
  });
});
