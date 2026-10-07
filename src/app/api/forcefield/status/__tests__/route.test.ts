/**
 * @jest-environment node
 *
 * Contract for the PUBLIC /api/forcefield/status. Asserts: 200 ok when the DB
 * probe succeeds; 200 degraded (NOT 500) when the DB probe fails or throws - a
 * status endpoint must always answer; and the fail-open posture is surfaced.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { GET } from "../route";

beforeEach(() => jest.clearAllMocks());

it("200 ok when the database probe returns a row", async () => {
  mockSafeQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }], fromCache: false });
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, status: "ok", database: true, failOpen: true });
});

it("200 degraded (never 500) when the database probe throws", async () => {
  mockSafeQuery.mockRejectedValueOnce(new Error("db down"));
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, status: "degraded", database: false });
});

it("200 degraded when the probe returns no row", async () => {
  mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
  const res = await GET();
  expect((await res.json()).status).toBe("degraded");
});
