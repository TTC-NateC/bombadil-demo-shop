"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/lib/money";
import type { PricedCart } from "@/lib/pricing/types";
import { itemCount } from "@/lib/pricing/view";
import { CART_UPDATED } from "./cart-events";

/**
 * Header cart summary — item count plus the running item subtotal (§8.1).
 * Lives in the root layout, so it is on every page.
 *
 * The subtotal is `PricedCart.subtotalCents` verbatim: the same figure the
 * cart's `breakdown-subtotal` row shows, so the two can never disagree. It is
 * pre-discount and pre-tax by design — the header does not restate the order
 * total (§8.4: the client never recomputes money).
 */
export function CartBadge() {
  const [count, setCount] = useState(0);
  const [subtotal, setSubtotal] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/cart");
    if (!response.ok) return;
    const priced = (await response.json()) as PricedCart;
    setCount(itemCount(priced));
    setSubtotal(formatCents(priced.subtotalCents, priced.currency));
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(CART_UPDATED, refresh);
    return () => window.removeEventListener(CART_UPDATED, refresh);
  }, [refresh]);

  return (
    <Link
      href="/cart"
      className="flex items-baseline gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
    >
      <span data-testid="cart-badge">Cart ({count})</span>
      {subtotal !== null && (
        <span
          data-testid="cart-badge-subtotal"
          className="tabular-nums text-neutral-600 dark:text-neutral-400"
        >
          {subtotal}
        </span>
      )}
    </Link>
  );
}
