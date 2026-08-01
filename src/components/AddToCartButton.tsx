"use client";

import { useState } from "react";
import { mutateCart } from "./cart-events";
import { toast } from "./Toaster";

export function AddToCartButton({
  productId,
  productName,
  quantity = 1,
  label = "Add to cart",
  testId = "product-card-add",
  className = "",
}: {
  productId: string;
  productName: string;
  quantity?: number;
  label?: string;
  testId?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    const { ok } = await mutateCart("/api/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity }),
    });

    // Fired on the OUTCOME, after the API responds — never on the click, or it
    // would lie whenever the server disagreed (specs/03 §4).
    toast(
      ok
        ? {
            variant: "success",
            message:
              quantity > 1
                ? `Added ${quantity} × "${productName}" to your cart`
                : `Added "${productName}" to your cart`,
          }
        : { variant: "warning", message: "Something went wrong — please try again" },
    );

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
