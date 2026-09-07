/** @jest-environment node */
/**
 * Estate scope — the pure pieces, no database.
 *
 * Pins the two guarantees that keep this safe: the keyword SQL gains an
 * `estate = ANY(...)` predicate ONLY when a scope is asked for (so the default
 * is byte-for-byte today's query), and the semantic-side lookup fails CLOSED —
 * a thrown DB error returns an empty scope, never an unfiltered one, because a
 * scope that silently fell back to "everything" would leak the other clients.
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { buildKeywordSearchSql } from "@/lib/brain/repo";
import { documentIdsInEstates } from "@/lib/brain/estate-scope";

describe("buildKeywordSearchSql — estate predicate", () => {
  it("adds no estate predicate by default (unchanged behavior)", () => {
    const { sql } = buildKeywordSearchSql(10, {});
    expect(sql).not.toContain("bd.estate = ANY");
  });

  it("adds no estate predicate for an empty estates list", () => {
    const { sql } = buildKeywordSearchSql(10, { estates: [] });
    expect(sql).not.toContain("bd.estate = ANY");
  });

  it("adds the estate predicate and binds the estates when scoped", () => {
    const { sql, args } = buildKeywordSearchSql(10, { estates: ["pcna"] });
    expect(sql).toContain("bd.estate = ANY");
    expect(args).toContainEqual(["pcna"]);
  });

  it("composes with the audience predicate (both present)", () => {
    const { sql } = buildKeywordSearchSql(10, { role: "sales", estates: ["pcna"] });
    expect(sql).toContain("bd.estate = ANY");
    expect(sql).toContain("audience_roles"); // role filter still there
  });
});

describe("documentIdsInEstates — fails closed", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns the matching ids on success", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }] });
    const out = await documentIdsInEstates(["a", "b", "c"], ["pcna"]);
    expect(out).toEqual(new Set(["a", "b"]));
  });

  it("returns empty (not everything) when the lookup throws", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const out = await documentIdsInEstates(["a", "b"], ["pcna"]);
    expect(out.size).toBe(0);
  });

  it("short-circuits with no ids or no estates (no query)", async () => {
    expect((await documentIdsInEstates([], ["pcna"])).size).toBe(0);
    expect((await documentIdsInEstates(["a"], [])).size).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
