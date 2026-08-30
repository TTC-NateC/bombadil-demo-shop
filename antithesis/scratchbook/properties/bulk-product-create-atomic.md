# bulk-product-create-atomic

## What led here

`specs/02` §4 states the guarantee twice, in the endpoint description and again in
AC 1:

> "Validates every row; any invalid row returns `400` with per-index errors and
> creates **nothing** (all-or-nothing)."

The route implements the transaction correctly. What it does not implement is
slug uniqueness *within the batch* — and the coupon route right next to it does.
That asymmetry is what makes this high-confidence rather than speculative.

## Code paths

**`src/app/api/products/bulk/route.ts:33-47`:**

```
33   const prepared = []
34   for (const row of envelope.data.products) {
35     const { relatedIds, slug, ...rest } = row
36     prepared.push({
37       ...rest,
38       slug: await uniqueSlug(rest.name, slug),      // <-- reserves nothing
39       relatedIds: JSON.stringify(relatedIds ?? []),
40     })
41   }
43   const products = await prisma.$transaction(
44     prepared.map((data) => prisma.product.create({ data })),
45   )
```

**`src/lib/api/product-payload.ts:57-66`** — `uniqueSlug`:

```
58   const base = (preferred && slugify(preferred)) || slugify(name) || "product"
60   let candidate = base
61   let suffix = 2
62   while (await prisma.product.findUnique({ where: { slug: candidate }, ... })) {
63     candidate = `${base}-${suffix++}`
64   }
65   return candidate
```

The loop only checks rows that already exist in the database. Rows earlier in the
same `prepared` array have not been created yet, so they are invisible to it.
The returned slug is not reserved anywhere.

**The contrast — `src/app/api/coupons/bulk/route.ts:30-35`:**

```
30   const duplicatesInBatch = prepared
31     .map((c) => c.code)
32     .filter((code, index, all) => all.indexOf(code) !== index)
33   if (duplicatesInBatch.length) {
34     return apiError("CONFLICT", `Duplicate codes in batch: ...`)
35   }
```

The coupon route explicitly guards the in-batch case and returns a structured
409. The product route has no equivalent.

## Failure scenario

`POST /api/products/bulk` with two rows whose `name` slugifies identically —
`{name: "Matte Mug"}` twice, or `{name: "Matte Mug"}` and `{name: "matte  mug"}`
(`slugify` lowercases and collapses non-alphanumerics to `-`,
[schemas.ts:10-17](../../../src/lib/api/schemas.ts#L10-L17)):

| Step | What happens |
|---|---|
| 1 | Zod validates both rows — `newProductSchema` has no cross-row constraint. Passes. |
| 2 | `uniqueSlug("Matte Mug")` for row 1: no `matte-mug` in the DB → returns `matte-mug`. |
| 3 | `uniqueSlug("Matte Mug")` for row 2: still no `matte-mug` in the DB (row 1 isn't created yet) → returns `matte-mug`. |
| 4 | `$transaction` creates both. The second violates `slug @unique` ([schema.prisma:19](../../../prisma/schema.prisma#L19)). |
| 5 | Prisma raises P2002. No `try`/`catch` in the route. Next returns a **500**. |

The transaction does roll back, so the "creates nothing" half of the guarantee
survives. The "returns 400" half does not — and `specs/02` §6 lists the permitted
codes as 200/201/400/401/404/409/413/415.

## Why the workload reaches this easily

`staging/product-names.json` is a bounded pool that the staging script samples
from with replacement, and `composeName` prefixes an adjective only "roughly
half" the time ([generate.ts:63-68](../../../src/lib/staging/generate.ts#L63-L68)).
Duplicate names within a batch are the expected case, not an edge case.

Note that the *staging script* avoids this: it calls `makeSlugFactory`
([generate.ts:94-104](../../../src/lib/staging/generate.ts#L94-L104)), which
maintains a `used` Set and does reserve slugs, and it creates products one at a
time via `POST /api/products` rather than the bulk endpoint. So the fix for spec
defect #10 was applied to the client and not to the endpoint. A workload driving
`/api/products/bulk` directly — which `specs/02` AC 1 requires to work — hits
what the staging script routes around.

## The concurrent variant

The same hole opens between two concurrent `POST /api/products` requests, or
between two concurrent bulk requests: both run the `while` loop, both see the
slug free, both return it, both create. Antithesis reaches this without needing
duplicate names in a single batch.

## What goes wrong

An admin bulk import fails with an unstructured 500 instead of the documented
400-with-per-index-errors, so tooling cannot tell a duplicate-name batch from a
server fault. `specs/02` AC 1 fails. Spec defect #10 was this exact class of bug,
fixed in one place and not the other.

## Instrumentation

Cross-referenced against `existing-assertions.md`: **nothing exists**.

- **Missing, workload-side:** `Always(status !== 5xx)` on `/api/products/bulk`,
  plus a catalog count taken before and after, asserted to have changed by
  exactly `N` (on 201) or exactly `0` (otherwise).
- **Missing, SUT-side:** none needed — the failure is fully visible in the
  response status.

## Open questions

None. The mechanism is directly readable from the code, the divergence from the
documented response code is stated in `specs/02` §4 and §6, and the coupon
route's explicit in-batch guard confirms the check was considered necessary for
one entity and omitted for the other.
