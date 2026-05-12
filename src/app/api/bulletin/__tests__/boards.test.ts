 
const mockCreateBoard = jest.fn();
const mockListBoards = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/boards", () => {
  const actual = jest.requireActual("@/lib/bulletin/boards");
  return {
    ...actual,
    createBoard: (...a: any[]) => mockCreateBoard(...a),
    listBoards: (...a: any[]) => mockListBoards(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { POST, GET } from "../boards/route";

beforeEach(() => {
  mockCreateBoard.mockReset();
  mockListBoards.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

const sampleBoard = {
  id: "board-1",
  title: "Q3 retro",
  description: "Wins + blockers",
  ownerUserId: "u1",
  ownerUserRole: "ceo",
  archivedAt: null,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};

function postBody(body: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://x.test/api/bulletin/boards", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/bulletin/boards", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(postBody({ title: "x" }));
    expect(res.status).toBe(401);
  });

  test("400 when title missing", async () => {
    const res = await POST(postBody({}));
    expect(res.status).toBe(400);
  });

  test("200 happy path returns board + tracks event", async () => {
    mockCreateBoard.mockResolvedValueOnce(sampleBoard);
    const res = await POST(
      postBody({ title: "Q3 retro", description: "Wins + blockers" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.board.id).toBe("board-1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.board_created",
      "u1",
      "ceo",
      expect.objectContaining({ board_id: "board-1", has_description: true }),
    );
  });

  test("500 when createBoard throws", async () => {
    mockCreateBoard.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(postBody({ title: "x" }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/bulletin/boards", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const req = new NextRequest("https://x.test/api/bulletin/boards", {
      headers: { authorization: "" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  test("returns boards", async () => {
    mockListBoards.mockResolvedValueOnce([sampleBoard]);
    const req = new NextRequest("https://x.test/api/bulletin/boards", {
      headers: { authorization: "Bearer x" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.boards).toHaveLength(1);
  });

  test("?includeArchived=true forwards the flag", async () => {
    mockListBoards.mockResolvedValueOnce([]);
    const req = new NextRequest(
      "https://x.test/api/bulletin/boards?includeArchived=true",
      { headers: { authorization: "Bearer x" } },
    );
    await GET(req);
    expect(mockListBoards).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true }),
    );
  });
});
