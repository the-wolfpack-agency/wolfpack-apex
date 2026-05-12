 
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  query: jest.fn(),
}));

import {
  createBoard,
  getBoard,
  listBoards,
  updateBoard,
  archiveBoard,
} from "@/lib/bulletin/boards";

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

const dbRow = {
  id: "board-1",
  title: "Q3 retro",
  description: "Top wins + blockers",
  owner_user_id: "u1",
  owner_user_role: "ceo",
  archived_at: null as string | null,
  created_at: "2026-04-30T00:00:00.000Z",
  updated_at: "2026-04-30T00:00:00.000Z",
};

describe("createBoard", () => {
  test("inserts and returns the mapped row", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const board = await createBoard({
      title: "Q3 retro",
      description: "Top wins + blockers",
      userId: "u1",
      userRole: "ceo",
    });
    expect(board.id).toBe("board-1");
    expect(board.title).toBe("Q3 retro");
    expect(board.ownerUserId).toBe("u1");
    expect(board.ownerUserRole).toBe("ceo");
    expect(board.archivedAt).toBeNull();
  });

  test("rejects empty title", async () => {
    await expect(
      createBoard({ title: "", userId: "u1", userRole: "ceo" }),
    ).rejects.toThrow(/title is required/);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  test("description is nullable", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...dbRow, description: null }],
    });
    const board = await createBoard({
      title: "Untitled",
      userId: "u1",
      userRole: "ceo",
    });
    expect(board.description).toBeNull();
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBeNull();
  });
});

describe("getBoard", () => {
  test("returns mapped row or null", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [dbRow] });
    expect((await getBoard("board-1"))?.id).toBe("board-1");

    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getBoard("missing")).toBeNull();
  });

  test("empty id short-circuits to null", async () => {
    expect(await getBoard("")).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("listBoards", () => {
  test("default excludes archived, newest first, limit 100", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const boards = await listBoards();
    expect(boards).toHaveLength(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/archived_at IS NULL/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params[0]).toBe(100);
  });

  test("includeArchived=true skips the archived filter", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listBoards({ includeArchived: true });
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).not.toMatch(/archived_at IS NULL/);
  });

  test("limit clamps into [1, 500]", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listBoards({ limit: 9999 });
    const params = mockSafeQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(500);

    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listBoards({ limit: 0 });
    const params2 = mockSafeQuery.mock.calls[1][1] as unknown[];
    expect(params2[0]).toBe(1);
  });
});

describe("updateBoard", () => {
  test("rejects empty patch", async () => {
    await expect(updateBoard("board-1", {})).rejects.toThrow(/empty/);
  });

  test("updates title only when provided", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...dbRow, title: "Renamed" }],
    });
    const board = await updateBoard("board-1", { title: "Renamed" });
    expect(board?.title).toBe("Renamed");
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/title = \$1/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(sql).not.toMatch(/description = /);
  });

  test("updates both title and description", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...dbRow, title: "Renamed", description: "New desc" }],
    });
    const board = await updateBoard("board-1", {
      title: "Renamed",
      description: "New desc",
    });
    expect(board?.title).toBe("Renamed");
    expect(board?.description).toBe("New desc");
  });

  test("rejects empty title patch", async () => {
    await expect(updateBoard("board-1", { title: "" })).rejects.toThrow(
      /non-empty/,
    );
  });

  test("returns null when row not found (writeQuery row-count mismatch)", async () => {
    mockWriteQuery.mockRejectedValueOnce(
      new Error("writeQuery row-count mismatch: expected 1, got 0"),
    );
    const board = await updateBoard("missing", { title: "x" });
    expect(board).toBeNull();
  });

  test("re-throws non-row-count errors", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("connection refused"));
    await expect(updateBoard("board-1", { title: "x" })).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe("archiveBoard", () => {
  test("sets archived_at = NOW()", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await archiveBoard("board-1");
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/archived_at = NOW\(\)/);
    expect(params[0]).toBe("board-1");
  });

  test("empty id is a no-op", async () => {
    await archiveBoard("");
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});
