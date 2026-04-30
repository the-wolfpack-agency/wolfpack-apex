/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  query: jest.fn(),
}));

import {
  createNote,
  listNotes,
  updateNote,
  deleteNote,
  findNotesByAssociation,
} from "@/lib/bulletin/notes";

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

const noteRow = {
  id: "note-1",
  board_id: "board-1",
  body: "hello",
  color: "#ffeb3b",
  x_pct: 10,
  y_pct: 10,
  width_pct: 18,
  height_pct: 14,
  rotation_deg: 0,
  association_kind: null as string | null,
  association_id: null as string | null,
  association_label: null as string | null,
  created_by_user_id: "u1",
  created_by_user_role: "ceo",
  created_by_user_name: "Nick",
  created_at: "2026-04-30T00:00:00.000Z",
  updated_at: "2026-04-30T00:00:00.000Z",
  deleted_at: null as string | null,
};

/* assertBoardWritable runs a SELECT first; helper queues the response. */
function queueBoardLookup(archived: boolean = false): void {
  mockSafeQuery.mockResolvedValueOnce({
    rows: [{ archived_at: archived ? "2026-04-30T00:00:00Z" : null }],
  });
}

describe("createNote", () => {
  test("inserts with defaults and returns mapped row", async () => {
    queueBoardLookup(false);
    mockWriteQuery.mockResolvedValueOnce({ rows: [noteRow] });
    const note = await createNote({
      boardId: "board-1",
      body: "hello",
      userId: "u1",
      userRole: "ceo",
      userName: "Nick",
    });
    expect(note.id).toBe("note-1");
    expect(note.color).toBe("#ffeb3b");
    expect(note.x_pct).toBe(10);
    expect(note.associationKind).toBeNull();
  });

  test("rejects when target board is archived", async () => {
    queueBoardLookup(true);
    await expect(
      createNote({
        boardId: "board-1",
        body: "hi",
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/archived/);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  test("rejects when target board does not exist", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      createNote({
        boardId: "missing",
        body: "hi",
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/board not found/);
  });

  test("rejects empty body", async () => {
    await expect(
      createNote({
        boardId: "board-1",
        body: "",
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/body is required/);
  });

  test("accepts position overrides", async () => {
    queueBoardLookup(false);
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...noteRow, x_pct: 50, y_pct: 60, rotation_deg: 5 }],
    });
    const note = await createNote({
      boardId: "board-1",
      body: "hi",
      position: { x_pct: 50, y_pct: 60, rotation_deg: 5 },
      userId: "u1",
      userRole: "ceo",
    });
    expect(note.x_pct).toBe(50);
    expect(note.y_pct).toBe(60);
    expect(note.rotation_deg).toBe(5);
  });

  test("accepts a valid association", async () => {
    queueBoardLookup(false);
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          ...noteRow,
          association_kind: "task",
          association_id: "task-9",
          association_label: "Ship onboarding",
        },
      ],
    });
    const note = await createNote({
      boardId: "board-1",
      body: "hi",
      association: { kind: "task", id: "task-9", label: "Ship onboarding" },
      userId: "u1",
      userRole: "ceo",
    });
    expect(note.associationKind).toBe("task");
    expect(note.associationId).toBe("task-9");
    expect(note.associationLabel).toBe("Ship onboarding");
  });

  test("rejects an unknown association kind", async () => {
    queueBoardLookup(false);
    await expect(
      createNote({
        boardId: "board-1",
        body: "hi",
        association: { kind: "wishlist", id: "x" },
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/association.kind/);
  });
});

describe("listNotes", () => {
  test("filters by board and skips deleted", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [noteRow] });
    const notes = await listNotes("board-1");
    expect(notes).toHaveLength(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/board_id = \$1/);
    expect(params[0]).toBe("board-1");
    expect(params[1]).toBe(1000);
  });

  test("empty boardId returns []", async () => {
    expect(await listNotes("")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("limit clamps to 1000", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listNotes("board-1", { limit: 99999 });
    const params = mockSafeQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe(1000);
  });
});

describe("updateNote", () => {
  test("rejects empty patch", async () => {
    await expect(updateNote("note-1", {})).rejects.toThrow(/empty/);
  });

  test("updates body and bumps updated_at", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...noteRow, body: "new body" }],
    });
    const note = await updateNote("note-1", { body: "new body" });
    expect(note?.body).toBe("new body");
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/body = \$1/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  test("updates position fields", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...noteRow, x_pct: 25, rotation_deg: -10 }],
    });
    const note = await updateNote("note-1", { x_pct: 25, rotation_deg: -10 });
    expect(note?.x_pct).toBe(25);
    expect(note?.rotation_deg).toBe(-10);
  });

  test("rejects non-finite numeric position", async () => {
    await expect(updateNote("note-1", { x_pct: NaN })).rejects.toThrow(
      /finite number/,
    );
  });

  test("association: null clears the columns", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [noteRow] });
    await updateNote("note-1", { association: null });
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/association_kind = NULL/);
    expect(sql).toMatch(/association_id = NULL/);
    expect(sql).toMatch(/association_label = NULL/);
  });

  test("association: {kind,id} updates triple of columns", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          ...noteRow,
          association_kind: "meeting",
          association_id: "m-7",
          association_label: "Q3 planning",
        },
      ],
    });
    const note = await updateNote("note-1", {
      association: { kind: "meeting", id: "m-7", label: "Q3 planning" },
    });
    expect(note?.associationKind).toBe("meeting");
  });

  test("returns null when row not found", async () => {
    mockWriteQuery.mockRejectedValueOnce(
      new Error("writeQuery row-count mismatch: expected 1, got 0"),
    );
    const note = await updateNote("missing", { body: "x" });
    expect(note).toBeNull();
  });
});

describe("deleteNote", () => {
  test("soft-deletes by setting deleted_at", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await deleteNote("note-1");
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/SET deleted_at = NOW\(\)/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(params[0]).toBe("note-1");
  });

  test("empty id is a no-op", async () => {
    await deleteNote("");
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});

describe("findNotesByAssociation", () => {
  test("returns active notes for kind+id", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { ...noteRow, association_kind: "task", association_id: "task-1" },
      ],
    });
    const notes = await findNotesByAssociation("task", "task-1");
    expect(notes).toHaveLength(1);
    expect(notes[0].associationKind).toBe("task");
  });

  test("rejects unknown kind without hitting DB", async () => {
    expect(await findNotesByAssociation("bogus", "x")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("empty inputs return []", async () => {
    expect(await findNotesByAssociation("", "x")).toEqual([]);
    expect(await findNotesByAssociation("task", "")).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});
