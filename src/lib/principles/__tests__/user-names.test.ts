/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
  };
});

import { resolveUserNames } from "@/lib/principles/user-names";

beforeEach(() => mockSafeQuery.mockReset());

describe("resolveUserNames", () => {
  test("empty input returns empty map", async () => {
    const out = await resolveUserNames([]);
    expect(out.size).toBe(0);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
  test("maps each token row + backfills missing ids with their userId", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { user_id: "u1", display_name: "Alicia Zulker", email: "a@x" },
        { user_id: "u2", display_name: null, email: "b@x" },
      ],
    });
    const out = await resolveUserNames(["u1", "u2", "u-missing"]);
    expect(out.get("u1")?.displayName).toBe("Alicia Zulker");
    expect(out.get("u2")?.displayName).toBe("b@x");
    expect(out.get("u-missing")?.displayName).toBe("u-missing");
    expect(out.get("u-missing")?.email).toBeNull();
  });
  test("dedupes input ids before querying", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await resolveUserNames(["u1", "u1", "u1"]);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual([["u1"]]);
  });
});
