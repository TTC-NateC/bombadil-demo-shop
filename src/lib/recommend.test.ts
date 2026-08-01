/**
 * Phase 11 task 11.1 — the full specs/03 §2.4 set.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  parseLimit,
  parseRelatedIds,
  recommend,
  type RecommendableProduct,
} from "./recommend";

interface P extends RecommendableProduct {
  name: string;
}

function product(id: string, over: Partial<P> = {}): P {
  return {
    id,
    name: over.name ?? id,
    category: over.category ?? null,
    relatedIds: over.relatedIds ?? [],
    createdAt: over.createdAt ?? new Date("2026-01-01"),
  };
}

const ids = (products: P[]) => products.map((p) => p.id);

describe("layer 1 — manual overrides", () => {
  it("honours relatedIds and orders them first, in the order listed", () => {
    const catalog = [
      product("a", { category: "X", relatedIds: ["d", "c"] }),
      product("b", { category: "X" }),
      product("c", { category: "Y" }),
      product("d", { category: "Y" }),
    ];

    // d and c are curated, so they beat b (which only matches on category).
    expect(ids(recommend({ sourceProductIds: ["a"], catalog, limit: 4 }))).toEqual(["d", "c", "b"]);
  });

  it("ignores relatedIds pointing at products that no longer exist", () => {
    const catalog = [product("a", { relatedIds: ["ghost", "b"] }), product("b")];
    expect(ids(recommend({ sourceProductIds: ["a"], catalog, limit: 4 }))).toEqual(["b"]);
  });
});

describe("layer 2 — same category", () => {
  it("fills from the category and excludes the source", () => {
    const catalog = [
      product("a", { category: "X" }),
      product("b", { category: "X" }),
      product("c", { category: "X" }),
      product("d", { category: "Y" }),
    ];

    const result = ids(recommend({ sourceProductIds: ["a"], catalog, limit: 2 }));
    expect(result).toEqual(["b", "c"]);
    expect(result).not.toContain("a");
  });
});

describe("layer 3 — fallback", () => {
  it("triggers when the category yields too few, newest first", () => {
    const catalog = [
      product("a", { category: "X" }),
      product("b", { category: "X" }),
      product("old", { category: "Y", createdAt: new Date("2020-01-01") }),
      product("new", { category: "Y", createdAt: new Date("2026-06-01") }),
    ];

    // b is the only same-category peer; the rest come from the fallback, newest
    // first, so the section is never empty.
    expect(ids(recommend({ sourceProductIds: ["a"], catalog, limit: 3 }))).toEqual([
      "b",
      "new",
      "old",
    ]);
  });

  it("returns something even with no categories and no relatedIds anywhere", () => {
    const catalog = [product("a"), product("b"), product("c")];
    expect(recommend({ sourceProductIds: ["a"], catalog, limit: 4 })).toHaveLength(2);
  });
});

describe("cart aggregation", () => {
  it("excludes everything already in the cart", () => {
    const catalog = [
      product("a", { category: "X" }),
      product("b", { category: "X" }),
      product("c", { category: "X" }),
    ];

    const result = ids(recommend({ sourceProductIds: ["a", "b"], catalog, limit: 4 }));
    expect(result).toEqual(["c"]);
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });

  it("ranks items recommended by multiple cart items first", () => {
    const catalog = [
      product("cart1", { relatedIds: ["shared", "only1"] }),
      product("cart2", { relatedIds: ["shared", "only2"] }),
      product("shared"),
      product("only1"),
      product("only2"),
    ];

    // `shared` is hit twice, so it leads regardless of listing order.
    expect(ids(recommend({ sourceProductIds: ["cart1", "cart2"], catalog, limit: 3 }))[0]).toBe(
      "shared",
    );
  });
});

describe("guarantees", () => {
  const catalog = [
    product("a", { category: "X", relatedIds: ["b", "c"] }),
    product("b", { category: "X" }),
    product("c", { category: "Y" }),
    product("d", { category: "X" }),
    product("e", { category: "Y" }),
  ];

  it("never returns more than limit", () => {
    for (const limit of [1, 2, 3, 4, 10]) {
      expect(recommend({ sourceProductIds: ["a"], catalog, limit }).length).toBeLessThanOrEqual(
        limit,
      );
    }
  });

  it("never returns duplicates", () => {
    const result = ids(recommend({ sourceProductIds: ["a"], catalog, limit: 10 }));
    expect(new Set(result).size).toBe(result.length);
  });

  it("never returns the source products", () => {
    const result = ids(recommend({ sourceProductIds: ["a", "b"], catalog, limit: 10 }));
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
  });

  it("returns an empty list for limit 0 and for an unknown source", () => {
    expect(recommend({ sourceProductIds: ["a"], catalog, limit: 0 })).toEqual([]);
    expect(ids(recommend({ sourceProductIds: ["ghost"], catalog, limit: 4 }))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("is deterministic across 100 shuffled catalog inputs", () => {
    const expected = ids(recommend({ sourceProductIds: ["a"], catalog, limit: 4 }));

    let seed = 1234;
    for (let i = 0; i < 100; i++) {
      const shuffled = [...catalog];
      for (let j = shuffled.length - 1; j > 0; j--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const k = seed % (j + 1);
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      expect(ids(recommend({ sourceProductIds: ["a"], catalog: shuffled, limit: 4 }))).toEqual(
        expected,
      );
    }
  });
});

describe("parseLimit", () => {
  it("defaults when the parameter is absent or blank", () => {
    // Number(null) is 0, not NaN — a Number.isFinite guard alone would turn
    // "no limit supplied" into "return nothing", which is exactly the bug that
    // made every recommendation strip render empty.
    expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit("")).toBe(DEFAULT_LIMIT);
    expect(parseLimit("   ")).toBe(DEFAULT_LIMIT);
  });

  it("defaults on garbage", () => {
    expect(parseLimit("many")).toBe(DEFAULT_LIMIT);
    expect(parseLimit("NaN")).toBe(DEFAULT_LIMIT);
  });

  it("honours an explicit value, including an explicit zero", () => {
    expect(parseLimit("2")).toBe(2);
    expect(parseLimit("0")).toBe(0);
  });

  it("clamps to a sane range", () => {
    expect(parseLimit("-5")).toBe(0);
    expect(parseLimit("9999")).toBe(24);
    expect(parseLimit("3.7")).toBe(3);
  });
});

describe("parseRelatedIds", () => {
  it("parses a JSON array of strings", () => {
    expect(parseRelatedIds('["a","b"]')).toEqual(["a", "b"]);
  });

  it("returns an empty array for anything malformed", () => {
    expect(parseRelatedIds("[]")).toEqual([]);
    expect(parseRelatedIds("not json")).toEqual([]);
    expect(parseRelatedIds('{"a":1}')).toEqual([]);
    expect(parseRelatedIds('["a", 5, null]')).toEqual(["a"]);
  });
});
