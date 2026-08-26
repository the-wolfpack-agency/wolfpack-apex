/**
 * Which controls are shown to people who cannot use them.
 *
 * The ranking is the report. Volume alone would surface a control thirty
 * people brushed past once and bury the one a single person fought three times
 * before deciding the product was broken. The second is the defect; the first
 * is usually a stale tab.
 */
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { getRoleMismatches } from "../role-mismatch-report";

beforeEach(() => mockQuery.mockReset());

const ROW = (o: Record<string, string> = {}) => ({
  control: "/api/orgs/:id/users",
  method: "POST",
  surface: "/admin/team",
  role: "dealer",
  attempts: "3",
  people: "1",
  worst_repeat: "3",
  last_seen: "2026-08-26",
  ...o,
});

describe("reading the report", () => {
  it("returns what somebody can act on: the control, the page, and the role", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW()] });
    const r = await getRoleMismatches(30);
    expect(r.readable).toBe(true);
    expect(r.mismatches[0]).toMatchObject({
      control: "/api/orgs/:id/users",
      surface: "/admin/team",
      role: "dealer",
      worstRepeat: 3,
      people: 1,
    });
  });

  /* THE RANKING, asserted on the SQL because that is where it lives. A future
     edit to ORDER BY would silently invert the report's meaning while every
     other test kept passing. */
  it("ranks by the worst repeat before total volume", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRoleMismatches(30);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY max\(attempts_by_person\) DESC, sum\(attempts_by_person\) DESC/);
  });

  /* Counting per person first is what makes a repeat visible at all. Grouped
     the other way, three attempts by one person and one each by three people
     are the same number. */
  it("counts attempts per person before aggregating", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRoleMismatches(30);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/WITH per_person AS/);
    expect(sql).toMatch(/count\(DISTINCT user_id\)/);
  });

  it("clamps the window and the row count", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRoleMismatches(99999, 99999);
    expect(mockQuery.mock.calls[0][1]).toEqual([365, 200]);
  });
});

describe("when the report cannot be read", () => {
  /* An empty list here reads as "no control in this product lies to anybody",
     which is a strong claim to make by accident. */
  it("says unreadable rather than reporting a clean product", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const r = await getRoleMismatches(30);
    expect(r.readable).toBe(false);
    expect(r.mismatches).toEqual([]);
  });
});
