import Link from "next/link";
import { formatCents } from "@/lib/money";
import { AddToCartButton } from "./AddToCartButton";

export interface ProductCardData {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  currency: string;
  category: string | null;
  imageUrl: string | null;
}

/** Shared by the catalog and (slice 3) the recommendation strips. */
export function ProductCard({
  product,
  testId = "product-card",
  addTestId = "product-card-add",
}: {
  product: ProductCardData;
  testId?: string;
  addTestId?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-product-id={product.id}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800"
    >
      <Link href={`/product/${product.slug}`} className="block">
        <div className="flex aspect-4/3 items-center justify-center bg-neutral-100 dark:bg-neutral-900">
          {product.imageUrl ? (
            // Plain <img>: uploads are served from a route handler, not the
            // Next image optimiser (specs/02 §8.2).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl}
              alt={product.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs uppercase tracking-widest text-neutral-400">No image</span>
          )}
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-4">
        {product.category && (
          <span className="w-fit rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {product.category}
          </span>
        )}
        <Link href={`/product/${product.slug}`} className="font-medium hover:underline">
          {product.name}
        </Link>
        <p className="tabular-nums text-sm text-neutral-600 dark:text-neutral-400">
          {formatCents(product.priceCents, product.currency)}
        </p>
        <div className="mt-auto pt-2">
          <AddToCartButton productId={product.id} testId={addTestId} className="w-full" />
        </div>
      </div>
    </div>
  );
}
