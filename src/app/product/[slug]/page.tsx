import Link from "next/link";
import { notFound } from "next/navigation";
import { QuantityAddToCart } from "@/components/QuantityAddToCart";
import { RecommendationStrip } from "@/components/RecommendationStrip";
import { prisma } from "@/lib/db";
import { formatCents } from "@/lib/money";

/** Product detail. specs/01 §8.2. Next 15: params is a Promise (§7.5). */
export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const product = await prisma.product.findUnique({ where: { slug } });
  if (!product || !product.active) notFound();

  return (
    <div className="space-y-8">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">
        ← Back to catalog
      </Link>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div className="flex aspect-4/3 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-900">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.imageUrl} alt={product.name} className="h-full w-full object-cover" />
          ) : (
            <span className="text-xs uppercase tracking-widest text-neutral-400">No image</span>
          )}
        </div>

        <div className="space-y-4">
          {product.category && (
            <span className="inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {product.category}
            </span>
          )}
          <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
          <p className="tabular-nums text-xl">{formatCents(product.priceCents, product.currency)}</p>
          {product.description && (
            <p className="text-neutral-600 dark:text-neutral-400">{product.description}</p>
          )}
          <QuantityAddToCart productId={product.id} productName={product.name} />
        </div>
      </div>

      <RecommendationStrip
        endpoint={`/api/products/${product.slug}/recommendations`}
        title="You might also like"
      />
    </div>
  );
}
