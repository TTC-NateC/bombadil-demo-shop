"use client";

import { useState } from "react";
import { AddToCartButton } from "./AddToCartButton";

export function QuantityAddToCart({ productId }: { productId: string }) {
  const [quantity, setQuantity] = useState(1);

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center rounded-md border border-neutral-300 dark:border-neutral-700">
        <button
          type="button"
          aria-label="Decrease quantity"
          data-testid="pdp-qty-decrease"
          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          className="px-3 py-2 text-sm"
        >
          −
        </button>
        <span data-testid="pdp-qty" className="w-8 text-center tabular-nums text-sm">
          {quantity}
        </span>
        <button
          type="button"
          aria-label="Increase quantity"
          data-testid="pdp-qty-increase"
          onClick={() => setQuantity((q) => q + 1)}
          className="px-3 py-2 text-sm"
        >
          +
        </button>
      </div>
      <AddToCartButton productId={productId} quantity={quantity} testId="pdp-add-to-cart" />
    </div>
  );
}
