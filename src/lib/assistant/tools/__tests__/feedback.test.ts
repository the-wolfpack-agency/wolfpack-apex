/**
 * feedback tool — intent matching + handler in both "recorded" (slash
 * with body) and "compose" (bare slash) modes.
 *
 * Covers:
 *   - matchIntent variants ("/feedback", "/feedback X", "i have
 *     feedback", "feedback:" with body)
 *   - handler success path writes via the lib + returns the widget in
 *     mode=recorded with the short id surfaced in the answer
 *   - handler compose path returns the widget in mode=compose WITHOUT
 *     writing
 *   - handler propagates a lib failure as a tool failure (ok:false,
 *     code:"internal")
 *   - assistant.widget_offered fires with widget_kind=feedback and
 *     forwards workflow_id when present
 */

const mockRecordUserFeedback = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/feedback/record-feedback", () => ({
  recordUserFeedback: (...a: unknown[]) => mockRecordUserFeedback(...a),
  MAX_FEEDBACK_LENGTH: 2000,
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  matchFeedbackIntent,
  feedbackTool,
} from "@/lib/assistant/tools/feedback";

const CTX = {
  userId: "00000000-0000-0000-0000-000000000010",
  userRole: "cto",
  userEmail: "homyk@thewolfpack.agency",
  workspaceId: "00000000-0000-0000-0000-000000000099",
};

beforeEach(() => {
  mockRecordUserFeedback.mockReset();
  mockTrackEvent.mockReset();
});

describe("feedback intent matching", () => {
  test.each([
    ["/feedback", ""],
    ["/feedback ", ""],
    ["/Feedback", ""],
    ["feedback", ""],
    ["i have feedback", ""],
    ["share feedback", ""],
    ["/feedback the calendar widget is broken", "the calendar widget is broken"],
    ["feedback: the calendar widget is broken", "the calendar widget is broken"],
    ["feedback the calendar widget is broken", "the calendar widget is broken"],
    ["i have feedback the layout shifts on mobile", "the layout shifts on mobile"],
    ["share feedback please add a dark theme", "please add a dark theme"],
  ])("'%s' matches with body %j", (q, expected) => {
    const out = matchFeedbackIntent(q);
    expect(out).not.toBeNull();
    expect(out?.message).toBe(expected);
  });

  test.each([
    "",
    "find emails about feedback",
    "what's the feedback survey link",
    "feedbacks dashboard",
  ])("'%s' does NOT match", (q) => {
    expect(matchFeedbackIntent(q)).toBeNull();
  });

  test("rejects oversized free-text at intent time", () => {
    const tooBig = "/feedback " + "x".repeat(2001);
    expect(matchFeedbackIntent(tooBig)).toBeNull();
  });
});

describe("feedback handler — recorded mode (slash with body)", () => {
  test("calls recordUserFeedback with the message, surface, workspace/user from ctx", async () => {
    mockRecordUserFeedback.mockResolvedValueOnce({
      id: "abcd1234-0000-0000-0000-000000000000",
      recordedAt: "2026-05-19T12:00:00.000Z",
    });
    const res = await feedbackTool.handler(
      { message: "calendar widget is broken" },
      { ...CTX, workflowId: "wf-1" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(mockRecordUserFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: CTX.workspaceId,
        userId: CTX.userId,
        userEmail: CTX.userEmail,
        userRole: CTX.userRole,
        message: "calendar widget is broken",
        surface: "/assistant",
        workflowId: "wf-1",
      }),
    );

    expect(res.widget).toEqual(
      expect.objectContaining({
        kind: "feedback",
        mode: "recorded",
        feedbackId: "abcd1234-0000-0000-0000-000000000000",
        message: "calendar widget is broken",
        surface: "/assistant",
        submitUrl: "/api/feedback",
      }),
    );
    /* The answer should surface a human-readable short id. */
    expect(res.answer).toMatch(/recorded as #abcd1234/i);
  });

  test("fires assistant.widget_offered (kind=feedback, mode=recorded) with workflow_id", async () => {
    mockRecordUserFeedback.mockResolvedValueOnce({
      id: "00000000-0000-0000-0000-00000000abcd",
      recordedAt: "2026-05-19T12:00:00.000Z",
    });
    await feedbackTool.handler(
      { message: "great" },
      { ...CTX, workflowId: "wf-1" },
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      CTX.userId,
      CTX.userRole,
      expect.objectContaining({
        widget_kind: "feedback",
        mode: "recorded",
        workflow_id: "wf-1",
      }),
    );
  });

  test("returns ok:false / internal when the lib throws", async () => {
    mockRecordUserFeedback.mockRejectedValueOnce(new Error("db is down"));
    const res = await feedbackTool.handler({ message: "hi" }, CTX);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("internal");
    expect(res.message).toMatch(/db is down/);
  });
});

describe("feedback handler — compose mode (bare slash)", () => {
  test("does NOT call recordUserFeedback when message is empty", async () => {
    const res = await feedbackTool.handler({ message: "" }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mockRecordUserFeedback).not.toHaveBeenCalled();
    expect(res.widget).toEqual(
      expect.objectContaining({
        kind: "feedback",
        mode: "compose",
        submitUrl: "/api/feedback",
      }),
    );
    expect(res.answer).toMatch(/drop a note/i);
  });

  test("treats whitespace-only message as compose", async () => {
    const res = await feedbackTool.handler({ message: "   " }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mockRecordUserFeedback).not.toHaveBeenCalled();
    const spec = res.widget as { mode?: string };
    expect(spec.mode).toBe("compose");
  });

  test("fires assistant.widget_offered (kind=feedback, mode=compose)", async () => {
    await feedbackTool.handler({ message: "" }, { ...CTX, workflowId: "wf-2" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      CTX.userId,
      CTX.userRole,
      expect.objectContaining({
        widget_kind: "feedback",
        mode: "compose",
        workflow_id: "wf-2",
      }),
    );
  });
});

describe("feedback tool metadata", () => {
  test("name + capability + description", () => {
    expect(feedbackTool.name).toBe("feedback");
    expect(feedbackTool.capability).toBe("assistant.use");
    expect(feedbackTool.description.length).toBeGreaterThan(20);
  });
});
