 
const mockCreateNote = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/notes", () => ({
  createNote: (...a: any[]) => mockCreateNote(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { POST } from "../boards/[id]/notes/route";

beforeEach(() => {
  mockCreateNote.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

const sampleNote = {
  id: "note-1",
  boardId: "board-1",
  body: "hello",
  color: "#ffeb3b",
  x_pct: 10,
  y_pct: 10,
  width_pct: 18,
  height_pct: 14,
  rotation_deg: 0,
  associationKind: null,
  associationId: null,
  associationLabel: null,
  createdByUserId: "u1",
  createdByUserRole: "ceo",
  createdByUserName: "Nick",
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
  deletedAt: null,
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postBody(boardId: string, body: unknown): NextRequest {
  return new NextRequest(`https://x.test/api/bulletin/boards/${boardId}/notes`, {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/bulletin/boards/[id]/notes", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(postBody("board-1", { body: "hi" }), ctx("board-1"));
    expect(res.status).toBe(401);
  });

  test("400 when body missing", async () => {
    const res = await POST(postBody("board-1", {}), ctx("board-1"));
    expect(res.status).toBe(400);
  });

  /* Regression 2026-04-30: Add note button drops a blank sticky and
     the user types into it. Empty string MUST be accepted. */
  test("200 when body is empty string (blank starter sticky)", async () => {
    mockCreateNote.mockResolvedValueOnce(sampleNote);
    const res = await POST(postBody("board-1", { body: "" }), ctx("board-1"));
    expect(res.status).toBe(200);
  });

  test("200 happy path returns note + tracks event without assoc", async () => {
    mockCreateNote.mockResolvedValueOnce(sampleNote);
    const res = await POST(postBody("board-1", { body: "hello" }), ctx("board-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note.id).toBe("note-1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.note_created",
      "u1",
      "ceo",
      expect.objectContaining({
        board_id: "board-1",
        has_association: false,
        kind: "none",
      }),
    );
  });

  test("200 with valid association is forwarded + has_association=true", async () => {
    mockCreateNote.mockResolvedValueOnce({
      ...sampleNote,
      associationKind: "task",
      associationId: "task-9",
      associationLabel: "Ship onboarding",
    });
    const res = await POST(
      postBody("board-1", {
        body: "hi",
        association: { kind: "task", id: "task-9", label: "Ship onboarding" },
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(200);

    expect(mockCreateNote).toHaveBeenCalledWith(
      expect.objectContaining({
        association: expect.objectContaining({
          kind: "task",
          id: "task-9",
          label: "Ship onboarding",
        }),
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.note_created",
      "u1",
      "ceo",
      expect.objectContaining({ has_association: true, kind: "task" }),
    );
  });

  test("400 when association.id missing", async () => {
    const res = await POST(
      postBody("board-1", {
        body: "hi",
        association: { kind: "task" },
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(400);
  });

  test("404 when lib reports board not found", async () => {
    mockCreateNote.mockRejectedValueOnce(new Error("board not found"));
    const res = await POST(postBody("board-1", { body: "hi" }), ctx("board-1"));
    expect(res.status).toBe(404);
  });

  test("409 when board is archived", async () => {
    mockCreateNote.mockRejectedValueOnce(new Error("board is archived (read-only)"));
    const res = await POST(postBody("board-1", { body: "hi" }), ctx("board-1"));
    expect(res.status).toBe(409);
  });

  test("400 when lib rejects unknown association kind", async () => {
    mockCreateNote.mockRejectedValueOnce(
      new Error("association.kind must be one of: task, goal, meeting, discussion, calendar_event"),
    );
    const res = await POST(
      postBody("board-1", {
        body: "hi",
        association: { kind: "wishlist", id: "x" },
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(400);
  });
});
