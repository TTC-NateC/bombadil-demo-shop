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

/**
 * Shared by the catalog and (slice 3) the recommendation strips. Every surface
 * that renders it now sits on the TTC teal band, so the card is translucent
 * white over teal rather than an opaque tile.
 */
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
      className="flex flex-col overflow-hidden rounded-xl border-2 border-white/20 bg-white/10 transition-colors hover:border-ttc-egg-blue"
    >
      <Link href={`/product/${product.slug}`} className="block">
        <div className="flex aspect-4/3 items-center justify-center bg-white/10">
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
            <span className="text-xs uppercase tracking-widest text-white/50">No image</span>
          )}
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-4">
        {product.category && (
          <span className="w-fit rounded-full bg-ttc-dark-blue px-2.5 py-0.5 text-xs text-white">
            {product.category}
          </span>
        )}
        <Link
          href={`/product/${product.slug}`}
          className="font-medium text-white hover:text-ttc-egg-blue hover:underline"
        >
          {product.name}
        </Link>
        <p className="tabular-nums text-sm text-white/70">
          {formatCents(product.priceCents, product.currency)}
        </p>
        <div className="mt-auto pt-2">
          <AddToCartButton
            productId={product.id}
            productName={product.name}
            testId={addTestId}
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
}
