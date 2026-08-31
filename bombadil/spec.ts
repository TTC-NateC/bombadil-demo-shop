/**
 * Bombadil specification — property-based testing for the shop UI.
 *
 * Bombadil drives the browser itself and checks these properties against every
 * state it captures. Unlike the Playwright suite in e2e/, nothing here scripts a
 * scenario: the properties must hold no matter what the shopper does.
 *
 * Run it against a server you have already started (see README):
 *
 *   bombadil browser test http://localhost:3000 bombadil/spec.ts \
 *     --header x-admin-key=$ADMIN_API_KEY --time-limit 5m
 */

import { always, eventually, next, now } from "@antithesishq/bombadil";
import {
  actions,
  extract,
  getFingerprint,
  weighted,
  type ActionTemplate,
  type Fingerprint,
  type State,
} from "@antithesishq/bombadil/browser";
import {
  clicks as clickAnything,
  navigation,
  scroll,
  waitOnce,
} from "@antithesishq/bombadil/browser/defaults/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ClickTarget = { fingerprint: Fingerprint; point: { x: number; y: number } };

/** Clickable points for `selector`, skipping disabled, hidden and off-screen elements. */
function clickTargets(state: State, selector: string): ClickTarget[] {
  return Array.from(state.document.querySelectorAll(selector))
    .filter((element) => !element.matches(":disabled"))
    .flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return [];

      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const onScreen =
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= state.window.innerWidth &&
        point.y <= state.window.innerHeight;
      if (!onScreen) return [];

      return [{ fingerprint: getFingerprint(element), point }];
    });
}

/** Click actions for the given targets. */
function clicks(targets: ClickTarget[]): ActionTemplate[] {
  return targets.map((target) => ({ Click: target }));
}

/** Escape a literal for use as a `Regexp` string generator. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/** Type one exact string into whatever is focused. A `Regexp` of a literal matches only itself. */
function typeText(text: string): ActionTemplate[] {
  return [{ TypeText: { text: { Regexp: escapeRegExp(text) }, delayMillis: 10 } }];
}

/** Parse a rendered money figure, or null when the text is not money ("FREE", empty). */
function parseMoney(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Parentheses count only when they wrap the whole figure — "FREE (SAVE10)"
  // also ends in ")" and must not read as negative ten.
  const negative = /^[-−]/.test(trimmed) || /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[^0-9.]/g, "");
  if (digits.length === 0) return null;

  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Where fetched coupon codes are parked on `window`, per page load. */
const COUPON_CACHE = "__bombadilValidCoupons";

/** One element at random, or null when there are none. */
function randomOf(values: string[]): string | null {
  return values.length === 0
    ? null
    : (values[Math.floor(Math.random() * values.length)] ?? null);
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/** Catalog "Add to cart" buttons (the grid only — the product page and strip use other ids). */
const catalogAddButtons = extract((state) =>
  clickTargets(state, "[data-testid='product-card-add']"),
);

/** Per-line "Remove" buttons on /cart. */
const cartRemoveButtons = extract((state) =>
  clickTargets(state, "[data-testid='cart-item-remove']"),
);

/** How many lines the cart is showing. */
const cartLineCount = extract(
  (state) => state.document.querySelectorAll("[data-testid='cart-line-item']").length,
);

/** A point with nothing interactive under it, for the idle drag to land on. */
const idlePoint = extract((state) => {
  const width = state.window.innerWidth;
  const height = state.window.innerHeight;
  // Left and top edges only: toasts stack bottom-right and pause on hover.
  const candidates: [number, number][] = [
    [4, Math.round(height / 2)],
    [4, 4],
    [Math.round(width / 2), 4],
    [4, height - 4],
  ];

  for (const [x, y] of candidates) {
    const element = state.document.elementFromPoint(x, y);
    if (element === null) return { x, y };
    if (
      element.closest(
        "a, button, input, select, textarea, label, [role='button'], [data-testid='toast']",
      ) === null
    ) {
      return { x, y };
    }
  }

  return null;
});

/**
 * The real coupon codes, plus as many made-up ones confirmed not to be among them,
 * and one of each drawn at random for the typing generators to use.
 *
 * Needs `--header x-admin-key=<key>`; without it the fetch 401s and both lists
 * stay empty, which silences the coupon generators.
 */
const couponPool = extract((state) => {
  const scope = state.window as unknown as Record<string, string[] | undefined>;

  if (scope[COUPON_CACHE] === undefined) {
    scope[COUPON_CACHE] = [];
    void fetch("/api/coupons")
      .then((response) => (response.ok ? response.json() : { coupons: [] }))
      .then((body) => {
        const coupons: { code?: unknown }[] = body?.coupons ?? [];
        scope[COUPON_CACHE] = coupons
          .map((coupon) => String(coupon.code ?? "").toUpperCase())
          .filter((code) => code.length > 0);
      })
      .catch(() => {
        scope[COUPON_CACHE] = [];
      });
  }

  const valid = scope[COUPON_CACHE] ?? [];
  if (valid.length === 0) {
    return { valid, invalid: [], randomValid: null, randomInvalid: null };
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const invalid: string[] = [];

  for (let attempt = 0; attempt < 40 && invalid.length < valid.length; attempt++) {
    const length = 6 + Math.floor(Math.random() * 7);
    let candidate = "";
    for (let i = 0; i < length; i++) {
      candidate += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!valid.includes(candidate) && !invalid.includes(candidate)) {
      invalid.push(candidate);
    }
  }

  return {
    valid,
    invalid,
    randomValid: randomOf(valid),
    randomInvalid: randomOf(invalid),
  };
});

/** The coupon box, as a click target. */
const couponInputTargets = extract((state) =>
  clickTargets(state, "[data-testid='coupon-input']"),
);

/** The Apply button, as a click target. */
const couponApplyTargets = extract((state) =>
  clickTargets(state, "[data-testid='coupon-apply']"),
);

/** Coupon box state: focus, its value normalised as the shop normalises it, and whether an error is showing. */
const couponInput = extract((state) => {
  const input = state.document.querySelector("[data-testid='coupon-input']");
  if (input === null) return null;
  return {
    focused: state.document.activeElement === input,
    value: (input as HTMLInputElement).value.trim().toUpperCase(),
    errorShown:
      state.document.querySelector("[data-testid='coupon-error']") !== null,
  };
});

/** Quantity per product on /cart, tagged with the navigation entry it was read in. */
const cartQuantities = extract((state) => {
  const quantities: Record<string, number> = {};

  for (const line of Array.from(
    state.document.querySelectorAll("[data-testid='cart-line-item']"),
  )) {
    const productId = line.getAttribute("data-product-id");
    const quantity = Number(
      line.querySelector("[data-testid='cart-qty-input']")?.textContent?.trim(),
    );
    if (productId !== null && Number.isInteger(quantity)) {
      quantities[productId] = quantity;
    }
  }

  return { nav: state.navigationHistory.current.id, quantities };
});

/** Coupon codes the cart currently shows as applied. */
const appliedCouponCodes = extract((state) =>
  Array.from(state.document.querySelectorAll("[data-testid='coupon-chip']"))
    .map((chip) => chip.getAttribute("data-code") ?? "")
    .filter((code) => code.length > 0),
);

/**
 * The oldest un-hovered toast waiting to dismiss, or null.
 *
 * Hovered toasts are excluded because hover pauses the timer by design.
 * Qualified by navigation entry because toast ids restart on every page load.
 */
const pendingToastId = extract((state) => {
  const ids = Array.from(state.document.querySelectorAll("[data-testid='toast']"))
    .filter((toast) => !toast.matches(":hover"))
    .map((toast) => toast.getAttribute("data-toast-id"))
    .filter((id): id is string => id !== null)
    .map(Number)
    .filter((id) => Number.isInteger(id));

  if (ids.length === 0) return null;
  return `${state.navigationHistory.current.id}:${Math.min(...ids)}`;
});

/** Toasts rendered without a `data-toast-id`. */
const toastsMissingAnId = extract(
  (state) =>
    state.document.querySelectorAll("[data-testid='toast']:not([data-toast-id])")
      .length,
);

/**
 * Every money figure on screen. `cartBadgeSubtotal` is in the root layout so it
 * appears on all pages; the rest only exist on /cart.
 *
 * Discount rows are excluded — they render a deliberate `−` prefix.
 */
const cartMoney = extract((state) => {
  const read = (testId: string) => {
    const element = state.document.querySelector(`[data-testid='${testId}']`);
    return element === null ? null : parseMoney(element.textContent ?? "");
  };

  // "FREE" / "FREE (CODE)" is the absence of a charge, and the code may hold digits.
  const shippingText =
    state.document.querySelector("[data-testid='breakdown-shipping']")?.textContent?.trim() ??
    "";

  return {
    cartBadgeSubtotal: read("cart-badge-subtotal"),
    total: read("breakdown-total"),
    subtotal: read("breakdown-subtotal"),
    tax: read("breakdown-tax"),
    shipping: shippingText.startsWith("FREE") ? null : parseMoney(shippingText),
  };
});

/** Live DOM node count. */
const domNodes = extract((state) => state.resources.dom_nodes);

/** Live JS event listener count. */
const eventListeners = extract((state) => state.resources.js_event_listeners);

// ---------------------------------------------------------------------------
// Action generators
// ---------------------------------------------------------------------------

/** Six seconds, as six drag steps of a second each. */
const IDLE_STEPS = 6;
const IDLE_STEP_MILLIS = 1000;

/** Add a catalog item to the cart. */
const addToCart = actions(() => clicks(catalogAddButtons.current));

/** Remove any one cart line. */
const removeCartItem = actions(() => clicks(cartRemoveButtons.current));

/** Remove the first line, so repeated picks drain the cart to empty. */
const emptyCart = actions(() =>
  cartLineCount.current > 0 ? clicks(cartRemoveButtons.current.slice(0, 1)) : [],
);

/**
 * Do nothing for six seconds.
 *
 * A drag with matching `from` and `to` never moves the pointer; `Wait` has no
 * duration, so this is the only inert action that can be given one.
 *
 * Two skips, both to stop six seconds being spent where they cost something:
 * while a toast is pending, because no state is captured mid-action and the
 * dismiss window would pass unobserved; and while the coupon box is on screen,
 * because the coupon flow needs several turns in a row and idling through them
 * starves it.
 */
const doNothingForSixSeconds = actions((): ActionTemplate[] => {
  const point = idlePoint.current;
  if (point === null) return [];
  if (pendingToastId.current !== null) return [];
  if (couponInput.current !== null) return [];

  return [
    {
      MouseDrag: {
        from: point,
        to: point,
        steps: IDLE_STEPS,
        delayMillis: IDLE_STEP_MILLIS,
      },
    },
  ];
});

/** Focus the coupon box. */
const focusCouponInput = actions(() =>
  couponInput.current !== null && !couponInput.current.focused
    ? clicks(couponInputTargets.current)
    : [],
);

/**
 * Type a randomly chosen real coupon code into an empty, focused box.
 *
 * One alternative, not one per code: offering the whole list made Bombadil
 * enumerate it for coverage — a run typed exactly four of each of the five
 * codes — which is systematic rather than random. `typeInvalidCoupon` offers
 * one too, so the branches stay the same size and the weights below keep
 * meaning what they say.
 */
const typeValidCoupon = actions(() => {
  const code = couponPool.current.randomValid;
  return couponInput.current?.focused && couponInput.current.value === "" && code !== null
    ? typeText(code)
    : [];
});

/** Type a randomly chosen made-up coupon code into an empty, focused box. */
const typeInvalidCoupon = actions(() => {
  const code = couponPool.current.randomInvalid;
  return couponInput.current?.focused && couponInput.current.value === "" && code !== null
    ? typeText(code)
    : [];
});

/**
 * Submit the coupon box.
 *
 * Retires once the attempt has an outcome — a chip or an error — since nothing
 * clears the box and it would otherwise resubmit the same code forever.
 */
const applyCoupon = actions(() => {
  const input = couponInput.current;
  if (input === null || input.value === "") return [];
  if (input.errorShown || appliedCouponCodes.current.includes(input.value)) return [];
  return clicks(couponApplyTargets.current);
});

/** Bombadil's own exploration, minus `inputs` (its long unicode typing outlasts timing bounds). */
const explore = weighted([
  [6, clickAnything],
  [3, scroll],
  [2, navigation],
  [1, waitOnce],
]);

/**
 * The single exported generator: Bombadil weights exported generators equally,
 * so combining them here is what makes these weights mean anything.
 *
 * Add and remove never compete — they live on different pages — so each weight
 * really sets how often that flow beats `explore` wandering off.
 */
export const shopActions = weighted([
  [12, explore],
  [12, addToCart],
  [6, removeCartItem],
  [6, emptyCart],
  [24, focusCouponInput],
  [42, typeValidCoupon],
  [12, typeInvalidCoupon],
  [72, applyCoupon],
  // Weight 1: each pick costs six seconds, which is a large slice of a run.
  [1, doNothingForSixSeconds],
]);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * NOTE: specs/03 §4.2 budgets ~3 s for success/info and ~5 s for warning
 * toasts, so a 2 s bound reports violations for toasts dismissing on time.
 */
const DISMISS_BOUND_SECONDS = 2;

const LEAK_WINDOW_SECONDS = 60;
const DOM_NODE_GROWTH_LIMIT = 8000;
const LISTENER_GROWTH_LIMIT = 6000;

/** specs/03 §4.2, AC7 — a toast nobody is hovering goes away on its own, within the bound. */
export const notificationAutoDismisses = always(() => {
  const pending = pendingToastId.current;

  return now(() => pending !== null).implies(
    eventually(() => pendingToastId.current !== pending).within(
      DISMISS_BOUND_SECONDS,
      "seconds",
    ),
  );
});

/** Guards the property above from going vacuous if `data-toast-id` disappears. */
export const everyToastCarriesAnId = always(() => toastsMissingAnId.current === 0);

/**
 * A line's quantity moves by one step at a time, or not at all.
 *
 * Per line rather than on the cart total, because the total legitimately jumps:
 * removing a line drops it by that line's whole quantity. Lines that appear or
 * disappear between the two states are skipped for the same reason.
 *
 * Restricted to a single navigation entry because the product page can add
 * several units at once — that is a real multi-step change, and it needs
 * leaving /cart to reach.
 */
export const cartQuantityMovesOneStep = always(() => {
  const before = cartQuantities.current;

  return next(() => {
    const after = cartQuantities.current;
    if (after.nav !== before.nav) return true;

    return Object.keys(before.quantities).every((productId) => {
      const from = before.quantities[productId];
      const to = after.quantities[productId];
      return from === undefined || to === undefined || Math.abs(to - from) <= 1;
    });
  });
});

/** specs/01 §7.2 — only a coupon that exists can end up applied. */
export const onlyRealCouponsApply = always(() => {
  const { valid } = couponPool.current;
  return (
    valid.length === 0 || appliedCouponCodes.current.every((code) => valid.includes(code))
  );
});

/** Harness self-check: a wrong admin key silences the coupon flow, so fail instead. */
export const couponPoolLoads = eventually(
  () => couponPool.current.valid.length > 0,
).within(30, "seconds");

/** specs/01 §5 — no figure the shopper is charged ever reads as negative. */
export const cartMoneyNeverNegative = always(() => {
  const { cartBadgeSubtotal, total, subtotal, tax, shipping } = cartMoney.current;
  return [cartBadgeSubtotal, total, subtotal, tax, shipping].every(
    (figure) => figure === null || figure >= 0,
  );
});

/**
 * DOM nodes stay within a growth band over a sliding window.
 *
 * Limits are wide because navigation churn oscillates (89–5818 nodes measured);
 * a leak accumulates instead. Catches a runaway, not a slow drip.
 */
export const noDomNodeLeak = always(() => {
  const baseline = domNodes.current;
  return always(() => domNodes.current - baseline <= DOM_NODE_GROWTH_LIMIT).within(
    LEAK_WINDOW_SECONDS,
    "seconds",
  );
});

/** Event listeners stay within a growth band over a sliding window. */
export const noEventListenerLeak = always(() => {
  const baseline = eventListeners.current;
  return always(
    () => eventListeners.current - baseline <= LISTENER_GROWTH_LIMIT,
  ).within(LEAK_WINDOW_SECONDS, "seconds");
});
