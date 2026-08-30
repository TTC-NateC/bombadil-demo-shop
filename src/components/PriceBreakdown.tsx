"use client";

import { formatCents } from "@/lib/money";
import type { PricedCart } from "@/lib/pricing/types";
import { itemDiscountLines, shippingLabel } from "@/lib/pricing/view";

/**
 * specs/01 §8.3. Every figure is a field on PricedCart — there is not one
 * arithmetic operator in this component (§8.4).
 *
 * Styled as a TTC dark-blue section panel: ttcglobal.com sets emphasis blocks
 * on --dark-blue with egg-blue picking out the figures worth reading.
 */
export function PriceBreakdown({ priced }: { priced: PricedCart }) {
  return (
    <div className="rounded-2xl bg-ttc-dark-blue p-5 text-white">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-ttc-egg-blue">
        Order summary
      </h2>

      <dl className="space-y-2 text-sm text-ttc-navy-100">
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

        <div className="!mt-4 border-t border-white/20 pt-4 text-base text-white">
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
      <dt className={tone === "discount" ? "text-ttc-egg-blue" : ""}>{label}</dt>
      <dd
        data-testid={testId}
        data-code={dataCode}
        className={`whitespace-nowrap tabular-nums ${tone === "discount" ? "text-ttc-egg-blue" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}
