"use client";

import { useState } from "react";
import { mutateCart } from "./cart-events";

export function AddToCartButton({
  productId,
  quantity = 1,
  label = "Add to cart",
  testId = "product-card-add",
  className = "",
}: {
  productId: string;
  quantity?: number;
  label?: string;
  testId?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    await mutateCart("/api/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity }),
    });
    setBusy(false);
  }

  return (
    <button
      type="button"
      data-testid={testId}
      data-product-id={productId}
      onClick={add}
      disabled={busy}
      className={`rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 ${className}`}
    >
      {busy ? "Adding…" : label}
    </button>
  );
}
