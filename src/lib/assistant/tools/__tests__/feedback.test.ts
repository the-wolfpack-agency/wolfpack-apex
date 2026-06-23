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
  /* IMMEDIATE-WRITE forms: an explicit command (leading slash OR a colon
     separator) with a non-empty body returns that body so the handler
     records it right away. */
  test.each([
    ["/feedback hi", "hi"],
    ["/feedback the calendar widget is broken", "the calendar widget is broken"],
    ["/Feedback Caps Stem Works", "Caps Stem Works"],
    ["feedback: hi", "hi"],
    ["feedback: the calendar widget is broken", "the calendar widget is broken"],
    ["i have feedback: hi", "hi"],
    ["share feedback: hi", "hi"],
    ["share feedback: please add a dark theme", "please add a dark theme"],
  ])("'%s' records immediately with body %j", (q, expected) => {
    const out = matchFeedbackIntent(q);
    expect(out).not.toBeNull();
    expect(out?.message).toBe(expected);
  });

  /* COMPOSE forms: bare verb stem, OR natural language with a body but NO
     slash and NO colon. These must return an EMPTY body so the handler opens
     the compose widget and NEVER writes silently. This is the fix for the
     duplicate-rows bug (a "share feedback about Instinct" chip used to write a
     row on every click). */
  test.each([
    ["feedback", ""],
    ["/feedback", ""],
    ["/feedback ", ""],
    ["/Feedback", ""],
    ["i have feedback", ""],
    ["share feedback", ""],
    ["share feedback about Instinct", ""],
    ["feedback about the calendar", ""],
    ["i have feedback the layout shifts on mobile", ""],
    ["share feedback please add a dark theme", ""],
  ])("'%s' opens compose (empty body, no write)", (q) => {
    const out = matchFeedbackIntent(q);
    expect(out).not.toBeNull();
    expect(out?.message).toBe("");
  });

  /* NOT a feedback intent: the verb stem does not lead the message, or it is a
     plural noun in a different sentence. */
  test.each([
    "",
    "find emails about feedback",
    "what's the feedback survey link",
    "feedbacks dashboard",
    "feedbacks are great",
  ])("'%s' does NOT match", (q) => {
    expect(matchFeedbackIntent(q)).toBeNull();
  });

  test("rejects oversized free-text at intent time (explicit command form)", () => {
    const tooBig = "/feedback " + "x".repeat(2001);
    expect(matchFeedbackIntent(tooBig)).toBeNull();
  });
});

describe("feedback handler: compose mode never writes for natural language", () => {
  /* End-to-end guard: feeding a natural-language phrase through
     matchIntent -> handler must NOT call recordUserFeedback. This is the
     exact path the starter chip "share feedback about Instinct" took when it
     was silently writing a row on every click. */
  test.each([
    "share feedback about Instinct",
    "feedback about the calendar",
    "i have feedback",
    "feedback",
  ])("'%s' routes to compose without recording", async (q) => {
    const params = matchFeedbackIntent(q);
    expect(params).not.toBeNull();
    const res = await feedbackTool.handler(params!, CTX);
    expect(res.ok).toBe(true);
    expect(mockRecordUserFeedback).not.toHaveBeenCalled();
    if (!res.ok) return;
    const spec = res.widget as { mode?: string };
    expect(spec.mode).toBe("compose");
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
