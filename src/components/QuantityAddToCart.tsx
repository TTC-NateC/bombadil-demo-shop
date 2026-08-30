"use client";

import { useState } from "react";
import { AddToCartButton } from "./AddToCartButton";

export function QuantityAddToCart({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [quantity, setQuantity] = useState(1);

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center rounded-full border-2 border-white/30">
        <button
          type="button"
          aria-label="Decrease quantity"
          data-testid="pdp-qty-decrease"
          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          className="rounded-l-full px-3 py-2 text-sm text-white transition-colors hover:bg-white/15 hover:text-ttc-egg-blue"
        >
          −
        </button>
        <span data-testid="pdp-qty" className="w-8 text-center tabular-nums text-sm text-white">
          {quantity}
        </span>
        <button
          type="button"
          aria-label="Increase quantity"
          data-testid="pdp-qty-increase"
          onClick={() => setQuantity((q) => q + 1)}
          className="rounded-r-full px-3 py-2 text-sm text-white transition-colors hover:bg-white/15 hover:text-ttc-egg-blue"
        >
          +
        </button>
      </div>
      <AddToCartButton
        productId={productId}
        productName={productName}
        quantity={quantity}
        testId="pdp-add-to-cart"
      />
    </div>
  );
}
