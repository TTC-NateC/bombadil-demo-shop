/**
 * Baseline catalog and coupons. specs/01 §9.
 *
 * Exported as plain data so Playwright's globalSetup can reuse them rather than
 * redefining the catalog (Phase 6).
 */

export interface ProductFixture {
  slug: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  /**
   * Curated "goes well with" picks, expressed as slugs. The seed resolves these
   * to real ids in a second pass — the ids don't exist until the products do.
   */
  relatedSlugs?: string[];
}

export interface CouponFixture {
  code: string;
  description: string;
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  value: number;
  targetType: "CART" | "CATEGORY" | "PRODUCT";
  targetValue?: string;
  minSubtotalCents?: number;
  maxDiscountCents?: number;
  stackable: boolean;
  priority: number;
}

export const PRODUCT_FIXTURES: ProductFixture[] = [
  // --- Electronics -----------------------------------------------------------
  {
    slug: "aurora-wireless-headphones",
    name: "Aurora Wireless Headphones",
    description: "Over-ear, 40-hour battery, active noise cancellation.",
    priceCents: 24999,
    category: "Electronics",
    relatedSlugs: ["pulse-bluetooth-speaker", "halo-webcam", "nimbus-usbc-hub"],
  },
  {
    slug: "pulse-bluetooth-speaker",
    name: "Pulse Bluetooth Speaker",
    description: "Pocket-sized, water resistant, twelve hours of playback.",
    priceCents: 8999,
    category: "Electronics",
  },
  {
    slug: "nimbus-usbc-hub",
    name: "Nimbus USB-C Hub",
    description: "Seven ports, 100W pass-through charging, aluminium body.",
    priceCents: 4599,
    category: "Electronics",
  },
  {
    slug: "vertex-mechanical-keyboard",
    name: "Vertex Mechanical Keyboard",
    description: "Hot-swappable switches, compact 65% layout.",
    priceCents: 12999,
    category: "Electronics",
  },
  {
    slug: "halo-webcam",
    name: "Halo 1440p Webcam",
    description: "Sharp glass optics with a physical privacy shutter.",
    priceCents: 7999,
    category: "Electronics",
  },

  // --- Apparel ---------------------------------------------------------------
  {
    slug: "merino-crew-sweater",
    name: "Merino Crew Sweater",
    description: "Fine-gauge merino that holds its shape season after season.",
    priceCents: 8900,
    category: "Apparel",
    relatedSlugs: ["wool-beanie", "canvas-jacket"],
  },
  {
    slug: "oxford-shirt",
    name: "Everyday Oxford Shirt",
    description: "Washed cotton oxford with a soft, unstructured collar.",
    priceCents: 5900,
    category: "Apparel",
  },
  {
    slug: "canvas-jacket",
    name: "Waxed Canvas Jacket",
    description: "Weatherproof waxed cotton with a corduroy collar.",
    priceCents: 14900,
    category: "Apparel",
  },
  {
    slug: "wool-beanie",
    name: "Ribbed Wool Beanie",
    description: "Lambswool, double-turned brim.",
    priceCents: 2400,
    category: "Apparel",
  },

  // --- Home ------------------------------------------------------------------
  {
    slug: "lumen-desk-lamp",
    name: "Lumen Desk Lamp",
    description: "Stepless dimming from warm to daylight, matte steel arm.",
    priceCents: 6499,
    category: "Home",
    relatedSlugs: ["ceramic-pour-over", "cedar-candle", "linen-throw"],
  },
  {
    slug: "ceramic-pour-over",
    name: "Ceramic Pour-Over Set",
    description: "Stoneware cone and carafe, glazed by hand.",
    priceCents: 3499,
    category: "Home",
  },
  {
    slug: "linen-throw",
    name: "Stonewashed Linen Throw",
    description: "Heavyweight European linen, softens with every wash.",
    priceCents: 5900,
    category: "Home",
  },
  {
    slug: "cedar-candle",
    name: "Cedar & Smoke Candle",
    description: "Soy wax, cotton wick, fifty hours of burn time.",
    priceCents: 2800,
    category: "Home",
  },

  // --- Accessories -----------------------------------------------------------
  {
    slug: "everyday-backpack",
    name: "Everyday Backpack",
    description: "Twenty litres, padded laptop sleeve, water-resistant shell.",
    priceCents: 9900,
    category: "Accessories",
    relatedSlugs: ["canvas-tote", "leather-card-holder"],
  },
  {
    slug: "canvas-tote",
    name: "Heavy Canvas Tote",
    description: "Sixteen-ounce cotton canvas with reinforced straps.",
    priceCents: 3200,
    category: "Accessories",
  },
  {
    slug: "leather-card-holder",
    name: "Leather Card Holder",
    description: "Vegetable-tanned leather, four pockets, no stitching.",
    priceCents: 4500,
    category: "Accessories",
  },
];

/**
 * One coupon per pricing-engine code path, so the demo always exercises the
 * whole engine. Referenced by name in specs/01 §5.7's worked examples and by
 * every acceptance criterion that mentions a code.
 */
export const COUPON_FIXTURES: CouponFixture[] = [
  {
    code: "SAVE10",
    description: "10% off your order",
    type: "PERCENT",
    value: 1000,
    targetType: "CART",
    stackable: true,
    priority: 100,
  },
  {
    code: "TAKE15",
    description: "$15 off orders over $50",
    type: "FIXED",
    value: 1500,
    targetType: "CART",
    minSubtotalCents: 5000,
    stackable: true,
    priority: 100,
  },
  {
    code: "FREESHIP",
    description: "Free shipping",
    type: "FREE_SHIPPING",
    value: 0,
    targetType: "CART",
    stackable: true,
    priority: 100,
  },
  {
    code: "VIP25",
    description: "VIP 25% off, up to $30 — cannot be combined",
    type: "PERCENT",
    value: 2500,
    targetType: "CART",
    maxDiscountCents: 3000,
    stackable: false,
    priority: 50,
  },
  {
    code: "ELECTRO20",
    description: "20% off Electronics",
    type: "PERCENT",
    value: 2000,
    targetType: "CATEGORY",
    targetValue: "Electronics",
    stackable: true,
    priority: 100,
  },
];
