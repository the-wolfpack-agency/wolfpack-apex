 
const mockGetBoard = jest.fn();
const mockUpdateBoard = jest.fn();
const mockArchiveBoard = jest.fn();
const mockListNotes = jest.fn();
const mockListSnapshots = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/boards", () => ({
  getBoard: (...a: any[]) => mockGetBoard(...a),
  updateBoard: (...a: any[]) => mockUpdateBoard(...a),
  archiveBoard: (...a: any[]) => mockArchiveBoard(...a),
}));
jest.mock("@/lib/bulletin/notes", () => ({
  listNotes: (...a: any[]) => mockListNotes(...a),
}));
jest.mock("@/lib/bulletin/snapshots", () => ({
  listSnapshots: (...a: any[]) => mockListSnapshots(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET, PATCH, DELETE } from "../boards/[id]/route";

beforeEach(() => {
  mockGetBoard.mockReset();
  mockUpdateBoard.mockReset();
  mockArchiveBoard.mockReset();
  mockListNotes.mockReset();
  mockListSnapshots.mockReset();
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

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(
  url: string,
  init?: { method?: string; body?: string },
): NextRequest {
  return new NextRequest(url, {
    method: init?.method,
    body: init?.body,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
  });
}

describe("GET /api/bulletin/boards/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(req("https://x.test/api/bulletin/boards/board-1"), ctx("board-1"));
    expect(res.status).toBe(401);
  });

  test("404 when board not found", async () => {
    mockGetBoard.mockResolvedValueOnce(null);
    const res = await GET(req("https://x.test/api/bulletin/boards/board-1"), ctx("board-1"));
    expect(res.status).toBe(404);
  });

  test("200 returns board + notes + snapshots", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    mockListNotes.mockResolvedValueOnce([{ id: "n1" }]);
    mockListSnapshots.mockResolvedValueOnce([{ id: "s1" }]);

    const res = await GET(req("https://x.test/api/bulletin/boards/board-1"), ctx("board-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.board.id).toBe("board-1");
    expect(body.notes).toHaveLength(1);
    expect(body.snapshots).toHaveLength(1);
  });
});

describe("PATCH /api/bulletin/boards/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await PATCH(
      req("https://x.test/api/bulletin/boards/board-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "x" }),
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(401);
  });

  test("400 on empty patch", async () => {
    const res = await PATCH(
      req("https://x.test/api/bulletin/boards/board-1", {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(400);
  });

  test("404 when board missing", async () => {
    mockUpdateBoard.mockResolvedValueOnce(null);
    const res = await PATCH(
      req("https://x.test/api/bulletin/boards/board-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(404);
  });

  test("200 returns updated board", async () => {
    mockUpdateBoard.mockResolvedValueOnce({ ...sampleBoard, title: "Renamed" });
    const res = await PATCH(
      req("https://x.test/api/bulletin/boards/board-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.board.title).toBe("Renamed");
  });

  test("400 on validation error from lib", async () => {
    mockUpdateBoard.mockRejectedValueOnce(
      new Error("title must be a non-empty string"),
    );
    const res = await PATCH(
      req("https://x.test/api/bulletin/boards/board-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "" }),
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/bulletin/boards/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await DELETE(
      req("https://x.test/api/bulletin/boards/board-1", { method: "DELETE" }),
      ctx("board-1"),
    );
    expect(res.status).toBe(401);
  });

  test("404 when board missing", async () => {
    mockGetBoard.mockResolvedValueOnce(null);
    const res = await DELETE(
      req("https://x.test/api/bulletin/boards/board-1", { method: "DELETE" }),
      ctx("board-1"),
    );
    expect(res.status).toBe(404);
  });

  test("200 archives + emits event", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    mockArchiveBoard.mockResolvedValueOnce(undefined);
    const res = await DELETE(
      req("https://x.test/api/bulletin/boards/board-1", { method: "DELETE" }),
      ctx("board-1"),
    );
    expect(res.status).toBe(200);
    expect(mockArchiveBoard).toHaveBeenCalledWith("board-1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.board_archived",
      "u1",
      "ceo",
      expect.objectContaining({ board_id: "board-1" }),
    );
  });
});
