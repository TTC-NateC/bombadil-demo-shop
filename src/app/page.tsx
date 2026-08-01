import { ProductCard } from "@/components/ProductCard";
import { prisma } from "@/lib/db";

/** Catalog. specs/01 §8.1. Next 15: searchParams is a Promise (§7.5). */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;

  const [products, all] = await Promise.all([
    prisma.product.findMany({
      where: { active: true, ...(category ? { category } : {}) },
      orderBy: { createdAt: "asc" },
    }),
    prisma.product.findMany({ where: { active: true }, select: { category: true } }),
  ]);

  const categories = Array.from(
    new Set(all.map((p) => p.category).filter((c): c is string => Boolean(c))),
  ).sort();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip href="/" active={!category} label="All" />
        {categories.map((name) => (
          <FilterChip
            key={name}
            href={`/?category=${encodeURIComponent(name)}`}
            active={category === name}
            label={name}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <a
      href={href}
      className={`rounded-full border px-3 py-1 text-sm transition ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
          : "border-neutral-300 hover:border-neutral-500 dark:border-neutral-700"
      }`}
    >
      {label}
    </a>
  );
}
