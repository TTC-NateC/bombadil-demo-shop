# cart-mutation-applied-at-most-once

## What led here

Focus 9 (idempotency and replay). The cart API has no idempotency key, no request
id, and no de-duplication. That is unremarkable on its own — most small APIs
don't. It becomes a property because Antithesis will inject exactly the fault
that makes it matter: a network fault that drops the *response* after the write
has committed, leaving the client unable to tell whether its mutation landed.

## Code paths

- `src/app/api/cart/items/route.ts` — `POST`, `PATCH`, `DELETE`. No request
  identifier is read from the request, and no record of applied requests is kept.
- `src/components/cart-events.ts:14-25` — `mutateCart`, the single client-side
  mutation helper. One `fetch`, no retry, no timeout, no `AbortController`.
  A failure surfaces as `{ok: false}` and produces one warning toast.

So today the client never retries, which means a dropped response silently
*loses* a shopper action rather than duplicating one. The property matters for
two reasons regardless:

1. It bounds what a future retry policy could safely do.
2. `POST /api/cart/items` is additive (`existing.quantity + quantity`), so if any
   layer between the browser and the handler ever replays a request — a proxy, a
   service worker, a user's double-submit on a stalled request — the effect
   compounds silently.

## Failure scenario

The scenario this property is built to catch is a single request being applied
twice:

| t | Client | Server |
|---|---|---|
| 1 | `POST /api/cart/items {P, qty 1}` | receives, commits `quantity: 1 → 2` |
| 2 | | response dropped by a network fault |
| 3 | client times out; cannot distinguish "not applied" from "applied, ack lost" | |
| 4 | client retries the same request | receives, commits `quantity: 2 → 3` |

The shopper asked for two adds and has three. If the workload asserted equality
against its acked count, it would false-positive here at step 3 — the write *did*
land and the workload legitimately doesn't know. Hence the interval form.

## Why the property is an interval, not an equality

`acked <= observed <= attempted`.

- The lower bound is the durability claim: nothing acknowledged is lost.
- The upper bound is the real content: no request was applied more times than it
  was sent.
- The gap between them is genuine, irreducible uncertainty introduced by the
  dropped ack — encoding it as uncertainty rather than collapsing it to a guess
  is what keeps the assertion from firing on correct behavior.

A violation of the upper bound means the SUT applied one request twice, which
would be a real defect. A violation of the lower bound means an acknowledged
write was lost, which overlaps `cart-item-quantity-no-lost-update` — the two
properties bracket the same counter from opposite sides.

## Scope decision (2026-08-01): unchanged at P1

The user confirmed multi-shopper access is out of scope. This property is
unaffected: its mechanism is one client, one request, and a network fault that
drops the response after the write commits. No second shopper appears anywhere in
it.

Along with `single-cart-per-session`, this is one of the two category A properties
that kept full priority.

## Interaction with the lost-update window

These two mechanisms compose badly. Under contention a retry can be *both*
duplicated (its first attempt landed) and lost (its second attempt raced another
request's read-modify-write). The observed quantity can then land anywhere in the
interval for reasons that have nothing to do with the retry. This is worth
knowing when triaging a failure: check `cart-item-quantity-no-lost-update` first,
because a lost update makes this property's lower bound fire.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** per-`(cart, product)` counters for `acked` and
  `attempted`, and the `Always` interval assertion. This is workload bookkeeping;
  no SUT changes are needed.
- **Missing, SUT-side:** none possible without an idempotency key. If one were
  added, an assertion marking "duplicate request id rejected" would become the
  sharper check.

## Open questions

- **Should the API expose an idempotency key so retries are safe, or is
  at-least-once with a bounded-overshoot guarantee acceptable for a demo?** If an
  idempotency key is intended, the property becomes an equality
  (`observed === acked` after retries settle) and gains a companion `Reachable`
  marker for the de-duplication path. If not, the interval form is the strongest
  honest claim, and a future client-side retry would be knowingly unsafe. This
  determines whether a violation of the upper bound is a bug or expected behavior.

### Investigation Log

#### Should the API expose an idempotency key, or is at-least-once acceptable?

- Examined: `specs/01` §7.2 and §7.3 (cart API shapes and error codes),
  `specs/02` §6 (validation and errors), `specs/03` §4 (toast behavior on cart
  mutation outcomes), `src/components/cart-events.ts`, `src/app/api/cart/**`.
- Found: no spec section mentions retries, idempotency, request ids, or duplicate
  submission. `specs/03` §4 specifies that toasts fire "on the outcome of every
  cart mutation — *after* the API returns," which shows the authors thought about
  the request/response boundary, but only for message accuracy, not for
  duplicate delivery. The client is confirmed not to retry.
- Not found: any statement of intended retry semantics, and any handling for the
  ambiguous-outcome case anywhere in client or server code.
- Conclusion: tagged `(needs human input)`. The repository is silent on the
  question rather than answering it implicitly; deciding it is a design call.
