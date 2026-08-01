"use client";

import { useEffect, useState } from "react";
import type { ProductCardData } from "./ProductCard";
import { ProductCard } from "./ProductCard";
import { CART_UPDATED } from "./cart-events";

/**
 * One strip for both the PDP row and the cart's add-on strip (specs/03 §3),
 * differing only in its data source.
 */
export function RecommendationStrip({
  endpoint,
  title,
  refreshOnCartChange = false,
}: {
  endpoint: string | null;
  title: string;
  refreshOnCartChange?: boolean;
}) {
  const [products, setProducts] = useState<ProductCardData[]>([]);

  useEffect(() => {
    if (!endpoint) {
      setProducts([]);
      return;
    }

    let cancelled = false;
    const load = async () => {
      const response = await fetch(endpoint);
      if (!response.ok) return;
      const data = (await response.json()) as { products: ProductCardData[] };
      if (!cancelled) setProducts(data.products);
    };

    void load();
    if (refreshOnCartChange) {
      window.addEventListener(CART_UPDATED, load);
      return () => {
        cancelled = true;
        window.removeEventListener(CART_UPDATED, load);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [endpoint, refreshOnCartChange]);

  if (products.length === 0) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            testId="recommendation-card"
            addTestId="recommendation-add"
          />
        ))}
      </div>
    </section>
  );
}
