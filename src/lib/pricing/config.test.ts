import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, loadConfig } from "./config";

describe("loadConfig", () => {
  it("returns every §6 default from a clean env", () => {
    expect(loadConfig({})).toEqual({
      currency: "USD",
      taxRateBps: 800,
      taxOnShipping: false,
      shippingFlatCents: 599,
      freeShippingThresholdCents: 5000,
    });
  });

  it("overrides only the field that is set", () => {
    const config = loadConfig({ TAX_RATE_BPS: "1000" });
    expect(config.taxRateBps).toBe(1000);
    expect(config.shippingFlatCents).toBe(CONFIG_DEFAULTS.shippingFlatCents);
    expect(config.currency).toBe(CONFIG_DEFAULTS.currency);
  });

  it("reads every documented variable", () => {
    expect(
      loadConfig({
        STORE_CURRENCY: "EUR",
        TAX_RATE_BPS: "2000",
        TAX_ON_SHIPPING: "true",
        SHIPPING_FLAT_CENTS: "1000",
        FREE_SHIPPING_THRESHOLD_CENTS: "9999",
      }),
    ).toEqual({
      currency: "EUR",
      taxRateBps: 2000,
      taxOnShipping: true,
      shippingFlatCents: 1000,
      freeShippingThresholdCents: 9999,
    });
  });

  it("falls back rather than producing NaN on garbage", () => {
    const config = loadConfig({ TAX_RATE_BPS: "not-a-number" });
    expect(config.taxRateBps).toBe(CONFIG_DEFAULTS.taxRateBps);
  });

  it("treats an empty string as unset", () => {
    expect(loadConfig({ STORE_CURRENCY: "" }).currency).toBe("USD");
    expect(loadConfig({ SHIPPING_FLAT_CENTS: "  " }).shippingFlatCents).toBe(599);
  });

  it("treats any value other than 'true' as false for booleans", () => {
    expect(loadConfig({ TAX_ON_SHIPPING: "1" }).taxOnShipping).toBe(false);
    expect(loadConfig({ TAX_ON_SHIPPING: "TRUE" }).taxOnShipping).toBe(true);
  });
});
