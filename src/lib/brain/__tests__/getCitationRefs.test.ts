/**
 * Brain repo: getCitationRefs.
 *
 * Used by the chat layer to convert [ref:<id>] citation markers into
 * clickable Sources links. Must:
 *   - return rows in input order
 *   - silently skip ids that don't exist (citation validator already
 *     stripped invented refs by the time we get here, but defensive)
 *   - return empty when input is empty (avoid noise SQL)
 */

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: any[]) => mockQuery(...a) }));

import { getCitationRefs } from "@/lib/brain/repo";

beforeEach(() => mockQuery.mockReset());

describe("getCitationRefs", () => {
  test("returns empty array and skips SQL when input is empty", async () => {
    const out = await getCitationRefs([]);
    expect(out).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("preserves input order so Sources footer numbering matches answer order", async () => {
    /* DB row order is unpredictable; the function must reorder. */
    mockQuery.mockResolvedValue({
      rows: [
        { id: "B", filename: "second.pdf", web_url: "https://x/b" },
        { id: "A", filename: "first.pdf", web_url: "https://x/a" },
        { id: "C", filename: "third.pdf", web_url: null },
      ],
    });
    const out = await getCitationRefs(["A", "B", "C"]);
    expect(out.map((r) => r.id)).toEqual(["A", "B", "C"]);
    expect(out[0].filename).toBe("first.pdf");
    expect(out[1].web_url).toBe("https://x/b");
    expect(out[2].web_url).toBeNull();
  });

  test("silently drops ids not present in the DB (no holes in output)", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: "A", filename: "real.pdf", web_url: "https://x/a" },
      ],
    });
    const out = await getCitationRefs(["A", "MISSING"]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("A");
  });

  test("issues a single batch query with id = ANY array (not N round trips)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await getCitationRefs(["A", "B", "C", "D"]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/id = ANY\(\$1::uuid\[\]\)/);
    expect(mockQuery.mock.calls[0][1]).toEqual([["A", "B", "C", "D"]]);
  });
});
