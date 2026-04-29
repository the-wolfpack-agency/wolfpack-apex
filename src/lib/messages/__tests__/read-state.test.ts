/**
 * Unit tests for the read-state lib (Bug 2 — per-user-per-chat
 * last-read cursor).
 *
 * Mocks `@/lib/db` so we don't hit Postgres. Verifies:
 *   - getReadState returns a Map<chat_id, ISO> shape
 *   - getReadState returns empty Map on shadow-mode (no rows)
 *   - setReadState performs an upsert with GREATEST(...)
 *   - setReadState fires the messages.read_state_advanced analytics
 *   - setReadState validates ISO 8601 input (round-trip safety)
 *   - normalizes Date | string from pg into ISO 8601
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => {
  class WriteQueryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
    writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
    WriteQueryError,
  };
});

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { getReadState, setReadState } from "@/lib/messages/read-state";
import { WriteQueryError } from "@/lib/db";

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockTrackEvent.mockReset();
});

describe("getReadState", () => {
  test("returns Map<chat_id, ISO> for the user", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { user_id: "u1", chat_id: "c1", last_read_at: "2026-04-29T10:00:00.000Z" },
        { user_id: "u1", chat_id: "c2", last_read_at: new Date("2026-04-28T09:00:00.000Z") },
      ],
      fromCache: false,
    });

    const result = await getReadState("u1");
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get("c1")).toBe("2026-04-29T10:00:00.000Z");
    expect(result.get("c2")).toBe("2026-04-28T09:00:00.000Z");
  });

  test("empty Map for new user (no rows)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const result = await getReadState("u1");
    expect(result.size).toBe(0);
  });

  test("empty Map when userId is empty (never queries)", async () => {
    const result = await getReadState("");
    expect(result.size).toBe(0);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("skips malformed rows (no last_read_at)", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { user_id: "u1", chat_id: "good", last_read_at: "2026-04-29T10:00:00.000Z" },
        { user_id: "u1", chat_id: "no-ts", last_read_at: null },
        { user_id: "u1", chat_id: "bad-ts", last_read_at: "not-a-date" },
      ],
      fromCache: false,
    });
    const result = await getReadState("u1");
    expect(result.get("good")).toBe("2026-04-29T10:00:00.000Z");
    expect(result.has("no-ts")).toBe(false);
    expect(result.has("bad-ts")).toBe(false);
  });
});

describe("setReadState", () => {
  test("upserts and fires messages.read_state_advanced analytics", async () => {
    mockWriteQuery.mockResolvedValue({
      rows: [
        { user_id: "u1", chat_id: "c1", last_read_at: "2026-04-29T10:00:00.000Z" },
      ],
    });

    const result = await setReadState("u1", "c1", "2026-04-29T10:00:00.000Z", {
      kind: "chat",
      userRole: "dev",
    });
    expect(result).toBe("2026-04-29T10:00:00.000Z");

    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const sql = (mockWriteQuery.mock.calls[0][0] as string);
    expect(sql).toMatch(/INSERT INTO chat_read_state/);
    expect(sql).toMatch(/ON CONFLICT \(user_id, chat_id\)/);
    expect(sql).toMatch(/GREATEST/);
    expect(mockWriteQuery.mock.calls[0][2]).toEqual({ expectRows: 1 });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "messages.read_state_advanced",
      "u1",
      "dev",
      { chat_id: "c1", kind: "chat" },
    );
  });

  test("idempotent — repeat calls keep firing analytics, GREATEST keeps newer", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ user_id: "u1", chat_id: "c1", last_read_at: "2026-04-29T10:00:00.000Z" }],
    });
    mockWriteQuery.mockResolvedValueOnce({
      // older value coming in — DB returns the existing newer value via GREATEST
      rows: [{ user_id: "u1", chat_id: "c1", last_read_at: "2026-04-29T10:00:00.000Z" }],
    });

    await setReadState("u1", "c1", "2026-04-29T10:00:00.000Z", { kind: "chat" });
    const second = await setReadState("u1", "c1", "2026-04-28T09:00:00.000Z", {
      kind: "chat",
    });
    expect(second).toBe("2026-04-29T10:00:00.000Z");
    expect(mockTrackEvent).toHaveBeenCalledTimes(2);
  });

  test("kind defaults to 'chat' when omitted", async () => {
    mockWriteQuery.mockResolvedValue({
      rows: [
        { user_id: "u1", chat_id: "c1", last_read_at: "2026-04-29T10:00:00.000Z" },
      ],
    });
    await setReadState("u1", "c1", "2026-04-29T10:00:00.000Z");
    expect(mockTrackEvent.mock.calls[0][3]).toEqual({
      chat_id: "c1",
      kind: "chat",
    });
  });

  test("kind: 'channel' / 'team' propagates into analytics", async () => {
    mockWriteQuery.mockResolvedValue({
      rows: [
        { user_id: "u1", chat_id: "ch1", last_read_at: "2026-04-29T10:00:00.000Z" },
      ],
    });
    await setReadState("u1", "ch1", "2026-04-29T10:00:00.000Z", { kind: "channel" });
    expect(mockTrackEvent.mock.calls[0][3]).toEqual({
      chat_id: "ch1",
      kind: "channel",
    });
  });

  test("rejects empty userId / chatId / invalid ISO", async () => {
    await expect(setReadState("", "c1", "2026-04-29T10:00:00.000Z")).rejects.toBeInstanceOf(
      WriteQueryError,
    );
    await expect(setReadState("u1", "", "2026-04-29T10:00:00.000Z")).rejects.toBeInstanceOf(
      WriteQueryError,
    );
    await expect(setReadState("u1", "c1", "not-a-date")).rejects.toBeInstanceOf(
      WriteQueryError,
    );
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  test("normalizes Date returned from pg to ISO 8601", async () => {
    mockWriteQuery.mockResolvedValue({
      rows: [
        {
          user_id: "u1",
          chat_id: "c1",
          last_read_at: new Date("2026-04-29T10:00:00.000Z"),
        },
      ],
    });
    const result = await setReadState("u1", "c1", "2026-04-29T10:00:00.000Z");
    expect(result).toBe("2026-04-29T10:00:00.000Z");
  });
});
