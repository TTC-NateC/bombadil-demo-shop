# recommendations-stay-responsive

## What led here

Added during evaluation gap-filling, from the Coverage Balance lens
(`evaluation/coverage-balance.md`, finding CB-1).

The discovery passes concentrated on cart and pricing correctness and produced no
property touching the recommendations subsystem at all. That is a component blind
spot, and it happens to sit on the system's only unbounded query.

## Code paths

**`src/lib/recommend-service.ts:12-30`:**

```
12   export async function recommendationsFor(sourceProductIds: string[], limit: number) {
13     const catalog = await prisma.product.findMany({ where: { active: true } })
15     const recommended = recommend({
16       sourceProductIds, limit,
17       catalog: catalog.map((product) => ({
18         ...product,
19         relatedIds: parseRelatedIds(product.relatedIds),
20       })),
21     })
```

Line 13 loads **the entire active catalog**, unpaginated, on every call. Line 17
then maps every row and `JSON.parse`s every `relatedIds` column
([recommend.ts:130-137](../../../src/lib/recommend.ts#L130-L137)).

**`src/lib/recommend.ts:51-110`** — the pure ranking then does more full passes
over the catalog:

```
80     const stableCatalog = [...input.catalog].sort((a, b) => a.id.localeCompare(b.id))
91     const fallback = [...input.catalog]
92       .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
```

Two full copies and two full sorts per request, plus a `sources.filter(...)`
inside the loop at [recommend.ts:84](../../../src/lib/recommend.ts#L84) — that
one is O(sources × catalog).

**Call frequency — `src/app/cart/page.tsx:300-304`:**

```
300   <RecommendationStrip
301     endpoint={`/api/recommendations?productIds=${encodeURIComponent(cartProductIds)}`}
302     title="Add to your order"
303     refreshOnCartChange
304   />
```

So it runs on every cart page load and again on every cart mutation. Combined
with the `CartBadge` refresh amplification described in `sut-analysis.md` §4,
a single "add to cart" click produces several of these.

**Catalog size is operator-controlled.** Slice 2 exists to make the catalog large:
`scripts/stage-data.ts` defaults to 40 products but accepts any `--products`
value ([stage-data.ts:51](../../../scripts/stage-data.ts#L51)), and `specs/02` §1
describes the goal as filling an instance with "a large, varied, randomized
catalog."

**Both endpoints are unauthenticated.** `specs/03` §2.3: "Both are public — no
admin key."

## The guarantees being checked

`specs/03` §2.4 requires the recommendation module to "never return more than
`limit`; never return duplicates; never return inactive products," and §2.1
requires the section to be "never empty" thanks to the layer-3 fallback.

Vitest covers all of these on small fixed catalogs
(`src/lib/recommend.test.ts`). What is untested is the same code against a
catalog the staging script produced, under CPU throttling, with concurrent
shoppers.

## Failure scenario

1. Workload stages a large catalog via the admin API.
2. Several virtual shoppers hold carts and mutate them continuously; each
   mutation fires recommendation requests.
3. Antithesis applies node throttling.
4. Violations to watch for: a response exceeding `limit`; a duplicate id; a
   source product appearing in its own recommendations; a non-2xx status; or a
   request that never completes within the workload's timeout.

The `limit` and duplicate checks are cheap and unlikely to fail given the Vitest
coverage. The completion check is the substantive one — this is the slowest path
in the system on the page the shopper interacts with most, and it has no
pagination, no caching (`specs/01` §7.5 relies on Next 15 not caching route
handler GETs), and no timeout.

## Interaction with `catalog-read-never-shows-partial-batch`

Both properties involve a reader of the full catalog racing a bulk write. They
differ in what they assert: that property checks *which rows* the reader sees,
this one checks whether the reader completes and stays within its contract. A
staging run driving a large `--products` value exercises both at once, so the
workload can share the setup.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** on every recommendations response, `Always` assert
  `products.length <= limit`, no duplicate ids, and no returned id present in the
  request's `productIds`. Separately assert the response status is 2xx.
- **Missing, SUT-side (optional):** an assertion at
  [recommend-service.ts:13](../../../src/lib/recommend-service.ts#L13) recording
  the catalog row count actually loaded. From outside, a response of 4 products
  looks identical whether it was computed over 40 rows or 40,000 — and the row
  count is the variable this property is actually about.

## Open questions

- **Is there an intended maximum catalog size?** If one exists, the property
  gains a concrete bound to check and the endpoint arguably needs pagination or a
  cap. If not, `recommendationsFor` is unbounded by design on an unauthenticated
  endpoint, and the completion half of this property is the only thing standing
  between the demo and a catalog large enough to make the cart page unusable.

### Investigation Log

#### Is there an intended maximum catalog size?

- Examined: `specs/02` §9.1 (staging invocation and defaults), §9.3 (product
  generation), §10 AC 7 (`--products` count criterion), `specs/03` §2 (the whole
  recommendations section), `scripts/stage-data.ts:36-58` (`parseArgs`),
  `src/lib/recommend-service.ts`, `src/app/api/recommendations/route.ts`,
  `src/app/api/products/[idOrSlug]/recommendations/route.ts`,
  `src/lib/recommend.ts:112-127` (`parseLimit`, `MAX_LIMIT = 24`).
- Found: `parseLimit` caps the *response* size at 24
  ([recommend.ts:113](../../../src/lib/recommend.ts#L113)) — so the output is
  bounded. The *input* is not: `findMany` has no `take`, and `--products` accepts
  any number. `specs/02` §9.1 gives 40 as a default and describes the goal as "a
  large ... catalog" without naming a ceiling. `GET /api/products` is likewise
  unpaginated ([products/route.ts:12-15](../../../src/app/api/products/route.ts#L12-L15)).
- Not found: any spec statement of a maximum catalog size, any pagination on any
  list endpoint, and any performance budget for the recommendations path.
- Conclusion: tagged `(needs human input)`. The output cap is settled at 24; the
  input is genuinely unbounded and no document says what size the system is meant
  to handle. Choosing a number is a product decision.
