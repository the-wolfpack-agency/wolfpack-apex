/**
 * record-feedback — happy + error paths.
 *
 * The lib has two side effects: it WRITES one row via `writeQuery` and
 * it FIRES the `assistant.feedback_recorded` analytics event. The tests
 * mock both so the suite runs without a database.
 */

const mockWriteQuery = jest.fn();
const mockQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockNotifyReaders = jest.fn();

class FakeWriteQueryError extends Error {
  readonly code: string;
  constructor(msg: string, code: string) {
    super(msg);
    this.code = code;
  }
}

jest.mock("@/lib/db", () => ({
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  WriteQueryError: FakeWriteQueryError,
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

/* The insert path now fans the new note out to the feedback readers. It is
 * awaited inside recordUserFeedback's own try/catch, so mock it to resolve
 * cleanly: the existing assertions only care that the row was written and the
 * recorded event fired, not that anyone was notified. */
jest.mock("@/lib/feedback/notify-readers", () => ({
  notifyFeedbackReaders: (...args: unknown[]) => mockNotifyReaders(...args),
}));

import {
  recordUserFeedback,
  MAX_FEEDBACK_LENGTH,
  FEEDBACK_DEDUP_WINDOW_SECONDS,
} from "@/lib/feedback/record-feedback";

const BASE_INPUT = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  userEmail: "homyk@thewolfpack.agency",
  userRole: "cto",
  message: "the calendar widget is broken on safari",
  surface: "/assistant",
  workflowId: "00000000-0000-0000-0000-000000000003",
};

beforeEach(() => {
  mockWriteQuery.mockReset();
  mockQuery.mockReset();
  mockTrackEvent.mockReset();
  mockNotifyReaders.mockReset();
  mockNotifyReaders.mockResolvedValue({ recipientCount: 0 });
  /* Default the dedup lookup to "no prior row" so existing happy-path
   * tests fall through to the INSERT path without any change. Tests
   * that exercise the dedup behavior override this. */
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("recordUserFeedback — happy path", () => {
  test("inserts a row and returns the new id + timestamp", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-0000-0000-00000000abcd",
          created_at: "2026-05-19T12:00:00.000Z",
        },
      ],
    });

    const out = await recordUserFeedback(BASE_INPUT);

    expect(out.id).toBe("00000000-0000-0000-0000-00000000abcd");
    expect(out.recordedAt).toBe("2026-05-19T12:00:00.000Z");

    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params, opts] = mockWriteQuery.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO instinct_user_feedback/);
    expect(opts).toEqual({ expectRows: 1 });
    expect(params).toEqual([
      BASE_INPUT.workspaceId,
      BASE_INPUT.userId,
      BASE_INPUT.userEmail,
      BASE_INPUT.userRole,
      BASE_INPUT.message,
      BASE_INPUT.surface,
      null /* userAgent omitted */,
      BASE_INPUT.workflowId,
    ]);
  });

  test("fires assistant.feedback_recorded with feedback_id + surface + message_length + workflow_id", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "id-1", created_at: "2026-05-19T12:00:00.000Z" }],
    });

    await recordUserFeedback(BASE_INPUT);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.feedback_recorded",
      BASE_INPUT.userId,
      BASE_INPUT.userRole,
      expect.objectContaining({
        feedback_id: "id-1",
        surface: BASE_INPUT.surface,
        message_length: BASE_INPUT.message.length,
        workflow_id: BASE_INPUT.workflowId,
      }),
    );
  });

  test("trims whitespace before persisting and length-checking", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "id-2", created_at: "2026-05-19T12:00:00.000Z" }],
    });

    await recordUserFeedback({ ...BASE_INPUT, message: "   ok   " });
    const params = mockWriteQuery.mock.calls[0][1];
    expect(params[4]).toBe("ok");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.feedback_recorded",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ message_length: 2 }),
    );
  });

  test("omits workflow_id from analytics when caller didn't provide one", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "id-3", created_at: "2026-05-19T12:00:00.000Z" }],
    });
    const rest = { ...BASE_INPUT, workflowId: undefined };
    await recordUserFeedback(rest);
    const metadata = mockTrackEvent.mock.calls[0][3];
    expect(metadata).not.toHaveProperty("workflow_id");
  });

  test("notifies the feedback readers with the new id + workspace + author after a successful insert", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "id-notify", created_at: "2026-05-19T12:00:00.000Z" }],
    });
    await recordUserFeedback(BASE_INPUT);
    expect(mockNotifyReaders).toHaveBeenCalledTimes(1);
    expect(mockNotifyReaders).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: BASE_INPUT.workspaceId,
        feedbackId: "id-notify",
        authorUserId: BASE_INPUT.userId,
        authorRole: BASE_INPUT.userRole,
        message: BASE_INPUT.message,
        surface: BASE_INPUT.surface,
      }),
    );
  });

  test("falls back to 'unknown' role/surface in analytics when omitted", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "id-4", created_at: "2026-05-19T12:00:00.000Z" }],
    });
    await recordUserFeedback({
      workspaceId: BASE_INPUT.workspaceId,
      userId: BASE_INPUT.userId,
      message: "hi",
    });
    const userRoleArg = mockTrackEvent.mock.calls[0][2];
    const metadata = mockTrackEvent.mock.calls[0][3];
    expect(userRoleArg).toBe("unknown");
    expect(metadata.surface).toBe("unknown");
  });
});

describe("recordUserFeedback — error paths", () => {
  test("rejects an empty message before writing", async () => {
    await expect(
      recordUserFeedback({ ...BASE_INPUT, message: "   " }),
    ).rejects.toThrow(/message is required/i);
    expect(mockWriteQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("rejects a message longer than the cap before writing", async () => {
    const tooLong = "x".repeat(MAX_FEEDBACK_LENGTH + 1);
    await expect(
      recordUserFeedback({ ...BASE_INPUT, message: tooLong }),
    ).rejects.toThrow(/exceeds/i);
    expect(mockWriteQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("rejects a missing workspaceId / userId", async () => {
    await expect(
      recordUserFeedback({ ...BASE_INPUT, workspaceId: "" }),
    ).rejects.toThrow(/workspaceId is required/i);
    await expect(
      recordUserFeedback({ ...BASE_INPUT, userId: "" }),
    ).rejects.toThrow(/userId is required/i);
  });

  test("propagates writeQuery failures and does NOT fire analytics", async () => {
    mockWriteQuery.mockRejectedValueOnce(
      new FakeWriteQueryError("simulated db failure", "db_error"),
    );
    await expect(recordUserFeedback(BASE_INPUT)).rejects.toThrow(
      /simulated db failure/,
    );
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("recordUserFeedback — dedup window", () => {
  test("returns the existing row's id when an identical submission landed inside the window", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-0000-0000-0000000beef0",
          created_at: "2026-05-22T09:00:00.000Z",
        },
      ],
    });

    const out = await recordUserFeedback(BASE_INPUT);

    expect(out.id).toBe("00000000-0000-0000-0000-0000000beef0");
    expect(out.recordedAt).toBe("2026-05-22T09:00:00.000Z");
    expect(out.deduplicated).toBe(true);
    /* No second INSERT, no second analytics fire — the dashboard
     * counter must match real rows, not retry attempts. */
    expect(mockWriteQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("dedup lookup is scoped by workspace, user, and exact message", async () => {
    /* Stub writeQuery so the call completes after the dedup lookup
     * finds no prior row — we are asserting on the lookup params, not
     * on the INSERT result. */
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-0000-0000-00000000abcd",
          created_at: "2026-05-22T09:00:00.000Z",
        },
      ],
    });
    await recordUserFeedback(BASE_INPUT);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe(BASE_INPUT.workspaceId);
    expect(params[1]).toBe(BASE_INPUT.userId);
    expect(params[2]).toBe(BASE_INPUT.message);
    expect(params[3]).toBe(String(FEEDBACK_DEDUP_WINDOW_SECONDS));
  });

  test("falls through to INSERT when the dedup lookup returns no recent row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-0000-0000-00000000abcd",
          created_at: "2026-05-22T09:00:00.000Z",
        },
      ],
    });
    const out = await recordUserFeedback(BASE_INPUT);
    expect(out.id).toBe("00000000-0000-0000-0000-00000000abcd");
    expect(out.deduplicated).toBeUndefined();
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  });

  test("dedup is per-message: a different body in the same window still inserts", async () => {
    /* First call: no prior row, INSERT. */
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "row-1", created_at: "2026-05-22T09:00:00.000Z" }],
    });
    await recordUserFeedback({ ...BASE_INPUT, message: "first feedback" });

    /* Second call: same window, different message, also INSERT. */
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ id: "row-2", created_at: "2026-05-22T09:00:01.000Z" }],
    });
    const out = await recordUserFeedback({
      ...BASE_INPUT,
      message: "second feedback",
    });
    expect(out.id).toBe("row-2");
    expect(mockWriteQuery).toHaveBeenCalledTimes(2);
  });

  test("a transient dedup-lookup failure does NOT block the write", async () => {
    /* SELECT fails — should still INSERT so a legitimate write isn't
     * lost just because the guardrail tripped. */
    mockQuery.mockRejectedValueOnce(new Error("transient read error"));
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "00000000-0000-0000-0000-00000000feed",
          created_at: "2026-05-22T09:00:00.000Z",
        },
      ],
    });
    const out = await recordUserFeedback(BASE_INPUT);
    expect(out.id).toBe("00000000-0000-0000-0000-00000000feed");
    expect(out.deduplicated).toBeUndefined();
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
  });

  test("FEEDBACK_DEDUP_WINDOW_SECONDS is positive and reasonable (<= 60s)", () => {
    /* If anyone bumps the window to "1 hour" this fires — a long window
     * would block intentional re-submissions and confuse the team. */
    expect(FEEDBACK_DEDUP_WINDOW_SECONDS).toBeGreaterThan(0);
    expect(FEEDBACK_DEDUP_WINDOW_SECONDS).toBeLessThanOrEqual(60);
  });
});
