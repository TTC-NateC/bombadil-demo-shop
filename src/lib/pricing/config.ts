/**
 * Store configuration. specs/01 §6.
 *
 * Defaults live here and nowhere else. Agents must not hardcode tax or shipping
 * anywhere in the engine, API or UI.
 */
import type { StoreConfig } from "./types";

export const CONFIG_DEFAULTS: StoreConfig = {
  currency: "USD",
  taxRateBps: 800,
  taxOnShipping: false,
  shippingFlatCents: 599,
  freeShippingThresholdCents: 5000,
};

type Env = Record<string, string | undefined>;

function readInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

function readString(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

export function loadConfig(env: Env = process.env): StoreConfig {
  return {
    currency: readString(env, "STORE_CURRENCY", CONFIG_DEFAULTS.currency),
    taxRateBps: readInt(env, "TAX_RATE_BPS", CONFIG_DEFAULTS.taxRateBps),
    taxOnShipping: readBool(env, "TAX_ON_SHIPPING", CONFIG_DEFAULTS.taxOnShipping),
    shippingFlatCents: readInt(env, "SHIPPING_FLAT_CENTS", CONFIG_DEFAULTS.shippingFlatCents),
    freeShippingThresholdCents: readInt(
      env,
      "FREE_SHIPPING_THRESHOLD_CENTS",
      CONFIG_DEFAULTS.freeShippingThresholdCents,
    ),
  };
}
