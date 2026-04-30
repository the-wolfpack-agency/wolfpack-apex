/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  query: jest.fn(),
}));

import {
  saveSnapshot,
  listSnapshots,
  getSnapshotPng,
  findSnapshotsByAssociation,
} from "@/lib/bulletin/snapshots";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

const metaRow = {
  id: "snap-1",
  board_id: "board-1",
  association_kind: null as string | null,
  association_id: null as string | null,
  association_label: null as string | null,
  created_by_user_id: "u1",
  created_at: "2026-04-30T00:00:00.000Z",
};

const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("saveSnapshot", () => {
  test("inserts BYTEA and returns meta", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [metaRow] });
    const snap = await saveSnapshot({
      boardId: "board-1",
      pngBytes: tinyPng,
      userId: "u1",
    });
    expect(snap.id).toBe("snap-1");
    expect(snap.boardId).toBe("board-1");
    expect(snap.associationKind).toBeNull();
    /* The bound BYTEA is a Buffer wrapper around our bytes. */
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(Buffer.isBuffer(params[1])).toBe(true);
    expect((params[1] as Buffer).length).toBe(tinyPng.length);
  });

  test("rejects empty pngBytes", async () => {
    await expect(
      saveSnapshot({
        boardId: "board-1",
        pngBytes: new Uint8Array(0),
        userId: "u1",
      }),
    ).rejects.toThrow(/pngBytes is required/);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  test("rejects missing boardId/userId", async () => {
    await expect(
      saveSnapshot({ boardId: "", pngBytes: tinyPng, userId: "u1" }),
    ).rejects.toThrow(/boardId/);
    await expect(
      saveSnapshot({ boardId: "board-1", pngBytes: tinyPng, userId: "" }),
    ).rejects.toThrow(/userId/);
  });

  test("accepts a valid association", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          ...metaRow,
          association_kind: "meeting",
          association_id: "m-1",
          association_label: "Sync",
        },
      ],
    });
    const snap = await saveSnapshot({
      boardId: "board-1",
      pngBytes: tinyPng,
      association: { kind: "meeting", id: "m-1", label: "Sync" },
      userId: "u1",
    });
    expect(snap.associationKind).toBe("meeting");
    expect(snap.associationLabel).toBe("Sync");
  });

  test("rejects unknown association kind", async () => {
    await expect(
      saveSnapshot({
        boardId: "board-1",
        pngBytes: tinyPng,
        association: { kind: "wishlist", id: "x" },
        userId: "u1",
      }),
    ).rejects.toThrow(/association.kind/);
  });
});

describe("listSnapshots", () => {
  test("returns meta rows newest first", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [metaRow] });
    const snaps = await listSnapshots("board-1");
    expect(snaps).toHaveLength(1);
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).not.toMatch(/png_bytes/);
  });

  test("empty boardId returns []", async () => {
    expect(await listSnapshots("")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("getSnapshotPng", () => {
  test("returns Uint8Array bytes + createdAt", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          png_bytes: Buffer.from(tinyPng),
          created_at: "2026-04-30T00:00:00.000Z",
        },
      ],
    });
    const result = await getSnapshotPng("snap-1");
    expect(result).not.toBeNull();
    expect(result?.bytes).toBeInstanceOf(Uint8Array);
    expect(result?.bytes.length).toBe(tinyPng.length);
    expect(result?.createdAt).toBe("2026-04-30T00:00:00.000Z");
  });

  test("returns null when row missing", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getSnapshotPng("missing")).toBeNull();
  });

  test("empty id returns null without DB", async () => {
    expect(await getSnapshotPng("")).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("findSnapshotsByAssociation", () => {
  test("filters by kind+id", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          ...metaRow,
          association_kind: "task",
          association_id: "task-3",
        },
      ],
    });
    const snaps = await findSnapshotsByAssociation("task", "task-3");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].associationKind).toBe("task");
  });

  test("rejects unknown kind without DB", async () => {
    expect(await findSnapshotsByAssociation("bogus", "x")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("empty inputs short-circuit", async () => {
    expect(await findSnapshotsByAssociation("", "x")).toEqual([]);
    expect(await findSnapshotsByAssociation("task", "")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});
