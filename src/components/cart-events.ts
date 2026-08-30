"use client";

/**
 * A single browser event so the header badge can refresh after any mutation
 * without threading state through every page.
 */
export const CART_UPDATED = "cart:updated";

export function notifyCartUpdated() {
  window.dispatchEvent(new CustomEvent(CART_UPDATED));
}

/** Every mutation goes through here: mutate -> receive PricedCart -> re-render (§8.4). */
export async function mutateCart(
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; data: unknown }> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const data = await response.json().catch(() => null);
  if (response.ok) notifyCartUpdated();
  return { ok: response.ok, data };
}
