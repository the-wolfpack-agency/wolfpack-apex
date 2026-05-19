/**
 * record-feedback — happy + error paths.
 *
 * The lib has two side effects: it WRITES one row via `writeQuery` and
 * it FIRES the `assistant.feedback_recorded` analytics event. The tests
 * mock both so the suite runs without a database.
 */

const mockWriteQuery = jest.fn();
const mockTrackEvent = jest.fn();

class FakeWriteQueryError extends Error {
  readonly code: string;
  constructor(msg: string, code: string) {
    super(msg);
    this.code = code;
  }
}

jest.mock("@/lib/db", () => ({
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: FakeWriteQueryError,
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  recordUserFeedback,
  MAX_FEEDBACK_LENGTH,
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
  mockTrackEvent.mockReset();
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
