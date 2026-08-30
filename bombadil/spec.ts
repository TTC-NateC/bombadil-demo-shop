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
 *     --time-limit 5m --exit-on-violation
 */

import { always, eventually, now } from "@antithesishq/bombadil";
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
// Action generators
// ---------------------------------------------------------------------------

/**
 * A click Bombadil can perform: how it identifies the element (the fingerprint,
 * which is what the run log and any violation report show you) and where to
 * put the pointer.
 */
type ClickTarget = { fingerprint: Fingerprint; point: { x: number; y: number } };

/**
 * The clickable targets matching `selector`, as click points.
 *
 * Three filters, each of which Bombadil would otherwise waste actions on:
 * `:disabled` (both the add and remove buttons disable themselves while their
 * request is in flight), zero-size boxes (`display: none`), and anything
 * scrolled outside the viewport — a click is dispatched at a coordinate, so an
 * off-screen point lands on whatever happens to be there instead. The default
 * scroll actions bring the rest into view soon enough.
 */
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

function clicks(targets: ClickTarget[]): ActionTemplate[] {
  return targets.map((target) => ({ Click: target }));
}

/**
 * Catalog "Add to cart" buttons. Scoped to `product-card-add`, which is the
 * catalog grid only: the product page uses `pdp-add-to-cart` and the
 * recommendation strip uses `recommendation-add`.
 */
const catalogAddButtons = extract((state) =>
  clickTargets(state, "[data-testid='product-card-add']"),
);

/** Per-line "Remove" buttons on /cart. */
const cartRemoveButtons = extract((state) =>
  clickTargets(state, "[data-testid='cart-item-remove']"),
);

/**
 * How many lines the cart is showing. Drives `emptyCart`, and doubles as the
 * readable signal in the trace for whether a run ever drained the cart.
 */
const cartLineCount = extract(
  (state) => state.document.querySelectorAll("[data-testid='cart-line-item']").length,
);

const addToCart = actions(() => clicks(catalogAddButtons.current));

/** Remove any one line, chosen freely among them. */
const removeCartItem = actions(() => clicks(cartRemoveButtons.current));

/**
 * Drain the cart from the top: always the *first* remaining line, so repeated
 * picks walk the cart down to empty instead of wandering among lines.
 *
 * There is no bulk "empty cart" control in the UI — only per-line removal — so
 * emptying the cart is a run of individual clicks rather than one action, and
 * Bombadil has no notion of "repeat until". This generator is what makes that
 * run happen: it stays available for as long as anything is left, and carries
 * enough weight (below) to out-vote wandering off the page. The empty cart is
 * worth reaching because it is a distinct state — it re-renders as empty and
 * drops any applied coupon with it.
 *
 * An earlier version offered only the very last line's remove button, on the
 * theory that the final click was the interesting one. It fired in 0 of 642
 * states: adds outnumbered removes, so the cart never shrank to one line.
 */
const emptyCart = actions(() =>
  cartLineCount.current > 0 ? clicks(cartRemoveButtons.current.slice(0, 1)) : [],
);

// --- Broad exploration ------------------------------------------------------

/**
 * Bombadil's own exploration, assembled by hand instead of using
 * `defaultActions` — the difference is that `inputs` is left out.
 *
 * `inputs` types long random unicode strings a character at a time. One such
 * action was measured taking 10.2 s, and no state is captured while an action
 * is in flight: every bounded-time property is unfalsifiable across that gap,
 * and `notificationAutoDismisses` reported a violation for a toast that had in
 * fact dismissed on schedule. The bound is not the problem — a single action
 * outlasting it is. The coupon generators below cover the one text input this
 * app has, deliberately and with a bounded delay.
 *
 * That measurement was taken on 0.6.1; it is worth re-timing on 0.7.x before
 * assuming it still holds.
 *
 * Put `inputs` back (or swap the whole block for `defaultActions`) if you want
 * that unicode fuzzing, and expect timing properties to report noise.
 */
const explore = weighted([
  [6, clickAnything],
  [3, scroll],
  [2, navigation],
  [1, waitOnce],
]);

// --- Coupons ---------------------------------------------------------------

/**
 * Where the fetched coupon codes are parked on `window`.
 *
 * An extractor has to return synchronously, so the first evaluation on a page
 * kicks the request off and reports an empty list; later states see the filled
 * cache. A fresh page load starts over, which is what we want — the codes are
 * re-read rather than carried across a navigation.
 */
const COUPON_CACHE = "__bombadilValidCoupons";

/** Rust's regex crate has no escape helper exposed here, so do it ourselves. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * The real coupon codes, and a set of randomly generated codes confirmed not to be
 * among them.
 *
 * `GET /api/coupons` is admin-gated and `requireAdmin` fails closed, so this
 * needs the key on the request. Rather than bake a secret into the spec, the
 * run supplies it: `--header x-admin-key=<key>` puts it on every browser
 * request. Without it the fetch 401s, the list stays empty, and *both* coupon
 * generators go quiet — deliberately. An empty list means nothing to type for
 * the valid case, and no way to confirm the invalid case really is invalid;
 * typing a "known bad" code we never checked would be a lie.
 *
 * The invalid code is generated and then *checked* against the real set rather
 * than assumed distinct: a random draw can always collide, and the whole point
 * of this action is that the shop rejects a code that does not exist.
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
  if (valid.length === 0) return { valid, invalid: [] };

  // As many made-up codes as there are real ones, so the two typing generators
  // offer Bombadil the same number of alternatives and it picks between valid
  // and invalid evenly. Skewed branches skew the coverage: an earlier version
  // offered 5 real codes against 1 made-up one and the run typed 10 invalid
  // codes to every 1 valid.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const invalid: string[] = [];

  for (let attempt = 0; attempt < 40 && invalid.length < valid.length; attempt++) {
    const length = 6 + Math.floor(Math.random() * 7);
    let candidate = "";
    for (let i = 0; i < length; i++) {
      candidate += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    // The shop uppercases and trims before lookup, so compare on those terms.
    if (!valid.includes(candidate) && !invalid.includes(candidate)) {
      invalid.push(candidate);
    }
  }

  return { valid, invalid };
});

const couponInputTargets = extract((state) =>
  clickTargets(state, "[data-testid='coupon-input']"),
);

const couponApplyTargets = extract((state) =>
  clickTargets(state, "[data-testid='coupon-apply']"),
);

/**
 * Whether the coupon box is focused, and what is already in it — normalised
 * the way the shop normalises it before lookup (trimmed, uppercased), so the
 * value can be compared against the applied chips directly.
 */
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

/**
 * `TypeText` types into whatever is focused — there is no target on the action
 * — so entering a coupon is three steps, not one: focus the box, type, submit.
 *
 * The text is a `StringGenerator`, not a literal: Bombadil generates the string
 * from `Email`, `{ Text: length }`, `{ CharSet }` or `{ Regexp }`. A `Regexp`
 * of an escaped literal is how you pin one exact string — the pattern matches
 * only itself, so that is the only string it can produce.
 */
function typeText(text: string): ActionTemplate[] {
  return [{ TypeText: { text: { Regexp: escapeRegExp(text) }, delayMillis: 10 } }];
}

const focusCouponInput = actions(() =>
  couponInput.current !== null && !couponInput.current.focused
    ? clicks(couponInputTargets.current)
    : [],
);

/**
 * One action per real code, so Bombadil picks between them itself rather than
 * this spec having to choose — the runtime's random module is declaration-only
 * (`strings().generate()` is not callable here), so returning the alternatives
 * is how you delegate the choice.
 *
 * Only while the box is empty: nothing clears it after a submit, so typing
 * again would append and build a nonsense code. Navigating back to /cart
 * remounts the form empty, which is what lets this fire repeatedly.
 */
/** The coupon codes the cart is currently showing as applied. */
const appliedCouponCodes = extract((state) =>
  Array.from(state.document.querySelectorAll("[data-testid='coupon-chip']"))
    .map((chip) => chip.getAttribute("data-code") ?? "")
    .filter((code) => code.length > 0),
);

const typeValidCoupon = actions(() =>
  couponInput.current?.focused && couponInput.current.value === ""
    ? couponPool.current.valid.flatMap((code) => typeText(code))
    : [],
);

const typeInvalidCoupon = actions(() =>
  couponInput.current?.focused && couponInput.current.value === ""
    ? couponPool.current.invalid.flatMap((code) => typeText(code))
    : [],
);

/**
 * Submit what is in the box — and then get out of the way.
 *
 * Typing and submitting are separate actions, so without a heavy weight (below)
 * Bombadil types a code and wanders off before pressing Apply, and the coupon
 * never lands. The weight fixes that, but only because this generator retires
 * itself the moment the attempt has an outcome: an accepted code becomes a
 * chip, a rejected one raises `coupon-error` (the cart sets it on every
 * attempt). Nothing clears the box afterwards, so without those two guards a
 * heavily-weighted Apply would just hammer the same code forever.
 */
const applyCoupon = actions(() => {
  const input = couponInput.current;
  if (input === null || input.value === "") return [];
  if (input.errorShown || appliedCouponCodes.current.includes(input.value)) return [];
  return clicks(couponApplyTargets.current);
});

/**
 * The one exported generator, so the weights below are the whole story —
 * Bombadil runs every exported generator and weights them equally, so exporting
 * these separately would silently flatten the balance.
 *
 * `explore` keeps the broad sweep (clicking anything, scrolling, navigation);
 * the rest bias the run towards the cart and coupon flows, which random
 * clicking reaches slowly.
 *
 * The add and remove generators never actually compete: a generator contributes
 * nothing in states where it finds no targets, and the add buttons live on the
 * catalog while the remove buttons live on /cart. What each weight really sets
 * is how often that flow beats `defaultActions` wandering off the page — which
 * is why the draining generators together outweigh it, and why adding is
 * deliberately the lighter. Left even, the cart fills faster than it drains and
 * never reaches empty.
 *
 * Draining is tuned down from where it was before the coupon actions arrived:
 * the coupon form only renders on a *non-empty* cart, so a cart that empties
 * too eagerly takes the coupon flow off the page with it. The coupon
 * generators guard each other into a sequence — focus, then type, then submit —
 * so at most a couple are live at once and their weights compete with draining
 * rather than with each other.
 */
export const shopActions = weighted([
  [4, explore],
  [4, addToCart],
  [2, removeCartItem],
  [2, emptyCart],
  [8, focusCouponInput],
  [14, typeValidCoupon],
  [4, typeInvalidCoupon],
  [24, applyCoupon],
]);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * specs/03 §4.2 budgets the longest auto-dismiss at ~5 s (warning); success and
 * info get ~3 s. The bound is that ceiling plus a second of slack: the timer
 * only *starts* the dismissal, and React's re-render plus Bombadil's discrete
 * state sampling land after it. A hard 5 s bound would turn every warning toast
 * into a coin flip, which reports noise rather than bugs.
 */
const DISMISS_BOUND_SECONDS = 2;

/**
 * The oldest toast that is currently waiting to auto-dismiss, or null if there
 * is none.
 *
 * Two subtleties are baked in here, and both matter:
 *
 * 1. Identity, not presence. Asking "is the toast area empty?" is the obvious
 *    property and the wrong one — Bombadil can click Add to Cart faster than
 *    3 s, so the area is legitimately never empty while each individual toast
 *    dismisses on time. Tracking the *lowest live toast id* fixes this. Ids
 *    come from a monotonic counter (Toaster.tsx), so while a given toast is
 *    still waiting no smaller id can appear, and the value can only change by
 *    that toast leaving.
 *
 * 2. Hover is exempt. §4.2 makes hover pause the timer indefinitely, and the
 *    toasts sit in the bottom-right corner where a generated click can easily
 *    leave the cursor parked on top of one. A hovered toast that never
 *    dismisses is the spec working, so it drops out of the set here.
 */
const pendingToastId = extract((state) => {
  const ids = Array.from(state.document.querySelectorAll("[data-testid='toast']"))
    .filter((toast) => !toast.matches(":hover"))
    .map((toast) => toast.getAttribute("data-toast-id"))
    .filter((id): id is string => id !== null)
    .map(Number)
    .filter((id) => Number.isInteger(id));

  if (ids.length === 0) return null;

  // Qualified by the navigation entry, because Toaster.tsx counts from a
  // `useRef(1)` that restarts on every page load — toast 1 on the cart page and
  // toast 1 back on the catalog are different toasts wearing the same number.
  // Unqualified, a fresh toast that reused a departed toast's id read as the
  // old one never leaving, and the run filled with violations for toasts that
  // had dismissed on time.
  return `${state.navigationHistory.current.id}:${Math.min(...ids)}`;
});

/**
 * specs/03 §4.2, AC7 — a toast the shopper is not holding open goes away on its
 * own: whichever toast is at the front of the queue now is either dismissed or
 * pinned by the pointer within the bound.
 *
 * The outer thunk is what makes this a *guarantee about one toast* rather than
 * about the toast area: it pins `pending` to the id observed in this state, and
 * the inner thunk compares later states against that captured id.
 */
export const notificationAutoDismisses = always(() => {
  const pending = pendingToastId.current;

  return now(() => pending !== null).implies(
    eventually(() => pendingToastId.current !== pending).within(
      DISMISS_BOUND_SECONDS,
      "seconds",
    ),
  );
});

/**
 * specs/01 §7.2 — only a coupon that exists can end up applied.
 *
 * This is what turns `typeInvalidCoupon` from "types junk" into a real test.
 * That generator randomly makes up a code and checks it against the live set
 * before typing it, so every rejection Bombadil provokes is a rejection of a
 * code the shop genuinely does not have; this property is the other half,
 * asserting the made-up ones never come back as an applied chip.
 *
 * Guarded on a non-empty set because `couponPool` starts empty on every page
 * while its fetch is in flight — without the guard, a chip observed in that
 * window would look like a violation of a set we simply had not loaded yet.
 */
export const onlyRealCouponsApply = always(() => {
  const { valid } = couponPool.current;
  return (
    valid.length === 0 || appliedCouponCodes.current.every((code) => valid.includes(code))
  );
});

/**
 * A guard on the property above rather than a claim about the shop.
 *
 * `pendingToastId` skips any toast without a `data-toast-id`, so if that
 * attribute ever disappears from Toaster.tsx the guarantee would quietly become
 * vacuous and pass forever. This fails loudly instead.
 */
const toastsMissingAnId = extract(
  (state) =>
    state.document.querySelectorAll("[data-testid='toast']:not([data-toast-id])")
      .length,
);

export const everyToastCarriesAnId = always(() => toastsMissingAnId.current === 0);

/**
 * Read a rendered money figure back to a number, or null if the text is not
 * money at all (the shipping row says "FREE", and absent rows read as empty).
 *
 * Parsing display text rather than an API response is the point: this checks
 * the number the shopper actually sees. `formatCents` goes through
 * `Intl.NumberFormat`, so a negative can surface as `-$1.23` or, on some ICU
 * data, as `($1.23)` — both are treated as negative here so the property cannot
 * be defeated by a formatting difference.
 */
function parseMoney(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // U+2212 MINUS SIGN as well as ASCII hyphen — see the discount row note below.
  const negative = /^[-−(]/.test(trimmed) || trimmed.endsWith(")");
  const digits = trimmed.replace(/[^0-9.]/g, "");
  if (digits.length === 0) return null;

  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Every money figure the shopper can see, per page.
 *
 * `cartBadgeSubtotal` is the catalog side of this. The catalog has no order
 * total — the only cart money outside /cart is the running subtotal in the
 * header badge (CartBadge, §8.1), and because that badge lives in the root
 * layout it is checked on *every* page, catalog included. The remaining figures
 * only exist on /cart.
 *
 * `breakdown-discount` is deliberately absent. Discount rows render a literal
 * `−` prefix (PriceBreakdown.tsx), so they are negative on purpose and by
 * design; including them would fail on the first coupon applied and say nothing
 * about the shop being wrong.
 */
const cartMoney = extract((state) => {
  const read = (testId: string) => {
    const element = state.document.querySelector(`[data-testid='${testId}']`);
    return element === null ? null : parseMoney(element.textContent ?? "");
  };

  return {
    cartBadgeSubtotal: read("cart-badge-subtotal"),
    total: read("breakdown-total"),
    subtotal: read("breakdown-subtotal"),
    tax: read("breakdown-tax"),
  };
});

/**
 * specs/01 §5 — no figure the shopper is charged ever reads as negative, on the
 * catalog (header badge) or on /cart (the breakdown).
 *
 * The engine already clamps: `totalCents = Math.max(0, ...)` in
 * pricing/engine.ts, with a unit test covering a FIXED discount larger than the
 * subtotal. What that test cannot do is enumerate coupon stacking against
 * arbitrary carts. This is the end-to-end guard on the same invariant, over
 * whatever combination Bombadil actually manages to assemble — and it reads the
 * rendered text, so it also catches a clamp that holds in the engine but is
 * lost on the way to the screen.
 *
 * Subtotal and tax ride along with the total: each is clamped by the same
 * engine, a negative one is just as wrong, and naming them separately means a
 * violation says which figure broke instead of just "the cart".
 */
/**
 * A harness self-check, not a claim about the shop.
 *
 * `GET /api/coupons` is admin-gated, and when the key is missing or wrong the
 * fetch 401s, the pool stays empty and both coupon generators go quiet — a run
 * that looks perfectly healthy while covering none of the coupon flow. This
 * turns that silence into a violation.
 *
 * Bounded rather than an invariant because the pool is genuinely empty for the
 * moment between a page load and its fetch landing; 30 s is far longer than
 * that and far shorter than any useful run.
 */
export const couponPoolLoads = eventually(
  () => couponPool.current.valid.length > 0,
).within(30, "seconds");

/**
 * Resource metrics Chrome reports per state (0.7.x `State.resources`).
 *
 * `dom_nodes` and `js_event_listeners` rather than heap: the heap moves with
 * garbage collection, so it needs large limits and long windows before it
 * stops crying wolf. These two only grow when something is actually retained.
 */
const domNodes = extract((state) => state.resources.dom_nodes);
const eventListeners = extract((state) => state.resources.js_event_listeners);

/**
 * Sliding-window growth limits, sized from measurement rather than taste.
 *
 * Over a 926-state run this app ranges 89–5818 DOM nodes and 201–2258
 * listeners. That swing is not a leak: Bombadil moves between an empty cart and
 * a 16-card catalog, and each page legitimately builds what it needs. A first
 * attempt at 4000 nodes / 600 listeners over 10 s reported 297 violations, all
 * of them ordinary navigation.
 *
 * What separates the two is shape, not size. Churn *oscillates* within a band
 * fixed by the largest page; a leak *accumulates*. So the window is long and
 * the limits sit above the whole observed band: over a full minute, navigation
 * keeps returning to the same range and stays inside the limit, while anything
 * genuinely retained keeps climbing and crosses it.
 *
 * This is therefore a runaway detector, not a fine-grained one — it will not
 * notice a handful of listeners leaked per mount. Re-measure and lower these if
 * the app's page weights change materially.
 */
const LEAK_WINDOW_SECONDS = 60;
const DOM_NODE_GROWTH_LIMIT = 8000;
const LISTENER_GROWTH_LIMIT = 6000;

/**
 * `noResourceLeak` from `@antithesishq/bombadil/browser/extras/resources` would
 * normally express these, but 0.7.2 ships `extras/resources.d.ts` in `dist`
 * while omitting the subpath from the package `exports` map, so the import does
 * not resolve. These are the same sliding-window shape written by hand: pin the
 * metric at each state, then require that it stays within `baseline + limit`
 * for the whole window — a bounded `always`, which is exactly a sliding window.
 */
export const noDomNodeLeak = always(() => {
  const baseline = domNodes.current;
  return always(() => domNodes.current - baseline <= DOM_NODE_GROWTH_LIMIT).within(
    LEAK_WINDOW_SECONDS,
    "seconds",
  );
});

export const noEventListenerLeak = always(() => {
  const baseline = eventListeners.current;
  return always(
    () => eventListeners.current - baseline <= LISTENER_GROWTH_LIMIT,
  ).within(LEAK_WINDOW_SECONDS, "seconds");
});

export const cartMoneyNeverNegative = always(() => {
  const { cartBadgeSubtotal, total, subtotal, tax } = cartMoney.current;
  return [cartBadgeSubtotal, total, subtotal, tax].every(
    (figure) => figure === null || figure >= 0,
  );
});
