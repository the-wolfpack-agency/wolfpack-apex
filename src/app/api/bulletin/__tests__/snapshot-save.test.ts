/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSaveSnapshot = jest.fn();
const mockGetBoard = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/snapshots", () => ({
  saveSnapshot: (...a: any[]) => mockSaveSnapshot(...a),
}));
jest.mock("@/lib/bulletin/boards", () => ({
  getBoard: (...a: any[]) => mockGetBoard(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { POST } from "../boards/[id]/snapshot/route";

beforeEach(() => {
  mockSaveSnapshot.mockReset();
  mockGetBoard.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

const sampleBoard = {
  id: "board-1",
  title: "Q3",
  description: null,
  ownerUserId: "u1",
  ownerUserRole: "ceo",
  archivedAt: null,
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};

const sampleSnap = {
  id: "snap-1",
  boardId: "board-1",
  associationKind: null,
  associationId: null,
  associationLabel: null,
  createdByUserId: "u1",
  createdAt: "2026-04-30T00:00:00.000Z",
};

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postBody(boardId: string, body: unknown): NextRequest {
  return new NextRequest(`https://x.test/api/bulletin/boards/${boardId}/snapshot`, {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const tinyPngBase64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

describe("POST /api/bulletin/boards/[id]/snapshot", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(
      postBody("board-1", { png_base64: tinyPngBase64 }),
      ctx("board-1"),
    );
    expect(res.status).toBe(401);
  });

  test("400 when png_base64 missing", async () => {
    const res = await POST(postBody("board-1", {}), ctx("board-1"));
    expect(res.status).toBe(400);
  });

  test("404 when board missing", async () => {
    mockGetBoard.mockResolvedValueOnce(null);
    const res = await POST(
      postBody("board-1", { png_base64: tinyPngBase64 }),
      ctx("board-1"),
    );
    expect(res.status).toBe(404);
  });

  test("200 happy path returns snapshot + tracks event", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    mockSaveSnapshot.mockResolvedValueOnce(sampleSnap);
    const res = await POST(
      postBody("board-1", { png_base64: tinyPngBase64 }),
      ctx("board-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshot.id).toBe("snap-1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.snapshot_saved",
      "u1",
      "ceo",
      expect.objectContaining({
        board_id: "board-1",
        has_association: false,
        kind: "none",
      }),
    );
  });

  test("strips data: prefix on inbound base64", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    mockSaveSnapshot.mockResolvedValueOnce(sampleSnap);
    const res = await POST(
      postBody("board-1", {
        png_base64: `data:image/png;base64,${tinyPngBase64}`,
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(200);
    /* The bytes passed to saveSnapshot should be the decoded length of
       the original payload, NOT the literal "data:..." prefix length. */
    const args = mockSaveSnapshot.mock.calls[0][0];
    expect(args.pngBytes).toBeInstanceOf(Uint8Array);
    expect(args.pngBytes.length).toBe(8);
  });

  test("413 when payload exceeds 4MB", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    /* 5MB of zero bytes → base64 explodes 4/3, so the plain bytes
       cap is what matters. */
    const oversized = Buffer.alloc(5 * 1024 * 1024).toString("base64");
    const res = await POST(
      postBody("board-1", { png_base64: oversized }),
      ctx("board-1"),
    );
    expect(res.status).toBe(413);
  });

  test("400 when association.id missing", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    const res = await POST(
      postBody("board-1", {
        png_base64: tinyPngBase64,
        association: { kind: "meeting" },
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(400);
  });

  test("forwards valid association to lib", async () => {
    mockGetBoard.mockResolvedValueOnce(sampleBoard);
    mockSaveSnapshot.mockResolvedValueOnce({
      ...sampleSnap,
      associationKind: "meeting",
      associationId: "m-1",
    });
    const res = await POST(
      postBody("board-1", {
        png_base64: tinyPngBase64,
        association: { kind: "meeting", id: "m-1", label: "Sync" },
      }),
      ctx("board-1"),
    );
    expect(res.status).toBe(200);
    expect(mockSaveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        association: expect.objectContaining({
          kind: "meeting",
          id: "m-1",
          label: "Sync",
        }),
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.snapshot_saved",
      "u1",
      "ceo",
      expect.objectContaining({ has_association: true, kind: "meeting" }),
    );
  });
});
