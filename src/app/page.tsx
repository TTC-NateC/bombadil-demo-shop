import { PageBand } from "@/components/PageBand";
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
    <PageBand className="space-y-6">
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
    </PageBand>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <a
      href={href}
      className={`rounded-full border-2 px-4 py-1.5 text-sm transition-colors ${
        active
          ? "border-ttc-egg-blue bg-ttc-egg-blue font-medium text-ttc-dark-blue"
          : "border-white/30 text-white hover:border-ttc-egg-blue hover:text-ttc-egg-blue"
      }`}
    >
      {label}
    </a>
  );
}
