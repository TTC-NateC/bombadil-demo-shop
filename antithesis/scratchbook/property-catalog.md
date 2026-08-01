---
sut_path: c:\Users\NateCuster\OneDrive - TTC Global\src\demo-shop
commit: 3f1a675407468168f50325ff048ce6ab7ddd7bf1
updated: 2026-08-01
external_references: []
---

# Property Catalog — demo-shop

24 properties, organized by the area of the system they cover. Scope per the
user's answers at the start of the run: repository only, cart/checkout core as
the target subsystem.

Priority is impact × Antithesis leverage: **P0** = a shopper-visible correctness
failure that only concurrency or faults can produce; **P1** = a real defect class
that fault injection reaches meaningfully; **P2** = worth checking, partly
reachable by deterministic tests.

## Scope decision: multi-shopper access is out of scope

**Decided by the user on 2026-08-01**, resolving the bias escalated in
`evaluation/synthesis.md` (B1). The served demo is not required to handle
overlapping requests from more than one person. Priorities below reflect that.

What this does **not** exclude, and why:

1. **One shopper's browser issuing overlapping requests to itself.** The cart page
   mounts `CartPage` and `CartBadge`, and both fetch `/api/cart` on mount,
   unordered ([cart/page.tsx:28](../../src/app/cart/page.tsx#L28),
   [CartBadge.tsx:13](../../src/components/CartBadge.tsx#L13)). Every mutation
   then fires `notifyCartUpdated()` twice, each triggering another badge refresh.
   This is single-shopper behavior the application generates on its own, so it
   stays in scope at full priority.
2. **Admin operations concurrent with one shopper.** An operator running the
   staging script's `--reset` or editing a price while someone is browsing is a
   single-shopper scenario with an operator, not two shoppers. `specs/02` §9.5
   describes `--reset` as the thing you run right after a demo — precisely when a
   cart exists. Category C stays in scope.
3. **A single client retrying after a dropped response.** One shopper, one
   browser, one network fault. Stays in scope.

What it **does** exclude: two or more shoppers issuing requests against the same
cart. The three properties whose wide trigger was that scenario are demoted to P2
below and reframed as documented limitations rather than bug hunts — they remain
in the catalog because each retains a narrow single-shopper path, recorded in its
evidence file.

**Net effect:** 3 properties demoted P0 → P2 (`cart-coupon-set-atomic`,
`cart-item-quantity-no-lost-update`, `cart-item-create-no-unique-violation`).
Priorities move from 6 P0 / 12 P1 / 6 P2 to **3 P0 / 12 P1 / 9 P2**. No property
was removed, added, or changed assertion type.

Properties tagged **[needs node-termination]** or **[needs clock-jitter]** depend
on fault types that are commonly disabled by default — confirm with the user
before relying on them (`references/faults.md`).

## Index

| Category | Properties |
|---|---|
| A. Cart state integrity under concurrency | `cart-coupon-set-atomic`, `cart-item-quantity-no-lost-update`, `cart-item-create-no-unique-violation`, `single-cart-per-session`, `cart-mutation-applied-at-most-once` |
| B. Pricing correctness on the live path | `priced-cart-invariants-hold`, `money-fields-stay-exact`, `applying-coupon-never-raises-total`, `persisted-coupons-match-discount-lines`, `coupon-removal-is-reversible`, `price-snapshot-immutable` |
| C. Admin writes against live carts | `bulk-product-create-atomic`, `product-delete-cascades-cleanly`, `coupon-mutation-leaves-cart-consistent`, `catalog-read-never-shows-partial-batch` |
| D. Durability and lifecycle | `acked-cart-mutations-survive-restart`, `startup-crash-never-bricks-container`, `cart-eventually-readable` |
| E. Failure surface | `cart-endpoints-never-unhandled-500` |
| F. Reachability and search guidance | `exclusive-coupon-wins-observed`, `coupon-prune-path-observed`, `allocation-remainder-distributed` |
| G. Resource boundaries | `recommendations-stay-responsive`, `cart-rows-bounded-by-distinct-clients` |

---

## A. Cart state integrity under concurrency

The cart's persisted state is written by four unguarded check-then-act sequences
(`sut-analysis.md` §4). Nothing in the codebase serializes concurrent requests
against one cart, and nothing recovers from a constraint violation.

**Post-scope-decision status.** This category was the densest cluster in the
catalog when multi-shopper access was assumed in scope. With that excluded, it
splits in two:

- **Still full priority (2):** `single-cart-per-session` and
  `cart-mutation-applied-at-most-once`. Neither needs a second shopper — the first
  fires on one shopper's first page load, the second on one client's retry after
  a dropped response.
- **Demoted to P2 (3):** `cart-coupon-set-atomic`,
  `cart-item-quantity-no-lost-update`, `cart-item-create-no-unique-violation`.
  Each retains a narrow single-shopper path (recorded per property), but their
  wide trigger was two shoppers on one cart. They stay in the catalog as
  documented limitations: if one fires, it is a real defect worth knowing about;
  they should not consume search budget ahead of categories B, D and G.

### `cart-coupon-set-atomic` — Concurrent cart operations never lose a persisted coupon change

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P2 (was P0 — demoted by the scope decision) |
| **Property** | When a `POST /api/cart/coupons` returns 200 with a discount line for code C, C is present in `Cart.coupons` and remains present on the next pricing pass, even if other cart requests for the same cart were in flight. |
| **Invariant** | `Always`: for every response the workload receives, every `couponCode` appearing in `discountLines` also appears in the applied-coupon set returned by the *next* `GET /api/cart` for that cart, unless an intervening operation is one the workload knows removes it (explicit coupon delete, or a quantity change that drops the subtotal below the coupon's `minSubtotalCents`). `Always` is correct because this is a durability invariant on every acknowledged apply — a single violation is a lost coupon a shopper paid to earn. |
| **Antithesis Angle** | `priceAndPrune` reads `Cart.coupons`, prices, then writes back ([cart.ts:89-124](../../src/lib/cart.ts#L89-L124)) with no transaction. The clobber requires a coupon apply to overlap an operation that computes a *different* applied set from a stale read — in practice, a quantity change. With multi-shopper access excluded, the single-shopper paths to that overlap are narrow: two browser tabs sharing the cookie, or the toast's Undo callback ([cart/page.tsx:200-207](../../src/app/cart/page.tsx#L200-L207)) firing while a coupon form submit is in flight, since Undo runs `run()` outside the form's `busy` guard. Antithesis widens the read-to-write window with CPU modulation and node throttling. |
| **Why It Matters** | The shopper enters a valid code, sees the discount applied, and the discount silently vanishes on the next page render with no message — `rejectedCoupons` is empty because §5.6's prune is silent by design. Directly contradicts claim S6 in `sut-analysis.md` §5. Demoted rather than dropped because the mechanism is unguarded and the failure mode is silent: if it does fire, nothing else in the system would report it. |

**Open Questions:**

- None.

---

### `cart-item-quantity-no-lost-update` — Concurrent adds of the same product all land

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P2 (was P0 — demoted by the scope decision) |
| **Property** | After N concurrent `POST /api/cart/items` for the same `(cartId, productId)` that each return 200, the item's quantity equals the sum of the requested quantities. |
| **Invariant** | `Always`: the workload tracks the total quantity it successfully added for a `(cart, product)` pair and asserts that the quantity in the next `GET /api/cart` equals it. `Always` rather than `Sometimes` because every acknowledged add must be reflected — this is a lost-update invariant, not a progress condition. |
| **Antithesis Angle** | `POST /api/cart/items` does `findUnique` → `update({quantity: existing.quantity + quantity})` ([items/route.ts:27-35](../../src/app/api/cart/items/route.ts#L27-L35)). There is no `upsert` and no `{increment: n}`. Two requests reading `quantity: 1` both write `2`; one add is lost. With multi-shopper access excluded, the surviving single-shopper path is that the client's `busy` guards are **per component, not per cart**: `AddToCartButton` holds its own flag ([AddToCartButton.tsx:22](../../src/components/AddToCartButton.tsx#L22)), so a product card, a recommendation card for the same product, and the cart page's Undo action are three independent instances that can be in flight together. The window is one `await` wide; Antithesis widens it with CPU modulation, node throttling, and node hang. |
| **Why It Matters** | The shopper adds the same product from a recommendation strip while another add is in flight and one disappears. `specs/01` §7.2 describes this endpoint as "upserts quantity" — the implementation is a non-atomic read-modify-write, so the documented semantics and the code diverge regardless of how many shoppers there are. |

**Open Questions:**

- None.

---

### `cart-item-create-no-unique-violation` — Concurrent first-adds never surface a constraint error

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P2 (was P0 — demoted by the scope decision) |
| **Property** | Concurrent `POST /api/cart/items` for a `(cartId, productId)` pair not yet in the cart never produce a 5xx response; every response is either 200 with a valid `PricedCart` or a structured 4xx. |
| **Invariant** | `Always`: assert `response.status < 500` on every `/api/cart/items` response, with an assertion message naming the endpoint and the observed status. `Always` because a 500 here is an unhandled exception escaping a route handler — never acceptable, however rare. |
| **Antithesis Angle** | Both requests pass the `findUnique` check (no row yet), both call `cartItem.create`, and the second violates `@@unique([cartId, productId])` ([schema.prisma:86](../../prisma/schema.prisma#L86)). Prisma raises P2002. No cart route has a `try`/`catch`, so Next returns an unstructured 500. Distinct from `cart-item-quantity-no-lost-update`: that one is a silent wrong answer, this one is a loud crash, and they occur on opposite branches of the same `if`. It shares that property's surviving single-shopper trigger — per-component `busy` flags — and is narrower still, since it needs the product to be absent from the cart when both requests start. |
| **Why It Matters** | A shopper's first add of a product fails outright with a generic "Something went wrong" toast. The recovery — retrying — then hits the lost-update branch instead. Note that the assertion itself (`status < 500` on `/api/cart/items`) is subsumed by `cart-endpoints-never-unhandled-500`, which stays at P1 for in-scope causes — so demoting this property costs no detection coverage, only the diagnosable story attached to this specific cause. |

**Open Questions:**

- None.

---

### `single-cart-per-session` — A cookie-less client ends up with exactly one cart

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 · **unchanged by the scope decision — now the anchor of this category** |
| **Property** | A client that starts with no `cartId` cookie and issues concurrent requests ends holding one cookie, and every item it successfully added is in the cart that cookie names. |
| **Invariant** | `Always`: the workload models one virtual shopper as one cookie jar. After a burst of concurrent first-contact requests, assert that the number of distinct `cartId` values observed in `Set-Cookie` responses for that shopper is exactly 1, and that a `GET /api/cart` returns every item the shopper added. |
| **Antithesis Angle** | `resolveCartId` is `cookies().get` → `findUnique` → `create` → `jar.set` ([cart.ts:37-49](../../src/lib/cart.ts#L37-L49)). Two concurrent cookie-less requests each create a cart and each emit a different `Set-Cookie`; the browser keeps whichever response lands last, orphaning the other cart and anything written to it. This is reachable on an ordinary first page load, not just under load: the cart page mounts `CartPage` and `CartBadge`, both of which fetch `/api/cart` immediately ([cart/page.tsx:28](../../src/app/cart/page.tsx#L28), [CartBadge.tsx:13](../../src/components/CartBadge.tsx#L13)). Antithesis controls which response wins the race via latency and throttling. |
| **Why It Matters** | A first-time visitor adds an item and the badge shows 0, or the cart page shows an empty cart. Also the mechanism behind unbounded orphan-cart growth (see `cart-rows-bounded-by-distinct-clients`). Retains full priority under the narrowed scope because it needs exactly **one** shopper: the application races itself on every first page load, so excluding multi-shopper access does not touch it. |

**Open Questions:**

- None.

---

### `cart-mutation-applied-at-most-once` — A single cart mutation is never applied twice

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 · **unchanged by the scope decision** |
| **Property** | For a sequence of `POST /api/cart/items` attempts where each is acknowledged, times out, or errors, the resulting quantity lies within `[sum of acknowledged adds, sum of all attempted adds]` — never above. |
| **Invariant** | `Always`: the workload records `acked` and `attempted` totals per `(cart, product)` and asserts `acked <= observed <= attempted`. The upper bound is the real content: exceeding `attempted` would mean one request applied more than once. Stated as an interval because when a response is lost the workload genuinely cannot know whether the write landed — the honest checkable claim is the bound, not equality. |
| **Antithesis Angle** | The API has no idempotency key and no request de-duplication. Network faults that drop a response after the write commits force the client into exactly the ambiguous state this property bounds. Combined with `cart-item-quantity-no-lost-update`'s lost-update window, a workload retry can be simultaneously lost and duplicated. |
| **Why It Matters** | Establishes what retry policy a client can safely use. Today no client retries, so a dropped response silently loses a shopper's action; if one is ever added, this property is what says whether that is safe. |

**Open Questions:**

- Should the API expose an idempotency key so retries are safe, or is at-least-once with a bounded-overshoot guarantee acceptable for a demo? `(needs human input)`

---

## B. Pricing correctness on the live path

The pure engine is well covered by Vitest (`sut-analysis.md` §8). None of that
coverage touches a `PricedCart` produced by the API, where the inputs are
database rows that other requests are concurrently mutating, and where the
snapshot, the config, and the coupon rows all arrive from I/O.

### `priced-cart-invariants-hold` — The seven §5.2 invariants hold on every API response

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P0 |
| **Property** | Every `PricedCart` returned by any cart endpoint satisfies all seven invariants in `specs/01` §5.2. |
| **Invariant** | Seven distinct `Always` assertions, one per invariant, each with its own message — not one assertion wrapping `assertInvariants`. The existing `assertInvariants` ([invariants.ts](../../src/lib/pricing/invariants.ts)) is a pure function taking a `PricedCart`, so the workload can import its logic directly, but its single-`throw` shape must be split so a failure identifies which invariant broke. `Always` is the exact fit: `specs/01` AC 7 states these hold on every response. |
| **Antithesis Angle** | The engine is pure, so its arithmetic cannot break on its own — Vitest already proves that on fixed inputs. What Antithesis explores is the *inputs*: snapshots written by a racing add, a coupon row deleted between the `findMany` and the pricing call, quantities from a concurrent PATCH, `Cart.coupons` clobbered mid-flight. This property is the tripwire that catches any of those producing an internally inconsistent cart. |
| **Why It Matters** | These invariants encode the two most expensive defects in the project's own review table (`sut-analysis.md` §9, defects #1 and #2): shipping leaking into `discountTotalCents`, and per-line allocation drifting from the total. Both were spec-level fixes with no runtime enforcement on the API path. |

**Open Questions:**

- None.

---

### `money-fields-stay-exact` — Money arithmetic never leaves exact-integer range

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | Every money field in a `PricedCart` is a safe integer, and every intermediate product the engine computes stays below `Number.MAX_SAFE_INTEGER`. |
| **Invariant** | `Always`: assert `Number.isSafeInteger(v)` for `subtotalCents`, `discountTotalCents`, `shippingDiscountCents`, `shippingCents`, `taxCents`, `totalCents`, and every `lineSubtotalCents` / `lineDiscountCents` / `lineTotalCents` / `amountCents`. Paired with `priced-cart-invariants-hold`: if precision is lost, invariant 2 (`discountTotalCents === Σ lineDiscountCents`) is the one most likely to break, because `allocate` computes `amount * weights[i]`. |
| **Antithesis Angle** | `PATCH /api/cart/items` accepts any non-negative integer quantity ([items/route.ts:14](../../src/app/api/cart/items/route.ts#L14)) with no upper bound, on an **unauthenticated** endpoint. `POST /api/products` accepts any positive `priceCents` ([schemas.ts:23](../../src/lib/api/schemas.ts#L23)). `money.ts:18` states the assumption the code relies on — "base is cents (<= ~1e9 in any realistic cart)" — and nothing enforces it. Antithesis's value here is input-space exploration rather than fault timing; it reaches extreme values a hand-written test would not think to try, and combines them with a coupon set that forces allocation across many lines. |
| **Why It Matters** | Silent precision loss in money arithmetic is the failure mode the entire integer-cents design exists to prevent (top-level spec, cross-cutting rule 1). It is reachable by an unauthenticated shopper with one PATCH. |

**Open Questions:**

- Is there an intended upper bound on cart quantity or product price? Neither spec states one. `(needs human input)`

---

### `applying-coupon-never-raises-total` — Entering a valid code never costs the shopper more

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P0 |
| **Property** | For a fixed set of cart items, the total after applying an additional valid coupon code is less than or equal to the total before applying it. |
| **Invariant** | `Always`: the workload captures `totalCents` from a `GET /api/cart`, issues `POST /api/cart/coupons`, and asserts the returned `totalCents <= the captured total`, provided no other operation touched that cart in between. `Always` because `specs/01` §5.3 states this as an unconditional consequence of the N+1 winner selection — "the shopper is never penalised." |
| **Antithesis Angle** | The N+1 winner selection ([engine.ts:256-266](../../src/lib/pricing/engine.ts#L256-L266)) is the fix for spec defect #3, where an exclusive coupon won unconditionally and could charge $8.10 more. Antithesis explores the interaction the fix does not obviously cover: a concurrent quantity change moving the cart across `minSubtotalCents` or the free-shipping threshold between the two observations, and a concurrent admin coupon edit changing a candidate's terms mid-pass. Both make the "fixed set of cart items" precondition contested, which is exactly why the workload must serialize its own operations on a given cart for this check. |
| **Why It Matters** | This is the guarantee the project explicitly re-architected to obtain. A regression is a shopper paying more for entering a valid code — the original defect, restored. |

**Open Questions:**

- Does an admin coupon edit landing between the two observations void the guarantee or violate it? The specs address coupon *deletion* mid-session (`specs/02` §5) but not coupon *edits*. `(partial: the shopper-concurrency half is resolved — the scope decision means one shopper per cart, so the workload's own serialization is sufficient; only the admin-edit case remains)`

---

### `persisted-coupons-match-discount-lines` — `Cart.coupons` holds exactly what applied

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P0 |
| **Property** | On every cart response, the set of codes persisted in `Cart.coupons` equals the set of `couponCode` values in `discountLines`. |
| **Invariant** | `Always`: because `Cart.coupons` is not exposed in the API shape, the workload checks the observable consequence — issue a second `GET /api/cart` with no intervening mutation and assert the two responses have identical `discountLines` code sets. A divergence means the first pass persisted something other than what it applied. `Always` fits: `specs/01` §5.6 states this as an exact equality that holds after every pass. |
| **Antithesis Angle** | Two writers touch `Cart.coupons`: `priceAndPrune` ([cart.ts:117-124](../../src/lib/cart.ts#L117-L124)) and `DELETE /api/cart/coupons`, which writes the filtered list directly *before* calling `priceAndPrune` ([coupons/route.ts:35-38](../../src/app/api/cart/coupons/route.ts#L35-L38)). Neither is transactional, and — importantly under the narrowed scope — **a single coupon-removal request performs both writes on its own**, so this property needs no concurrency at all to be meaningful. Antithesis adds value on top by interleaving admin coupon mutations and quantity changes around it. |
| **Why It Matters** | `specs/03` §4.1 builds the entire toast-notification design on this equality: because a coupon that stops qualifying is *pruned* rather than left in `rejectedCoupons`, the UI can safely fire a warning toast on any rejection. If the equality breaks, the shopper gets spurious warnings on every quantity click, or a chip for a discount they are not receiving. |

**Open Questions:**

- Is there a stronger, directly observable check than the two-GET comparison — e.g. an admin or debug endpoint exposing `Cart.coupons`? `(partial: no such endpoint exists at this commit; adding one is SUT-side instrumentation the workload would benefit from)`

---

### `coupon-removal-is-reversible` — Applying then removing a coupon does not leave the shopper worse off

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | For a fixed cart, the total after applying coupon X and then removing X is less than or equal to the total before X was applied. |
| **Invariant** | `Always`: capture `totalCents`, `POST` the coupon, `DELETE` the coupon, assert the final `totalCents <= the captured total`. `Always` rather than `Sometimes` because it is a claim about every apply/remove pair, and a single violation is a real shopper losing money by experimenting with a code. |
| **Antithesis Angle** | This tests claim S8 (`sut-analysis.md` §5): `specs/01` §5.6 argues "nothing of value was lost at eviction time" because supersession only happens at a strictly lower total. That argument covers the eviction instant, not the sequence. Apply stackables, apply a better exclusive (stackables are pruned from `Cart.coupons`), remove the exclusive — the stackables are gone and the cart sits above where it started. Antithesis reaches the interesting variants by discovering which coupon combinations in the seeded/staged set actually trigger supersession, and by interleaving the sequence with quantity changes that move the winner. |
| **Why It Matters** | Path-dependent pricing state that a shopper cannot see or undo. Whether it is a defect or an accepted design consequence is a product judgment — but the spec asserts the stronger claim, so the property tests the claim as written. |

**Open Questions:**

- Is the documented supersession behavior intended to survive removal of the superseding coupon, or is re-entering the pruned codes the accepted UX? The spec records the consequence but does not state which is intended. `(needs human input)`

---

### `price-snapshot-immutable` — A cart line's unit price never changes after the line is created

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | Once a `CartItem` exists, its `unitPriceCents` as reported in `PricedCart.items` never changes, regardless of admin edits to the product's price. |
| **Invariant** | `Always`: the workload records `unitPriceCents` per `(cart, product)` on first observation and asserts every later observation matches. |
| **Antithesis Angle** | Two windows. First, the snapshot is captured from a `product.findUnique` at [items/route.ts:23](../../src/app/api/cart/items/route.ts#L23) and written at line 43 — a concurrent admin `PATCH` in between makes the captured price stale relative to the row, though either value is defensible. Second and more interesting: `docker/entrypoint.sh` re-runs the idempotent seed on **every** container start, which rewrites `Product.priceCents` for seeded products back to fixture values. Carts created before a restart keep snapshots of the admin-edited price. Antithesis with node-termination faults reaches this composition; nothing else does. **[needs node-termination]** for the restart variant. |
| **Why It Matters** | `specs/02` AC 10 states the guarantee directly: "Changing a product's price via `PATCH` does not alter the total of a cart that already contains it." It is also what makes the Playwright fixtures stable (`specs/01` §4.1), so a regression destabilizes the existing test suite as well. |

**Open Questions:**

- Should the snapshot be captured inside a transaction with the item create, so it cannot be stale relative to the row it was read from? `(partial: window confirmed in code; whether the staleness is user-visible depends on whether either price is "correct", which the spec does not settle)`

---

## C. Admin writes against live carts

Slice 2's admin API mutates the catalog and coupon set that live carts are
priced against. The specs make three all-or-nothing / no-breakage claims here
(S10, S11, and the §5.6 prune rule applied to deletion), none of which is
enforced under concurrent access.

### `bulk-product-create-atomic` — Bulk product creation is all-or-nothing and never 5xx

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | `POST /api/products/bulk` either creates every row in the batch and returns 201 with `created === N`, or creates zero rows and returns a structured 4xx. It never returns 5xx and never creates a partial batch. |
| **Invariant** | `Always`: assert `status !== 5xx`, and that the catalog's product count after the call changed by exactly `N` (on 201) or exactly `0` (on 4xx). |
| **Antithesis Angle** | `uniqueSlug` resolves each slug with a `while (await findUnique(...))` loop that reserves nothing ([product-payload.ts:57-66](../../src/lib/api/product-payload.ts#L57-L66)), and the bulk route calls it in a loop *before* opening the transaction ([bulk/route.ts:33-41](../../src/app/api/products/bulk/route.ts#L33-L41)). Two rows in one batch with the same `name` therefore receive the same slug, the `$transaction` fails on `slug @unique`, and P2002 escapes as a 500 — not the documented 400. The same hole opens between concurrent single creates. Note the asymmetry that makes this high-confidence: the *coupon* bulk route explicitly checks `duplicatesInBatch` ([coupons/bulk/route.ts:30-35](../../src/app/api/coupons/bulk/route.ts#L30-L35)); the product route has no equivalent. Antithesis reaches it by generating batches from a bounded name pool — which is exactly what `staging/product-names.json` provides. |
| **Why It Matters** | `specs/02` §4 and AC 1 state all-or-nothing explicitly, and `specs/02` §6 lists 400 as the response for validation failure. Spec defect #10 was this same slug-collision class, fixed for the *staging script* but not in the endpoint the script calls. |

**Open Questions:**

- None.

---

### `product-delete-cascades-cleanly` — Deleting a product in a live cart leaves a valid cart

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | Deleting a product that sits in one or more live carts returns 200, and every affected cart's next response is a valid `PricedCart` with the product absent and all invariants intact. |
| **Invariant** | `Always`: assert the delete returns 200 (not 5xx), then assert the affected cart's next `PricedCart` satisfies the §5.2 invariants and contains no line for the deleted product. |
| **Antithesis Angle** | `CartItem.product` carries `onDelete: Cascade` ([schema.prisma:84](../../prisma/schema.prisma#L84)), added specifically to fix spec defect #4. The interesting window is the other direction: `POST /api/cart/items` reads the product at [items/route.ts:23](../../src/app/api/cart/items/route.ts#L23) and creates the `CartItem` at line 38, and a delete landing in between makes the create violate the foreign key (P2003) with no `try`/`catch` to convert it. Antithesis interleaves the staging script's `--reset` path (`DELETE /api/products?all=true`) with active shopping. |
| **Why It Matters** | `specs/02` AC 6 requires the delete to succeed for a product currently in a cart. The `--reset` flow is documented as the thing you run "right after a demo" — i.e. exactly when carts are populated. |

**Open Questions:**

- None.

---

### `coupon-mutation-leaves-cart-consistent` — Deleting or deactivating an applied coupon degrades cleanly

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | When a coupon currently applied to a live cart is deleted, deactivated, or edited, the cart's next response is a valid `PricedCart` whose `discountLines` and totals are mutually consistent, and no `rejectedCoupons` entry appears for a code the shopper did not just submit. |
| **Invariant** | `Always`: assert the §5.2 invariants hold, and that `rejectedCoupons` is empty on any response to a request that was not a `POST /api/cart/coupons`. The second half is the sharp part — `specs/03` §4.1 states `rejectedCoupons` means exactly one thing, and the UI fires a warning toast on it. |
| **Antithesis Angle** | `priceAndPrune` reads coupon rows ([cart.ts:98-100](../../src/lib/cart.ts#L98-L100)) and prices from them; an admin `DELETE /api/coupons/[id]` or `PATCH` setting `active: false` landing between the read and a subsequent pass changes the answer. `specs/02` §5 claims this needs "no special case for deletion" because §5.6's prune covers it. Antithesis tests that claim by mutating coupons while carts hold them. **[needs clock-jitter]** for the `startsAt`/`endsAt` variant: `priceCart` compares against `new Date()` at [engine.ts:242](../../src/lib/pricing/engine.ts#L242), the SUT's only clock dependency, so a clock jump can expire an applied coupon mid-session. |
| **Why It Matters** | A false `rejectedCoupons` entry produces a warning toast the shopper did not ask for — the exact failure `specs/03` §4.1 was written to prevent, and `specs/03` AC 6 tests for in the single-threaded case only. |

**Open Questions:**

- None.

---

### `catalog-read-never-shows-partial-batch` — Readers never observe a half-applied bulk write

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P2 |
| **Property** | `GET /api/products` issued concurrently with a `POST /api/products/bulk` returns either all of the batch's rows or none of them, never a strict subset. |
| **Invariant** | `Always`: the workload issues repeated catalog reads while a bulk create of a known, uniquely-identifiable batch is in flight, and asserts the observed count of that batch's slugs is `0` or `N`, never in between. |
| **Antithesis Angle** | This is the reader-side half of the all-or-nothing claim in S10. `prisma.$transaction` with an array of creates gives the writer atomicity, but SQLite's default journal mode (no WAL configured anywhere — `sut-analysis.md` §3) determines what concurrent readers see. Antithesis's contribution is the interleaving: getting a read to land mid-transaction requires timing the writer's window, which node throttling widens. Added during evaluation gap-filling — the catalog covered the writer's view of atomicity but not the reader's. |
| **Why It Matters** | A shopper browsing during a staging run sees a catalog that flickers, and the recommendation module — which loads the whole active catalog per call — computes against a moving target. |

**Open Questions:**

- Does the SQLite journal mode in use actually permit a reader to observe an in-progress transaction, or does the default rollback journal already prevent it? If prevented, this property is vacuous and should be dropped. `(partial: no WAL or journal_mode setting exists anywhere in the repo, so the SQLite default applies; the default's exact isolation behavior under Prisma's connection handling was not confirmed from code)`

---

## D. Durability and lifecycle

### `acked-cart-mutations-survive-restart` — 200-acknowledged cart changes are durable

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 · **[needs node-termination]** |
| **Property** | Every cart mutation that returned 200 is still reflected in the cart after the container is crash-killed and restarted. |
| **Invariant** | `Always`: the workload maintains an expected cart model, and after a restart asserts the recovered `PricedCart` contains every acknowledged item at the acknowledged quantity. |
| **Antithesis Angle** | Requires node-termination faults, which are commonly disabled by default. It also requires `/data` to be a durable volume — Antithesis-restarted containers "may lose non-durable filesystem state," which would make the property vacuously false for reasons unrelated to the SUT. Confirm both before relying on this. The genuine SUT-side question is whether SQLite's default durability settings (no WAL, no explicit synchronous pragma) preserve a committed write across a crash-kill. |
| **Why It Matters** | The `/data` volume exists so "the DB persists across restarts" (`specs/01` §10), and `specs/02` AC 4 requires products and images to survive a restart. Carts are the state the shopper actually cares about and the only one the specs do not name in a restart criterion. |

**Open Questions:**

- Is `/data` mounted as a durable volume in the planned Antithesis environment? If not, this property tests the harness rather than the SUT. `(needs human input)`
- Are node-termination faults enabled for this tenant? `(needs human input)`

---

### `startup-crash-never-bricks-container` — A crash during startup is recoverable

| | |
|---|---|
| **Type** | Liveness |
| **Priority** | P1 · **[needs node-termination]** |
| **Property** | After a crash at any point during `entrypoint.sh`, a subsequent start eventually reaches a serving state. |
| **Invariant** | `Sometimes(container reached a serving state after a start that followed an interrupted startup)`. `Sometimes` is the right type: this is a progress property whose precondition (a crash landing inside the startup window, which is short) is not reachable on every timeline. Pair it with a `Reachable` marker for "startup was interrupted" so a run where the precondition never occurred is distinguishable from one where recovery failed. |
| **Antithesis Angle** | `entrypoint.sh` runs `set -e`, then `prisma migrate deploy`, then `prisma db seed`, then `exec node server.js`. An interrupted `migrate deploy` leaves a `_prisma_migrations` row with a null `finished_at`; Prisma then refuses to proceed on subsequent runs rather than retrying, so the container fails to start *every time thereafter*. That is a permanent, self-inflicted outage from a transient fault — the exact shape Antithesis's node-termination faults are built to find. The seed half is safer (idempotent upserts) but is also not transactional. |
| **Why It Matters** | `specs/01` AC 1 requires `docker run` to produce a working app with no network access at start. A container that bricks itself on an unlucky kill fails that criterion in a way no existing test would catch — the persistence smoke test in `specs/02` §11 is marked optional and does not exist. |

**Open Questions:**

- Does the migration in `prisma/migrations/20260801050207_init` complete fast enough that the interruption window is negligible in practice? `(partial: single init migration, so the window is small — but it is exactly the window Antithesis is good at hitting, and the consequence is permanent)`
- Are node-termination faults enabled for this tenant? `(needs human input)`

---

### `cart-eventually-readable` — The cart is readable again once faults subside

| | |
|---|---|
| **Type** | Liveness |
| **Priority** | P1 |
| **Property** | After a quiet period, `GET /api/cart` returns 200 with a `PricedCart` satisfying all §5.2 invariants, for every cart the workload created. |
| **Invariant** | `Sometimes(every tracked cart returned a valid PricedCart during the quiet period)`. `Sometimes` because this is a progress condition that needs faults paused to be meaningful — during active fault injection a failed read is expected, not a violation. |
| **Antithesis Angle** | Use `ANTITHESIS_STOP_FAULTS` for a mid-run recovery check so the timeline continues afterward, rather than an `eventually_` command which terminates the branch. The system has no retry, no backoff, and no circuit breaker anywhere (`sut-analysis.md` §6), so recovery depends entirely on the fault clearing and SQLite releasing its lock. The failure this catches is a stuck state that outlives the fault — a wedged write lock, an exhausted connection pool, or a cart left in a shape that makes every subsequent pricing pass throw. |
| **Why It Matters** | Distinguishes "degraded during a fault" (acceptable) from "permanently broken by a fault" (not). With no error handling on any cart path, the second is a live possibility. |

**Open Questions:**

- None.

---

## E. Failure surface

### `cart-endpoints-never-unhandled-500` — Cart endpoints always return a structured response

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P1 |
| **Property** | Every response from `/api/cart`, `/api/cart/items`, and `/api/cart/coupons` is either a 2xx with a valid `PricedCart` or a 4xx with the documented `{ error: { message, code } }` shape. Never a 5xx, and never a 2xx with a malformed body. |
| **Invariant** | Three separate `Always` assertions, one per endpoint family, each with a distinct message naming the endpoint and carrying the observed status — not one shared assertion across all three, so a failure identifies the route. This complements `cart-item-create-no-unique-violation`, which targets one specific 500 cause; this property is the catch-all for the rest. |
| **Antithesis Angle** | No cart route has error handling (`sut-analysis.md` §6), so P2002, P2003, P2025 and raw `SQLITE_BUSY` all escape as unstructured 500s. Under the narrowed scope the in-scope causes are P2003 and P2025 (admin deletes racing a shopper request) and `SQLITE_BUSY`. The last is the one this property is really aimed at, and it does not need a second shopper: no WAL mode and no busy timeout are configured anywhere, while one shopper's own click produces one write plus several more write-locking `GET /api/cart` calls via the double `notifyCartUpdated()` and the badge listener (`sut-analysis.md` §4). Node throttling and CPU modulation lengthen every lock hold; the app's own write amplification supplies the contention. |
| **Why It Matters** | `specs/01` §7.3 and `specs/02` §6 enumerate the response codes this API is allowed to return, and 500 is not among them. Every 500 becomes a generic "Something went wrong" toast with no path forward for the shopper. |

**Open Questions:**

- None.

---

## F. Reachability and search guidance

These exist to tell Antithesis which parts of the pricing state space the
workload actually reached. They are cheap, and without them a clean run is
ambiguous between "no bugs" and "the interesting branches never executed."

### `exclusive-coupon-wins-observed` — The N+1 winner selection actually picks an exclusive set

| | |
|---|---|
| **Type** | Reachability |
| **Priority** | P2 |
| **Property** | At least once per run, a cart is priced with a non-stackable coupon set winning over the stackable set. |
| **Invariant** | `Reachable("exclusive coupon set won the N+1 selection")` — detected from the workload by observing a `PricedCart` whose `discountLines` contain exactly one code that the workload knows is non-stackable, while other eligible stackable codes were rejected with a supersession reason. `Reachable` rather than `Sometimes` because this is a pure "did we get here" marker with no additional semantic condition worth encoding. |
| **Antithesis Angle** | Confirms the workload constructed carts where the exclusive branch of [engine.ts:260-266](../../src/lib/pricing/engine.ts#L260-L266) is the winner — the branch spec defect #3 was created to fix. Without this marker, `applying-coupon-never-raises-total` passing may mean the branch was never exercised. |
| **Why It Matters** | Gates the credibility of the whole category B result set. |

**Open Questions:**

- None.

---

### `coupon-prune-path-observed` — The silent prune actually fires

| | |
|---|---|
| **Type** | Reachability |
| **Priority** | P2 |
| **Property** | At least once per run, a coupon is pruned from a cart as a side effect of a non-coupon operation. |
| **Invariant** | `Reachable("coupon pruned by a non-coupon cart mutation")` — the workload observes a coupon in `discountLines` before a quantity change and absent after, with empty `rejectedCoupons`. |
| **Antithesis Angle** | This is §5.6's central mechanism and the precondition for `persisted-coupons-match-discount-lines` and `coupon-removal-is-reversible` to mean anything. Reaching it requires the workload to drive a cart across a coupon's `minSubtotalCents` or the free-shipping threshold — so the marker also confirms the workload understands the seeded coupon set well enough to cross those boundaries. |
| **Why It Matters** | `specs/01` AC 9 and `specs/03` AC 6 both hinge on this path. If it never fires, the strongest properties in category B are vacuous. |

**Open Questions:**

- None.

---

### `allocation-remainder-distributed` — Largest-remainder leftover distribution is exercised

| | |
|---|---|
| **Type** | Reachability |
| **Priority** | P2 |
| **Property** | At least once per run, a discount is allocated across two or more lines where the floor shares do not sum to the whole and leftover pennies are distributed. |
| **Invariant** | `Reachable("largest-remainder leftover pennies distributed across 2+ lines")`. Observed from the workload by finding a `PricedCart` with ≥2 non-zero `lineDiscountCents` where `Σ floor(amount * weight / total) < amount`. |
| **Antithesis Angle** | Narrow. `allocate.test.ts` already includes a randomized sum-to-whole property test over this exact function, so this marker is not finding new arithmetic bugs — it confirms the *integration* path reaches multi-line allocation with real snapshots and real coupon combinations. Kept at P2 for that reason; see `evaluation/antithesis-fit.md`. |
| **Why It Matters** | Spec defect #2 (per-line allocation drift) lives here. The marker distinguishes "invariant 2 held" from "invariant 2 was never meaningfully tested". |

**Open Questions:**

- None.

---

## G. Resource boundaries

Added during evaluation gap-filling — the discovery passes concentrated on
correctness and left the system's two unbounded growth paths uncovered.

### `recommendations-stay-responsive` — Recommendations stay bounded as the catalog grows

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P2 |
| **Property** | `GET /api/recommendations` and `GET /api/products/[idOrSlug]/recommendations` return at most `limit` products, exclude every source product, contain no duplicates, and complete without error regardless of catalog size or CPU throttling. |
| **Invariant** | `Always`: assert `products.length <= limit`, no id appears twice, and no returned id is in `productIds`. Paired with a status-code check for the completion half. |
| **Antithesis Angle** | `recommendationsFor` issues `prisma.product.findMany({where: {active: true}})` — the entire active catalog, unpaginated, on every call ([recommend-service.ts:13](../../src/lib/recommend-service.ts#L13)). The cart page calls it on load and again on every cart change (`refreshOnCartChange`). Slice 2's staging script exists to make the catalog large, and the endpoint is unauthenticated. Under node throttling this becomes the slowest path in the system while also being the one the cart page hits most. Antithesis combines a large staged catalog with CPU limits and concurrent shoppers. |
| **Why It Matters** | `specs/03` §2.4 requires the bounded/no-duplicate/no-inactive guarantees, and Vitest covers them on small fixed catalogs. What is untested is the same code against a catalog the staging script produced, under load. |

**Open Questions:**

- Is there an intended maximum catalog size? The staging script defaults to 40 products but accepts any `--products` value. `(needs human input)`

---

### `cart-rows-bounded-by-distinct-clients` — Cart creation is bounded by distinct clients

| | |
|---|---|
| **Type** | Safety |
| **Priority** | P2 |
| **Property** | The number of `Cart` rows created over a run is bounded by the number of distinct cookie-less client sessions, not by the number of requests. |
| **Invariant** | `Always`: a workload client that holds its cookie jar correctly asserts it never receives a second, different `cartId` in a `Set-Cookie` after the first one was established. Complementary to `single-cart-per-session`, which covers the concurrent-first-contact race; this one covers steady-state cookie handling across the whole run. |
| **Antithesis Angle** | `GET /api/cart` creates a cart for any request without a valid cookie ([cart.ts:46](../../src/lib/cart.ts#L46)), and `specs/01` §7.4 states carts are never reaped. Any client that drops cookies — a crawler, a prefetch, a health check, or a client whose cookie was clobbered by the `single-cart-per-session` race — generates a row per request. Antithesis's contribution is duration and fault-driven cookie loss: a restart or a dropped response can strand a cookie and start the growth. |
| **Why It Matters** | Unbounded growth in the only table with no reaper, on the busiest unauthenticated endpoint, in a container whose database is a single file on a volume. The spec accepts unreaped carts as "cheap"; that reasoning assumes one row per shopper, which is the assumption this property checks. |

**Open Questions:**

- Is unbounded cart growth acceptable for the demo's intended lifetime, or should `GET /api/cart` avoid creating a row until the first mutation? `(needs human input)`

---

## Assumptions

- The workload runs against a single SUT container built from the repo's
  `Dockerfile`, with `ADMIN_API_KEY` set so admin paths are exercisable.
- Each virtual shopper in the workload owns its own cookie jar; concurrency
  between shoppers and within one shopper are both in scope.
- Properties are checked by the workload from the HTTP boundary unless an
  evidence file explicitly calls for SUT-side instrumentation.
- No Antithesis SDK assertion exists in the SUT today
  (`existing-assertions.md`), so every "add an assertion" note in an evidence
  file is a net-new addition.

## Open Questions

- Which fault types are enabled for this tenant? Node termination gates two
  properties and clock jitter gates one variant. `(needs human input)`
- Should the workload be permitted to create products with extreme
  `priceCents` values, or should `money-fields-stay-exact` be restricted to
  quantity-driven overflow only (which needs no admin key)? `(needs human input)`
