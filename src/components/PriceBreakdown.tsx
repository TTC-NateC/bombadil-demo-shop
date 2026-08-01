"use client";

import { formatCents } from "@/lib/money";
import type { PricedCart } from "@/lib/pricing/types";
import { itemDiscountLines, shippingLabel } from "@/lib/pricing/view";

/**
 * specs/01 §8.3. Every figure is a field on PricedCart — there is not one
 * arithmetic operator in this component (§8.4).
 */
export function PriceBreakdown({ priced }: { priced: PricedCart }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Order summary
      </h2>

      <dl className="space-y-2 text-sm">
        <Row label="Subtotal" testId="breakdown-subtotal">
          {formatCents(priced.subtotalCents, priced.currency)}
        </Row>

        {itemDiscountLines(priced).map((line) => (
          <Row
            key={line.couponCode}
            label={`Coupon ${line.couponCode}${line.description ? ` (${line.description})` : ""}`}
            testId="breakdown-discount"
            dataCode={line.couponCode}
            tone="discount"
          >
            −{formatCents(line.amountCents, priced.currency)}
          </Row>
        ))}

        {/* Free shipping renders as FREE with the coupon attributed — never as a
            negative row, so the coupon and threshold paths look identical. */}
        <Row label="Shipping" testId="breakdown-shipping">
          {shippingLabel(priced)}
        </Row>

        <Row label="Tax" testId="breakdown-tax">
          {formatCents(priced.taxCents, priced.currency)}
        </Row>

        <div className="!mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <Row label="Total" testId="breakdown-total" bold>
            {formatCents(priced.totalCents, priced.currency)}
          </Row>
        </div>
      </dl>
    </div>
  );
}

function Row({
  label,
  testId,
  dataCode,
  children,
  tone,
  bold,
}: {
  label: string;
  testId: string;
  dataCode?: string;
  children: React.ReactNode;
  tone?: "discount";
  bold?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${bold ? "font-semibold" : ""}`}>
      <dt className={tone === "discount" ? "text-emerald-700 dark:text-emerald-400" : ""}>
        {label}
      </dt>
      <dd
        data-testid={testId}
        data-code={dataCode}
        className={`tabular-nums ${tone === "discount" ? "text-emerald-700 dark:text-emerald-400" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}
