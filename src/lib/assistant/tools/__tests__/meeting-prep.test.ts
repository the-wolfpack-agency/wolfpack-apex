/**
 * meeting_prep tool — intent matching + handler + widget shape.
 */

const mockFetchCalendarEvents = jest.fn();
const mockPrepareMeeting = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: unknown[]) => mockFetchCalendarEvents(...a),
}));
jest.mock("@/lib/insights/meeting-prep", () => ({
  prepareMeeting: (...a: unknown[]) => mockPrepareMeeting(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { meetingPrepTool } from "@/lib/assistant/tools/meeting-prep";

const CTX = { userId: "u1", userRole: "cto", workspaceId: "ws-a" };
const match = (q: string) => meetingPrepTool.matchIntent!(q);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("meeting_prep intent matching", () => {
  test.each([
    "prep for my next meeting",
    "Prep for my next meeting",
    "brief me for my next meeting",
    "prep for my meeting",
    "meeting prep",
    "Meeting Prep",
    "what should i know about my next meeting",
    "what should i know for my next meeting?",
    "prep me for my next call",
    "brief me for my next sync",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "show me my calendar",
    "send an email to alice",
    "prep something else entirely without the m-word",
    "schedule a meeting with alice",
    "any meetings tomorrow",
  ])("'%s' does NOT match", (q) => {
    expect(match(q)).toBeNull();
  });

  test("captures attendee hint after 'with'", () => {
    const result = match("prep for my meeting with Acme");
    expect(result).not.toBeNull();
    expect(result!.eventHint).toBe("Acme");
  });
});

describe("meeting_prep handler", () => {
  test("returns empty-state answer when no upcoming meeting found", async () => {
    mockFetchCalendarEvents.mockResolvedValue([]);
    const res = await meetingPrepTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toMatch(/don't see a meeting/i);
    expect(res.widget).toBeUndefined();
    expect(mockPrepareMeeting).not.toHaveBeenCalled();
  });

  test("resolves next meeting + returns synthesized widget on success", async () => {
    const nowIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "Acme sync",
        start: nowIso,
        end: nowIso,
        location: "Teams",
        attendees: ["Alice"],
        attendeeEmails: ["alice@acme.example"],
        isOnlineMeeting: true,
      },
    ]);
    mockPrepareMeeting.mockResolvedValue({
      prep: {
        summary: "Quick alignment with Alice.",
        goal: "Confirm priorities",
        talking_points: [
          {
            point: "Q3 OKR confirmation",
            source_refs: [{ type: "brain", id: "k-1", label: "OKR doc" }],
          },
        ],
        risk_flags: [
          {
            flag: "Deal stalled",
            severity: "high",
            source_refs: [{ type: "crm", id: "opp-1", label: "Opp" }],
          },
        ],
        attendee_briefs: [
          {
            email: "alice@acme.example",
            name: "Alice",
            one_liner: "VP Ops",
            key_facts: ["Hired 2024"],
            links: [],
          },
        ],
        open_questions: ["Launch date?"],
      },
      sources: {},
      sourceHash: "h-1",
      cacheStatus: "miss",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: false,
    });

    const res = await meetingPrepTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget?.kind).toBe("meeting_prep");
    const spec = res.widget as { kind: string; talking_points: unknown[]; risk_flags: { severity: string }[]; viewerCanRegenerate: boolean };
    expect(spec.talking_points).toHaveLength(1);
    expect(spec.risk_flags[0].severity).toBe("high");
    expect(spec.viewerCanRegenerate).toBe(true);
    expect(res.answer).toMatch(/freshly generated/);
  });

  test("cache hit answer pill says 'shared with your team'", async () => {
    const nowIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "Acme sync",
        start: nowIso,
        end: nowIso,
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
    ]);
    mockPrepareMeeting.mockResolvedValue({
      prep: {
        summary: "x",
        goal: "x",
        talking_points: [],
        risk_flags: [],
        attendee_briefs: [],
        open_questions: [],
      },
      sources: {},
      sourceHash: "h-1",
      cacheStatus: "hit",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: false,
    });
    const res = await meetingPrepTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toMatch(/shared with your team/i);
  });

  test("synthesis_unavailable yields an empty widget + clear answer", async () => {
    const nowIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "x",
        start: nowIso,
        end: nowIso,
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
    ]);
    mockPrepareMeeting.mockResolvedValue({
      prep: null,
      sources: {},
      sourceHash: "h",
      cacheStatus: "miss",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: true,
      synthesisErrorCode: "invalid_json",
    });
    const res = await meetingPrepTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget?.kind).toBe("meeting_prep");
    const spec = res.widget as { synthesisUnavailable: boolean };
    expect(spec.synthesisUnavailable).toBe(true);
    expect(res.answer).toMatch(/couldn't synthesize/i);
  });

  test("non-manager role gets viewerCanRegenerate=false", async () => {
    const nowIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mockFetchCalendarEvents.mockResolvedValue([
      {
        id: "evt-1",
        subject: "x",
        start: nowIso,
        end: nowIso,
        location: "",
        attendees: [],
        attendeeEmails: [],
        isOnlineMeeting: false,
      },
    ]);
    mockPrepareMeeting.mockResolvedValue({
      prep: {
        summary: "x",
        goal: "x",
        talking_points: [],
        risk_flags: [],
        attendee_briefs: [],
        open_questions: [],
      },
      sources: {},
      sourceHash: "h",
      cacheStatus: "miss",
      generatedAt: "2026-05-19T00:00:00Z",
      synthesisUnavailable: false,
    });
    const res = await meetingPrepTool.handler(
      {},
      { ...CTX, userRole: "dev" },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spec = res.widget as { viewerCanRegenerate: boolean };
    expect(spec.viewerCanRegenerate).toBe(false);
  });
});
