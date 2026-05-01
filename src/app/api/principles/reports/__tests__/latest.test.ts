/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetLatest = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u-cto",
  role: "cto",
  name: "Nick",
  email: "n@x",
};

jest.mock("@/lib/principles/weekly-report", () => ({
  getLatestWeeklyReport: (...a: any[]) => mockGetLatest(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../latest/route";

beforeEach(() => {
  mockGetLatest.mockReset();
  authUser = { id: "u-cto", role: "cto", name: "Nick", email: "n@x" };
});

const req = () =>
  new NextRequest("https://wp.test/api/principles/reports/latest", {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });

describe("GET /api/principles/reports/latest", () => {
  test("401 unauthenticated", async () => {
    authUser = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
  test("403 for non-leadership", async () => {
    authUser = { id: "u1", role: "sales", name: "Alicia", email: "a@x" };
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mockGetLatest).not.toHaveBeenCalled();
  });
  test("returns null report when none stored", async () => {
    mockGetLatest.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report).toBeNull();
  });
  test("returns the latest report record", async () => {
    mockGetLatest.mockResolvedValueOnce({
      id: "r1",
      weekStart: "2026-04-28",
      weekEnd: "2026-05-05",
      markdownBody: "# md",
      observationCount: 5,
      principleCount: 2,
      generatedAt: "2026-05-05",
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.report.markdownBody).toBe("# md");
    expect(body.report.observationCount).toBe(5);
  });
});
