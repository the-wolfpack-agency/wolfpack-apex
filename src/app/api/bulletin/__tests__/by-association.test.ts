 
const mockFindNotes = jest.fn();
const mockFindSnaps = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/notes", () => ({
  findNotesByAssociation: (...a: any[]) => mockFindNotes(...a),
}));
jest.mock("@/lib/bulletin/snapshots", () => ({
  findSnapshotsByAssociation: (...a: any[]) => mockFindSnaps(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../by-association/route";

beforeEach(() => {
  mockFindNotes.mockReset();
  mockFindSnaps.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

function reqUrl(qs: string): NextRequest {
  return new NextRequest(`https://x.test/api/bulletin/by-association${qs}`, {
    headers: { authorization: "Bearer x" },
  });
}

describe("GET /api/bulletin/by-association", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(reqUrl("?kind=task&id=task-1"));
    expect(res.status).toBe(401);
  });

  test("400 when kind/id missing", async () => {
    const res = await GET(reqUrl("?kind=task"));
    expect(res.status).toBe(400);
  });

  test("200 returns combined notes + snapshots", async () => {
    mockFindNotes.mockResolvedValueOnce([{ id: "n1" }]);
    mockFindSnaps.mockResolvedValueOnce([{ id: "s1" }]);
    const res = await GET(reqUrl("?kind=meeting&id=m-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toHaveLength(1);
    expect(body.snapshots).toHaveLength(1);

    expect(mockFindNotes).toHaveBeenCalledWith("meeting", "m-1");
    expect(mockFindSnaps).toHaveBeenCalledWith("meeting", "m-1");
  });

  test("unknown kind passes through to lib (lib returns []); we don't 400", async () => {
    mockFindNotes.mockResolvedValueOnce([]);
    mockFindSnaps.mockResolvedValueOnce([]);
    const res = await GET(reqUrl("?kind=bogus&id=x"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toEqual([]);
    expect(body.snapshots).toEqual([]);
  });
});
