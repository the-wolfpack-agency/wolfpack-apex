 
const mockUpdateNote = jest.fn();
const mockDeleteNote = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/notes", () => ({
  updateNote: (...a: any[]) => mockUpdateNote(...a),
  deleteNote: (...a: any[]) => mockDeleteNote(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { PATCH, DELETE } from "../notes/[id]/route";

beforeEach(() => {
  mockUpdateNote.mockReset();
  mockDeleteNote.mockReset();
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

function reqJson(method: string, body: unknown): NextRequest {
  return new NextRequest("https://x.test/api/bulletin/notes/note-1", {
    method,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/bulletin/notes/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await PATCH(reqJson("PATCH", { body: "x" }), ctx("note-1"));
    expect(res.status).toBe(401);
  });

  test("400 on empty patch", async () => {
    const res = await PATCH(reqJson("PATCH", {}), ctx("note-1"));
    expect(res.status).toBe(400);
  });

  test("404 when note missing", async () => {
    mockUpdateNote.mockResolvedValueOnce(null);
    const res = await PATCH(reqJson("PATCH", { body: "x" }), ctx("note-1"));
    expect(res.status).toBe(404);
  });

  test("200 returns updated note + tracks event", async () => {
    mockUpdateNote.mockResolvedValueOnce({ ...sampleNote, body: "new" });
    const res = await PATCH(reqJson("PATCH", { body: "new" }), ctx("note-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note.body).toBe("new");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.note_updated",
      "u1",
      "ceo",
      expect.objectContaining({ note_id: "note-1", board_id: "board-1" }),
    );
  });

  test("200 forwards position fields", async () => {
    mockUpdateNote.mockResolvedValueOnce({ ...sampleNote, x_pct: 25 });
    const res = await PATCH(reqJson("PATCH", { x_pct: 25 }), ctx("note-1"));
    expect(res.status).toBe(200);
    expect(mockUpdateNote).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({ x_pct: 25 }),
    );
  });

  test("400 when association payload incomplete", async () => {
    const res = await PATCH(
      reqJson("PATCH", { association: { kind: "task" } }),
      ctx("note-1"),
    );
    expect(res.status).toBe(400);
  });

  test("association: null clears via lib", async () => {
    mockUpdateNote.mockResolvedValueOnce(sampleNote);
    const res = await PATCH(reqJson("PATCH", { association: null }), ctx("note-1"));
    expect(res.status).toBe(200);
    expect(mockUpdateNote).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({ association: null }),
    );
  });

  test("400 on lib validation error", async () => {
    mockUpdateNote.mockRejectedValueOnce(new Error("x_pct must be a finite number"));
    const res = await PATCH(reqJson("PATCH", { body: "x" }), ctx("note-1"));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/bulletin/notes/[id]", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await DELETE(reqJson("DELETE", {}), ctx("note-1"));
    expect(res.status).toBe(401);
  });

  test("200 + tracks event", async () => {
    mockDeleteNote.mockResolvedValueOnce(undefined);
    const res = await DELETE(reqJson("DELETE", {}), ctx("note-1"));
    expect(res.status).toBe(200);
    expect(mockDeleteNote).toHaveBeenCalledWith("note-1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.note_deleted",
      "u1",
      "ceo",
      expect.objectContaining({ note_id: "note-1" }),
    );
  });
});
