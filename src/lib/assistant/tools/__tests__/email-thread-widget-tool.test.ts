/**
 * email_thread_widget tool — intent matching + handler shape.
 */

const mockFetchRecentEmails = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchRecentEmails: (...a: unknown[]) => mockFetchRecentEmails(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { emailThreadWidgetTool } from "@/lib/assistant/tools/email-thread-widget-tool";

const match = (q: string) => emailThreadWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "member" };

beforeEach(() => {
  mockFetchRecentEmails.mockReset();
  mockTrackEvent.mockReset();
});

describe("email_thread_widget intent matching", () => {
  test.each([
    "inbox",
    "Inbox",
    "show me my inbox",
    "show inbox",
    "recent emails",
    "show my email",
    "show my emails",
    "show me my recent emails",
    "email widget",
    "inbox.",
    "inbox?",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "send an email to alice",
    "create email",
    "any emails from hoxsie",
    "find emails about q3",
    "search inbox for porsche",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("email_thread_widget handler", () => {
  test("returns widget spec + maps Graph emails + fires analytics", async () => {
    mockFetchRecentEmails.mockResolvedValue([
      {
        id: "mid-1",
        subject: "Quarterly review",
        from: "Nick Hoxsie",
        fromEmail: "hoxsie@thewolfpack.agency",
        receivedDateTime: "2026-05-16T15:00:00Z",
        bodyPreview: "Hey, can you review the Q3 numbers?",
        isRead: false,
        importance: "high",
        webLink: "https://outlook.office.com/mid-1",
      },
    ]);
    const res = await emailThreadWidgetTool.handler({ count: 10 }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget?.kind).toBe("email_thread");
    const spec = res.widget as { kind: "email_thread"; messages: { id: string; preview: string }[] };
    expect(spec.messages).toHaveLength(1);
    expect(spec.messages[0].id).toBe("mid-1");
    expect(spec.messages[0].preview).toMatch(/Q3 numbers/);
    expect(res.answer).toMatch(/1 unread/);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "member",
      expect.objectContaining({ widget_kind: "email_thread", message_count: 1 }),
    );
  });

  test("Graph failure → friendly answer, empty events", async () => {
    mockFetchRecentEmails.mockRejectedValue(new Error("Graph 503"));
    const res = await emailThreadWidgetTool.handler({ count: 10 }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.widget as { messages: unknown[] }).messages).toEqual([]);
    expect(res.answer).toMatch(/couldn't reach Outlook/i);
  });

  test("empty inbox returns 'looks empty'", async () => {
    mockFetchRecentEmails.mockResolvedValue([]);
    const res = await emailThreadWidgetTool.handler({ count: 10 }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toMatch(/looks empty/i);
  });

  test("preview is truncated when bodyPreview is long", async () => {
    mockFetchRecentEmails.mockResolvedValue([
      {
        id: "long",
        subject: "x",
        from: "x",
        fromEmail: "x@y.z",
        receivedDateTime: "2026-05-16T15:00:00Z",
        bodyPreview: "a".repeat(500),
        isRead: true,
        importance: "normal",
      },
    ]);
    const res = await emailThreadWidgetTool.handler({ count: 10 }, CTX);
    if (!res.ok) return;
    const spec = res.widget as { messages: { preview: string }[] };
    expect(spec.messages[0].preview.length).toBeLessThanOrEqual(120);
    expect(spec.messages[0].preview.endsWith("…")).toBe(true);
  });
});
