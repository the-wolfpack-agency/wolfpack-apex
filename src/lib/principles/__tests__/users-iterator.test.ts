 
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
  };
});

import { listConnectedM365Users } from "@/lib/principles/users-iterator";

beforeEach(() => mockSafeQuery.mockReset());

describe("listConnectedM365Users", () => {
  test("maps rows to camelCase + dedupes via DISTINCT ON", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          connected_by: "u1",
          user_email: "a@x",
          display_name: "Alicia",
          connected_at: "2026-05-01",
        },
        {
          connected_by: "u2",
          user_email: "b@x",
          display_name: null,
          connected_at: "2026-04-01",
        },
      ],
    });
    const out = await listConnectedM365Users();
    expect(out).toEqual([
      {
        userId: "u1",
        email: "a@x",
        displayName: "Alicia",
        connectedAt: "2026-05-01",
      },
      {
        userId: "u2",
        email: "b@x",
        displayName: null,
        connectedAt: "2026-04-01",
      },
    ]);
  });
  test("uses DISTINCT ON (connected_by) ORDER BY connected_by, connected_at DESC", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listConnectedM365Users();
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(
      /DISTINCT ON \(connected_by\)/,
    );
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(
      /ORDER BY connected_by, connected_at DESC/,
    );
  });
  test("empty result returns empty array", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await listConnectedM365Users()).toEqual([]);
  });
});
