 
const mockGetUser = jest.fn();
const mockCanRead = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/principles/authz", () => ({
  canReadTeamEvidence: (...a: any[]) => mockCanRead(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

beforeEach(() => {
  mockGetUser.mockReset();
  mockCanRead.mockReset();
  mockSafeQuery.mockReset();
});

const req = (auth?: string) =>
  new NextRequest("https://wp.test/api/principles/team-coverage", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });

describe("GET /api/principles/team-coverage", () => {
  test("401 without auth", async () => {
    mockGetUser.mockReturnValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  test("403 when caller is not leadership", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ops" });
    mockCanRead.mockReturnValueOnce(false);
    const res = await GET(req("Bearer x"));
    expect(res.status).toBe(403);
  });

  test("returns connected/total + unconnected list — partial coverage", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ceo" });
    mockCanRead.mockReturnValueOnce(true);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "1", email: "nick@thewolfpack.agency", name: "Nick Hoxsie", has_token: true },
        { id: "2", email: "homyk@thewolfpack.agency", name: "Nick Homyk", has_token: true },
        { id: "3", email: "jorge@thewolfpack.agency", name: "Jorge Colon", has_token: false },
        { id: "4", email: "max@thewolfpack.agency", name: "Max Fuerst", has_token: false },
      ],
    });
    const res = await GET(req("Bearer x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    expect(body.connected).toBe(2);
    expect(body.unconnected.map((u: { name: string }) => u.name).sort()).toEqual([
      "Jorge Colon",
      "Max Fuerst",
    ]);
  });

  test("everyone connected → empty unconnected list", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ceo" });
    mockCanRead.mockReturnValueOnce(true);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "1", email: "a@thewolfpack.agency", name: "A", has_token: true },
        { id: "2", email: "b@thewolfpack.agency", name: "B", has_token: true },
      ],
    });
    const res = await GET(req("Bearer x"));
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.connected).toBe(2);
    expect(body.unconnected).toEqual([]);
  });

  test("nobody connected → unconnected = total", async () => {
    mockGetUser.mockReturnValueOnce({ id: "u1", role: "ceo" });
    mockCanRead.mockReturnValueOnce(true);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "1", email: "a@thewolfpack.agency", name: "A", has_token: false },
      ],
    });
    const res = await GET(req("Bearer x"));
    const body = await res.json();
    expect(body.connected).toBe(0);
    expect(body.unconnected).toHaveLength(1);
  });
});
