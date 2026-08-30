/**
 * Test data staging. specs/02 §9.
 *
 * Fills a RUNNING instance by driving the real admin API — so it exercises the
 * actual endpoints, including image upload. Uses only fetch; no direct database
 * access, so it works against local or a deployed container.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  generateCoupons,
  generateProducts,
  type CouponTemplate,
  type GeneratedCoupon,
  type GeneratedProduct,
  type Pools,
  type PriceConfig,
} from "../src/lib/staging/generate";
import { cyclingSampler, intBetween, makeRng, type Rng } from "../src/lib/staging/rng";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  baseUrl: string;
  adminKey: string;
  products: number;
  coupons: number;
  inputDir: string;
  seed: number;
  reset: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (...names: string[]): string | undefined => {
    for (const name of names) {
      const index = argv.indexOf(name);
      if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1];
    }
    return undefined;
  };
  const flag = (name: string) => argv.includes(name);
  const num = (value: string | undefined, fallback: number) =>
    value === undefined ? fallback : Number(value);

  return {
    baseUrl: (get("--base-url") ?? "http://localhost:3000").replace(/\/$/, ""),
    adminKey: get("--admin-key") ?? process.env.ADMIN_API_KEY ?? "",
    products: num(get("--products", "-p", "--num-products"), 40),
    coupons: num(get("--coupons", "-c", "--num-coupons"), 12),
    inputDir: get("--input-dir") ?? "./staging",
    seed: num(get("--seed"), 1),
    reset: flag("--reset"),
    dryRun: flag("--dry-run"),
  };
}

// ---------------------------------------------------------------------------
// Input pools — every file optional, with built-in fallbacks (§9.2)
// ---------------------------------------------------------------------------

const FALLBACK = {
  productNames: ["Mug", "Lamp", "Chair", "Notebook", "Bottle", "Satchel", "Planter", "Clock"],
  descriptions: ["Built to last.", "Quietly well made.", "A everyday staple."],
  categories: ["Home", "Office", "Outdoors", "Accessories"],
  adjectives: ["Matte", "Ceramic", "Brushed", "Linen", "Walnut"],
  priceConfig: { minCents: 1200, maxCents: 18000, roundTo: 99 } as PriceConfig,
};

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function loadPools(inputDir: string): Promise<Pools> {
  const at = (name: string) => path.join(inputDir, name);
  return {
    productNames: await readJsonFile(at("product-names.json"), FALLBACK.productNames),
    descriptions: await readJsonFile(at("descriptions.json"), FALLBACK.descriptions),
    categories: await readJsonFile(at("categories.json"), FALLBACK.categories),
    adjectives: await readJsonFile(at("adjectives.json"), FALLBACK.adjectives),
    couponTemplates: await readJsonFile<CouponTemplate[]>(at("coupons.json"), []),
    priceConfig: await readJsonFile(at("price-config.json"), FALLBACK.priceConfig),
  };
}

async function listImages(inputDir: string): Promise<string[]> {
  try {
    const dir = path.join(inputDir, "images");
    const entries = await readdir(dir);
    return entries
      .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

class Api {
  constructor(
    private baseUrl: string,
    private adminKey: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { "x-admin-key": this.adminKey, ...extra };
  }

  async json<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: this.headers(body ? { "content-type": "application/json" } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${method} ${route} -> ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async upload(file: string): Promise<string> {
    const form = new FormData();
    const bytes = await readFile(file);
    const type = file.endsWith(".png")
      ? "image/png"
      : file.endsWith(".webp")
        ? "image/webp"
        : file.endsWith(".gif")
          ? "image/gif"
          : "image/jpeg";
    form.append("image", new Blob([new Uint8Array(bytes)], { type }), path.basename(file));

    const response = await fetch(`${this.baseUrl}/api/uploads`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!response.ok) throw new Error(`upload ${file} -> ${response.status}`);
    return ((await response.json()) as { url: string }).url;
  }
}

// ---------------------------------------------------------------------------
// Payload building (shared by dry-run and live, so they cannot drift)
// ---------------------------------------------------------------------------

function productPayload(product: GeneratedProduct, imageUrl?: string) {
  return {
    slug: product.slug,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    category: product.category,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function couponPayload(coupon: GeneratedCoupon) {
  return {
    code: coupon.code,
    description: coupon.description,
    type: coupon.type,
    value: coupon.value,
    targetType: coupon.targetType,
    ...(coupon.targetValue ? { targetValue: coupon.targetValue } : {}),
    ...(coupon.minSubtotalCents ? { minSubtotalCents: coupon.minSubtotalCents } : {}),
    ...(coupon.maxDiscountCents ? { maxDiscountCents: coupon.maxDiscountCents } : {}),
    stackable: coupon.stackable,
    priority: coupon.priority,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rng: Rng = makeRng(options.seed);
  const pools = await loadPools(options.inputDir);
  const images = await listImages(options.inputDir);
  const api = new Api(options.baseUrl, options.adminKey);

  if (!options.dryRun && !options.adminKey) {
    console.error("FATAL: no admin key. Pass --admin-key or set ADMIN_API_KEY.");
    process.exit(1);
  }

  if (options.reset && !options.dryRun) {
    // Products cascade out of every cart (specs/01 §4.2) — without that this
    // fails the moment anyone has used the demo, i.e. exactly when you reset.
    const p = await api.json<{ deleted: number }>("DELETE", "/api/products?all=true");
    const c = await api.json<{ deleted: number }>("DELETE", "/api/coupons?all=true");
    console.log(`[reset] removed ${p.deleted} products, ${c.deleted} coupons`);
  }

  // Pre-fetch existing slugs so append mode (no --reset) does not collide on
  // `slug @unique` for most rows (§9.3 step 2).
  let existingSlugs: string[] = [];
  let existingCodes: string[] = [];
  if (!options.dryRun) {
    const { products } = await api.json<{ products: { slug: string }[] }>(
      "GET",
      "/api/products?all=true",
    );
    existingSlugs = products.map((p) => p.slug);
    const { coupons } = await api.json<{ coupons: { code: string }[] }>("GET", "/api/coupons");
    existingCodes = coupons.map((c) => c.code);
  }

  // --- products ------------------------------------------------------------
  const generated = generateProducts(rng, pools, options.products, existingSlugs);
  const nextImage = cyclingSampler(rng, images);
  const created: { id: string; category: string }[] = [];
  let productsSkipped = 0;

  for (const product of generated) {
    try {
      if (options.dryRun) {
        console.log(JSON.stringify(productPayload(product, images.length ? "/uploads/sample" : undefined)));
        created.push({ id: `dry-${product.slug}`, category: product.category });
        continue;
      }

      // Upload first, then reference the returned url — keeps the bulk endpoint
      // pure JSON (§8.3).
      const image = nextImage();
      const imageUrl = image ? await api.upload(image) : undefined;

      const { product: row } = await api.json<{ product: { id: string } }>(
        "POST",
        "/api/products",
        productPayload(product, imageUrl),
      );
      created.push({ id: row.id, category: product.category });
    } catch (error) {
      productsSkipped++;
      console.error(`[skip product] ${product.slug}: ${(error as Error).message}`);
    }
  }

  // --- relatedIds, after every product exists (§9.3 step 8) ----------------
  if (!options.dryRun && created.length > 3) {
    const byCategory = new Map<string, string[]>();
    for (const item of created) {
      byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item.id]);
    }
    for (const item of created) {
      if (rng() > 0.3) continue;
      const peers = (byCategory.get(item.category) ?? []).filter((id) => id !== item.id);
      if (peers.length < 2) continue;
      const relatedIds = peers.slice(0, intBetween(rng, 2, Math.min(4, peers.length)));
      await api
        .json("PATCH", `/api/products/${item.id}`, { relatedIds })
        .catch(() => console.error(`[skip relatedIds] ${item.id}`));
    }
  }

  // --- coupons -------------------------------------------------------------
  const categories = options.dryRun
    ? pools.categories
    : Array.from(new Set(created.map((c) => c.category)));

  const generatedCoupons = generateCoupons(
    rng,
    pools.couponTemplates,
    options.coupons,
    categories.length ? categories : pools.categories,
    existingCodes,
  );

  let couponsCreated = 0;
  let couponsSkipped = options.coupons - generatedCoupons.length;
  for (const coupon of generatedCoupons) {
    try {
      if (options.dryRun) {
        console.log(JSON.stringify(couponPayload(coupon)));
      } else {
        await api.json("POST", "/api/coupons", couponPayload(coupon));
      }
      couponsCreated++;
    } catch (error) {
      couponsSkipped++;
      console.error(`[skip coupon] ${coupon.code}: ${(error as Error).message}`);
    }
  }

  console.log(
    `created: ${created.length} products, ${couponsCreated} coupons; ` +
      `skipped: ${productsSkipped + couponsSkipped}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
