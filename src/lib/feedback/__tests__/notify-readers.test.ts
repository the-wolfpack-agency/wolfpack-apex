/**
 * notify-readers: fan a new feedback note out to the people who hold the
 * /admin/feedback gate (settings.manage_team), minus the author.
 *
 * The recipient set is resolved through the canonical capability resolver,
 * not a hard-coded role list, so a per-user grant or revoke is honored. The
 * whole path is best-effort: a flaky preferences read must never lose a
 * submitted note, so it can never throw into the feedback write path.
 *
 * Mocks: @/lib/db safeQuery (the active-member list),
 *        @/lib/auth/require-capability effectiveCapabilitiesFor (per member),
 *        @/lib/notifications/in-app notify (the delivery), and trackEvent.
 */

const mockSafeQuery = jest.fn();
const mockEffectiveCaps = jest.fn();
const mockNotify = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  effectiveCapabilitiesFor: (...a: unknown[]) => mockEffectiveCaps(...a),
}));
jest.mock("@/lib/notifications/in-app", () => ({
  notify: (...a: unknown[]) => mockNotify(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  feedbackPreview,
  notifyFeedbackReaders,
} from "@/lib/feedback/notify-readers";

const AUTHOR_ID = "u-author";
const READER_ID = "u-reader";
const NONREADER_ID = "u-nonreader";

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockEffectiveCaps.mockReset();
  mockNotify.mockReset();
  mockTrackEvent.mockReset();
});

describe("feedbackPreview", () => {
  test("collapses runs of whitespace into single spaces and trims", () => {
    expect(feedbackPreview("  hello   there\n\nworld  ")).toBe("hello there world");
  });

  test("returns the whole string unchanged when under the cap", () => {
    expect(feedbackPreview("short note", 140)).toBe("short note");
  });

  test("truncates over the cap and appends a single-char ellipsis", () => {
    const out = feedbackPreview("x".repeat(200), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 9)).toBe("x".repeat(9));
  });
});

/** Build the three-member active list the route would load. */
function threeMembers() {
  return {
    rows: [
      { id: AUTHOR_ID, email: "author@x.com", name: "Author", role: "cto", workspace_id: "w1" },
      { id: READER_ID, email: "reader@x.com", name: "Reader", role: "cto", workspace_id: "w1" },
      { id: NONREADER_ID, email: "member@x.com", name: "Member", role: "ops", workspace_id: "w1" },
    ],
    fromCache: false,
  };
}

/** Resolve caps per member: only the reader has settings.manage_team. */
function capsByMember(user: { id: string }) {
  const caps = new Set<string>();
  if (user.id === READER_ID || user.id === AUTHOR_ID) caps.add("settings.manage_team");
  return Promise.resolve({ capabilities: caps, overrides: {} });
}

describe("notifyFeedbackReaders", () => {
  test("notifies only readers, excluding the author and non-readers", async () => {
    mockSafeQuery.mockResolvedValueOnce(threeMembers());
    mockEffectiveCaps.mockImplementation(capsByMember);
    mockNotify.mockResolvedValue(undefined);

    const out = await notifyFeedbackReaders({
      workspaceId: "w1",
      feedbackId: "fb-1",
      authorUserId: AUTHOR_ID,
      authorRole: "cto",
      authorLabel: "author@x.com",
      message: "the calendar widget is broken",
      surface: "/assistant",
    });

    expect(out.recipientCount).toBe(1);

    // Exactly one delivery: the reader. Author is skipped before caps even
    // resolve; the non-reader fails the capability check.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = mockNotify.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        userId: READER_ID,
        category: "feedback",
        actionUrl: "/admin/feedback",
        source: "feedback",
        sourceId: "fb-1",
        dedup: true,
      }),
    );
    expect(arg.metadata).toEqual(
      expect.objectContaining({ feedback_id: "fb-1", author_user_id: AUTHOR_ID }),
    );

    // The author must never be a recipient.
    const notifiedIds = mockNotify.mock.calls.map((c) => c[0].userId);
    expect(notifiedIds).not.toContain(AUTHOR_ID);
    expect(notifiedIds).not.toContain(NONREADER_ID);
  });

  test("emits assistant.feedback_notified with the real recipient_count", async () => {
    mockSafeQuery.mockResolvedValueOnce(threeMembers());
    mockEffectiveCaps.mockImplementation(capsByMember);
    mockNotify.mockResolvedValue(undefined);

    await notifyFeedbackReaders({
      workspaceId: "w1",
      feedbackId: "fb-1",
      authorUserId: AUTHOR_ID,
      authorRole: "cto",
      message: "broken",
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.feedback_notified",
      AUTHOR_ID,
      "cto",
      expect.objectContaining({ feedback_id: "fb-1", recipient_count: 1 }),
    );
  });

  test("scopes the member lookup to the workspace and active members only", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await notifyFeedbackReaders({
      workspaceId: "w-scope",
      feedbackId: "fb-x",
      authorUserId: AUTHOR_ID,
      message: "hi",
    });
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(String(sql)).toMatch(/FROM instinct_team_members/);
    expect(String(sql)).toMatch(/is_active = true/);
    expect(params).toEqual(["w-scope"]);
  });

  test("a single notify failure does not abort the fanout or throw", async () => {
    mockSafeQuery.mockResolvedValueOnce(threeMembers());
    mockEffectiveCaps.mockImplementation(capsByMember);
    // Reader delivery fails; the function must swallow and still report 0.
    mockNotify.mockRejectedValue(new Error("preferences read failed"));

    const out = await notifyFeedbackReaders({
      workspaceId: "w1",
      feedbackId: "fb-1",
      authorUserId: AUTHOR_ID,
      message: "broken",
    });
    expect(out.recipientCount).toBe(0);
    // It still emits the event (with count 0) and never throws.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.feedback_notified",
      AUTHOR_ID,
      "unknown",
      expect.objectContaining({ recipient_count: 0 }),
    );
  });

  test("never throws when the member lookup rejects (returns recipientCount 0)", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("db unavailable"));
    const out = await notifyFeedbackReaders({
      workspaceId: "w1",
      feedbackId: "fb-1",
      authorUserId: AUTHOR_ID,
      message: "broken",
    });
    expect(out).toEqual({ recipientCount: 0 });
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
