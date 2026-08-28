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
import { actions, extract, weighted, type Action, type State } from "@antithesishq/bombadil/browser";
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
 * How Bombadil identifies the element a click landed on — it is what the run
 * log and any violation report show you.
 *
 * Every field is required, and the shape is NOT the one the shipped types
 * describe: `@antithesishq/bombadil@0.6.1` declares `Click` as
 * `{ name, content, point }`, but the 0.6.1 binary rejects that outright with
 * `failed to convert generated action: missing field 'fingerprint'`. The
 * definition below was recovered from a trace the binary wrote itself, so it is
 * the runtime's own shape; `clicks()` casts past the stale declaration. Revisit
 * this when upgrading — if the types and the binary agree again, drop the cast.
 */
type Fingerprint = {
  tag: string;
  testId: string | null;
  id: string | null;
  role: string | null;
  accessibleName: string | null;
  href: string | null;
  nameAttr: string | null;
  placeholder: string | null;
  inputType: string | null;
  textContent: string | null;
  structuralPath: string | null;
};

type ClickTarget = { fingerprint: Fingerprint; point: { x: number; y: number } };

/** Attribute value, or null — matching how the runtime reports an absent one. */
function attr(element: Element, name: string): string | null {
  return element.getAttribute(name);
}

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

      const text = (element.textContent ?? "").trim();

      return [
        {
          fingerprint: {
            tag: element.tagName.toLowerCase(),
            testId: attr(element, "data-testid"),
            id: attr(element, "id"),
            role: attr(element, "role"),
            // The runtime reads the attribute, not the computed accessible
            // name: a button with only text content reports null here.
            accessibleName: attr(element, "aria-label"),
            href: attr(element, "href"),
            nameAttr: attr(element, "name"),
            placeholder: attr(element, "placeholder"),
            inputType: attr(element, "type"),
            textContent: text.length > 0 ? text : null,
            structuralPath: null,
          },
          point,
        },
      ];
    });
}

/** See the `Fingerprint` note above for why this cast is here. */
function clicks(targets: ClickTarget[]): Action[] {
  return targets.map((target) => ({ Click: target })) as unknown as Action[];
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

/** Whether the coupon box is focused, and what is already in it. */
const couponInput = extract((state) => {
  const input = state.document.querySelector("[data-testid='coupon-input']");
  if (input === null) return null;
  return {
    focused: state.document.activeElement === input,
    empty: (input as HTMLInputElement).value.trim().length === 0,
  };
});

/**
 * `TypeText` types into whatever is focused — there is no target on the action
 * — so entering a coupon is three steps, not one: focus the box, type, submit.
 *
 * The text is not a literal either. `text` is a tagged union of *generators*
 * (`Text`, `Email`, `Regexp`, `CharSet`), so a plain string is rejected with
 * `invalid type: string, expected f64` — `Text` wants a length. A `Regexp` of
 * an escaped literal is how you pin an exact string.
 */
function typeText(text: string): Action[] {
  return [
    { TypeText: { text: { Regexp: escapeRegExp(text) }, delayMillis: 10 } },
  ] as unknown as Action[];
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
const typeValidCoupon = actions(() =>
  couponInput.current?.focused && couponInput.current.empty
    ? couponPool.current.valid.flatMap((code) => typeText(code))
    : [],
);

const typeInvalidCoupon = actions(() =>
  couponInput.current?.focused && couponInput.current.empty
    ? couponPool.current.invalid.flatMap((code) => typeText(code))
    : [],
);

const applyCoupon = actions(() =>
  couponInput.current !== null && !couponInput.current.empty
    ? clicks(couponApplyTargets.current)
    : [],
);

/** The coupon codes the cart is currently showing as applied. */
const appliedCouponCodes = extract((state) =>
  Array.from(state.document.querySelectorAll("[data-testid='coupon-chip']"))
    .map((chip) => chip.getAttribute("data-code") ?? "")
    .filter((code) => code.length > 0),
);

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
  [3, addToCart],
  [2, removeCartItem],
  [3, emptyCart],
  [6, focusCouponInput],
  [8, typeValidCoupon],
  [8, typeInvalidCoupon],
  [8, applyCoupon],
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
const DISMISS_BOUND_SECONDS = 6;

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

  return ids.length > 0 ? Math.min(...ids) : null;
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
