"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { mutateCart, notifyCartUpdated } from "@/components/cart-events";
import { PageBand } from "@/components/PageBand";
import { PriceBreakdown } from "@/components/PriceBreakdown";
import { RecommendationStrip } from "@/components/RecommendationStrip";
import { toast } from "@/components/Toaster";
import { formatCents } from "@/lib/money";
import type { PricedCart } from "@/lib/pricing/types";
import { appliedChips } from "@/lib/pricing/view";

interface ProductLite {
  id: string;
  slug: string;
  imageUrl: string | null;
}

/** Cart. specs/01 §8.3 — the important screen. */
export default function CartPage() {
  const [priced, setPriced] = useState<PricedCart | null>(null);
  const [products, setProducts] = useState<Record<string, ProductLite>>({});
  const [code, setCode] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/cart");
    if (response.ok) setPriced((await response.json()) as PricedCart);
  }, []);

  useEffect(() => {
    void load();
    void fetch("/api/products")
      .then((r) => r.json())
      .then((data: { products: ProductLite[] }) => {
        setProducts(Object.fromEntries(data.products.map((p) => [p.id, p])));
      })
      .catch(() => undefined);
  }, [load]);

  /** mutate -> receive PricedCart -> re-render (§8.4). The client never computes money. */
  async function run(
    path: string,
    init: RequestInit,
    options: { applyingCode?: string } = {},
  ): Promise<PricedCart | null> {
    setBusy(true);
    const { ok, data } = await mutateCart(path, init);
    setBusy(false);

    if (!ok) {
      toast({ variant: "warning", message: "Something went wrong — please try again" });
      return null;
    }

    const next = data as PricedCart;
    setPriced(next);
    notifyCartUpdated();

    if (options.applyingCode) {
      // rejectedCoupons means exactly one thing: THIS attempt failed (§5.6),
      // so it is only ever read here — never after a quantity change.
      const rejection = next.rejectedCoupons[0];
      setCouponError(rejection?.reason ?? null);

      if (rejection) {
        toast({
          variant: "warning",
          message: `Coupon ${rejection.couponCode} not applied: ${rejection.reason}`,
        });
      } else {
        setCode("");
        const line = next.discountLines.find((l) => l.couponCode === options.applyingCode);
        toast({
          variant: "success",
          message: line
            ? `Coupon ${line.couponCode} applied — you saved ${formatCents(line.amountCents, next.currency)}`
            : `Coupon ${options.applyingCode} applied`,
        });
      }
    }

    return next;
  }

  if (!priced)
    return (
      <PageBand>
        <p className="text-white/70">Loading cart…</p>
      </PageBand>
    );

  if (priced.items.length === 0) {
    return (
      <PageBand className="space-y-4 py-12 text-center">
        <p className="text-lg text-white">Your cart is empty.</p>
        <Link
          href="/"
          className="inline-block rounded-full bg-ttc-egg-blue px-6 py-3 font-medium text-ttc-dark-blue transition-colors hover:bg-white"
        >
          Browse the catalog
        </Link>
      </PageBand>
    );
  }

  const cartProductIds = priced.items.map((i) => i.productId).join(",");

  return (
    <PageBand className="space-y-10">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_20rem]">
        {/* ---- line items ---- */}
        <div className="space-y-4">
          {priced.items.map((item) => {
            const product = products[item.productId];
            return (
              <div
                key={item.productId}
                data-testid="cart-line-item"
                data-product-id={item.productId}
                className="flex items-center gap-4 rounded-xl border-2 border-white/20 bg-white/10 p-4 transition-colors hover:border-ttc-egg-blue"
              >
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-white/15">
                  {product?.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] uppercase text-white/60">No image</span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-white">{item.name}</p>
                  <p className="tabular-nums text-sm text-white/70">
                    {formatCents(item.unitPriceCents, priced.currency)} each
                  </p>
                </div>

                <div className="flex items-center rounded-full border-2 border-white/30">
                  <button
                    type="button"
                    data-testid="cart-qty-decrease"
                    aria-label={`Decrease quantity of ${item.name}`}
                    disabled={busy}
                    onClick={async () => {
                      const next = item.quantity - 1;
                      await run("/api/cart/items", {
                        method: "PATCH",
                        body: JSON.stringify({ productId: item.productId, quantity: next }),
                      });
                      toast({
                        variant: "info",
                        message:
                          next === 0
                            ? `Removed "${item.name}" from your cart`
                            : `Updated "${item.name}" (x${next})`,
                      });
                    }}
                    className="rounded-l-full px-3 py-1.5 text-sm text-white transition-colors hover:bg-white/15 hover:text-ttc-egg-blue disabled:opacity-40"
                  >
                    −
                  </button>
                  <span
                    data-testid="cart-qty-input"
                    className="w-8 text-center tabular-nums text-sm text-white"
                  >
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    data-testid="cart-qty-increase"
                    aria-label={`Increase quantity of ${item.name}`}
                    disabled={busy}
                    onClick={async () => {
                      const next = item.quantity + 1;
                      await run("/api/cart/items", {
                        method: "PATCH",
                        body: JSON.stringify({ productId: item.productId, quantity: next }),
                      });
                      toast({ variant: "info", message: `Updated "${item.name}" (x${next})` });
                    }}
                    className="rounded-r-full px-3 py-1.5 text-sm text-white transition-colors hover:bg-white/15 hover:text-ttc-egg-blue disabled:opacity-40"
                  >
                    +
                  </button>
                </div>

                <p className="w-20 text-right tabular-nums text-sm font-medium text-white">
                  {formatCents(item.lineTotalCents, priced.currency)}
                </p>

                <button
                  type="button"
                  data-testid="cart-item-remove"
                  aria-label={`Remove ${item.name}`}
                  disabled={busy}
                  onClick={async () => {
                    const restore = { productId: item.productId, quantity: item.quantity };
                    await run(
                      `/api/cart/items?productId=${encodeURIComponent(item.productId)}`,
                      { method: "DELETE" },
                    );
                    toast({
                      variant: "info",
                      message: `Removed "${item.name}" from your cart`,
                      action: {
                        label: "Undo",
                        run: async () => {
                          await run("/api/cart/items", {
                            method: "POST",
                            body: JSON.stringify(restore),
                          });
                        },
                      },
                    });
                  }}
                  className="text-sm text-white/70 underline underline-offset-2 transition-colors hover:text-ttc-egg-blue disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>

        {/* ---- coupons + breakdown ---- */}
        <div className="space-y-4">
          <div className="rounded-2xl border-2 border-white/20 bg-white/10 p-5">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-ttc-egg-blue">
              Coupon
            </h2>

            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const submitted = code.trim().toUpperCase();
                if (!submitted) return;
                void run(
                  "/api/cart/coupons",
                  { method: "POST", body: JSON.stringify({ code: submitted }) },
                  { applyingCode: submitted },
                );
              }}
            >
              <input
                data-testid="coupon-input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Enter a code"
                aria-label="Coupon code"
                className="min-w-0 flex-1 rounded-full border-2 border-white/30 bg-white/10 px-4 py-2 text-sm text-white placeholder:text-white/50 focus:border-ttc-egg-blue focus:outline-none"
              />
              <button
                type="submit"
                data-testid="coupon-apply"
                disabled={busy}
                className="shrink-0 rounded-full bg-ttc-egg-blue px-5 py-2 text-sm font-medium text-ttc-dark-blue transition-colors hover:bg-white disabled:opacity-50"
              >
                Apply
              </button>
            </form>

            {couponError && (
              <p data-testid="coupon-error" className="mt-2 text-sm text-ttc-red-300">
                {couponError}
              </p>
            )}

            {/* Chips come straight from discountLines — there is no separate
                applied-coupons field, and §5.6 means there needn't be. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {appliedChips(priced).map((line) => (
                <span
                  key={line.couponCode}
                  data-testid="coupon-chip"
                  data-code={line.couponCode}
                  className="inline-flex items-center gap-1.5 rounded-full bg-ttc-dark-blue px-3 py-1 text-xs font-medium text-white"
                >
                  {line.couponCode}
                  <button
                    type="button"
                    data-testid="coupon-remove"
                    aria-label={`Remove coupon ${line.couponCode}`}
                    disabled={busy}
                    onClick={async () => {
                      setCouponError(null);
                      await run(
                        `/api/cart/coupons?code=${encodeURIComponent(line.couponCode)}`,
                        { method: "DELETE" },
                      );
                      toast({ variant: "info", message: `Coupon ${line.couponCode} removed` });
                    }}
                    className="text-ttc-egg-blue hover:text-ttc-red-300 disabled:opacity-40"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>

          <PriceBreakdown priced={priced} />
        </div>
      </div>

      <RecommendationStrip
        endpoint={`/api/recommendations?productIds=${encodeURIComponent(cartProductIds)}`}
        title="Add to your order"
        refreshOnCartChange
      />
    </PageBand>
  );
}
