"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PricedCart } from "@/lib/pricing/types";
import { itemCount } from "@/lib/pricing/view";
import { CART_UPDATED } from "./cart-events";

export function CartBadge() {
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/cart");
    if (!response.ok) return;
    const priced = (await response.json()) as PricedCart;
    setCount(itemCount(priced));
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener(CART_UPDATED, refresh);
    return () => window.removeEventListener(CART_UPDATED, refresh);
  }, [refresh]);

  return (
    <Link
      href="/cart"
      data-testid="cart-badge"
      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
    >
      Cart ({count})
    </Link>
  );
}
