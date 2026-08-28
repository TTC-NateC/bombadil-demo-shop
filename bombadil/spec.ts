/**
 * Bombadil specification — property-based testing for the shop UI.
 *
 * Bombadil drives the browser itself, generating its own clicks, scrolls,
 * typing and navigation, and checks these properties against every state it
 * captures. Unlike the Playwright suite in e2e/, nothing here scripts a
 * scenario: the properties must hold no matter what the shopper does.
 *
 * Run it against a server you have already started (see README):
 *
 *   bombadil browser test http://localhost:3000 bombadil/spec.ts \
 *     --time-limit 2m --exit-on-violation
 */

import { always, eventually, now } from "@antithesishq/bombadil";
import { extract } from "@antithesishq/bombadil/browser";

/**
 * The default action generator — this is what actually drives the UI. Without
 * an exported generator Bombadil has no moves to make.
 */
export { defaultActions } from "@antithesishq/bombadil/browser/defaults";

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
 * own, and stays gone-able: whichever toast is at the front of the queue now is
 * either dismissed or pinned by the pointer within the bound.
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
