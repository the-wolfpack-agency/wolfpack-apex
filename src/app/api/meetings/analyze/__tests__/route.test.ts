/**
 * Contract tests for POST /api/meetings/analyze.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockSearchMessages = jest.fn();
jest.mock("@/lib/automations/meeting-insights/messages-repo", () => ({
  searchMessages: (...a: unknown[]) => mockSearchMessages(...a),
}));

const mockGetAnalysesByMessageIds = jest.fn();
jest.mock("@/lib/automations/meeting-insights/analyses-repo", () => ({
  getAnalysesByMessageIds: (...a: unknown[]) =>
    mockGetAnalysesByMessageIds(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/meetings/analyze/route";

function req(body: unknown): NextRequest {
  return new NextRequest("http://x/api/meetings/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function allow(role = "ops", id = "u-1") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id, email: "u@t", name: "u", role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function deny(status: 401 | 403) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: "x" }, { status }),
  });
}

beforeEach(() => jest.clearAllMocks());

describe("POST /api/meetings/analyze", () => {
  it("403 without manage capability", async () => {
    deny(403);
    const r = await POST(req({ subject_match: ["x"], sender_match: [] }));
    expect(r.status).toBe(403);
  });

  it("400 on invalid JSON", async () => {
    allow();
    const r = await POST(
      new NextRequest("http://x/api/meetings/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(r.status).toBe(400);
  });

  it("400 when both filter arrays empty", async () => {
    allow();
    const r = await POST(req({ subject_match: [], sender_match: [] }));
    expect(r.status).toBe(400);
  });

  it("400 when since > until", async () => {
    allow();
    const r = await POST(
      req({
        subject_match: ["weekly"],
        sender_match: [],
        since: "2026-05-01",
        until: "2026-04-01",
      }),
    );
    expect(r.status).toBe(400);
  });

  it("200 with empty result when no messages match", async () => {
    allow();
    mockSearchMessages.mockResolvedValueOnce([]);
    mockGetAnalysesByMessageIds.mockResolvedValueOnce(new Map());
    const r = await POST(req({ subject_match: ["x"], sender_match: [] }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      counts: { matched: number; analyzed: number };
    };
    expect(body.counts.matched).toBe(0);
  });

  it("200 with aggregated themes/actions/decisions when analyses present", async () => {
    allow();
    mockSearchMessages.mockResolvedValueOnce([
      {
        id: "m1",
        feed_id: "f1",
        feed_slug: "weekly",
        feed_name: "Weekly",
        subject: "Weekly recap",
        from_address: "a@x",
        received_at: "2026-04-15T00:00:00Z",
      },
      {
        id: "m2",
        feed_id: "f1",
        feed_slug: "weekly",
        feed_name: "Weekly",
        subject: "Weekly kickoff",
        from_address: "a@x",
        received_at: "2026-04-08T00:00:00Z",
      },
    ]);
    mockGetAnalysesByMessageIds.mockResolvedValueOnce(
      new Map([
        [
          "m1",
          {
            id: "a1",
            message_id: "m1",
            summary: null,
            decisions: [{ description: "Ship v1" }],
            action_items: [{ description: "ship", assignee: "alice" }],
            topics: [{ topic: "pricing" }],
            attendees: [],
            blockers: [],
            next_steps: [],
            created_at: "2026-04-15T00:00:00Z",
          },
        ],
        [
          "m2",
          {
            id: "a2",
            message_id: "m2",
            summary: null,
            decisions: [],
            action_items: [{ description: "ship", assignee: "alice" }],
            topics: [{ topic: "Pricing" }],
            attendees: [],
            blockers: [],
            next_steps: [],
            created_at: "2026-04-08T00:00:00Z",
          },
        ],
      ]),
    );
    const r = await POST(
      req({
        subject_match: ["Weekly"],
        sender_match: [],
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      counts: { matched: number; analyzed: number; feeds_touched: number };
      aggregated_themes: { topic: string; mention_count: number }[];
      aggregated_action_items: unknown[];
      aggregated_decisions: unknown[];
    };
    expect(body.counts.matched).toBe(2);
    expect(body.counts.analyzed).toBe(2);
    expect(body.counts.feeds_touched).toBe(1);
    expect(body.aggregated_themes[0].mention_count).toBe(2);
    expect(body.aggregated_action_items).toHaveLength(1);
    expect(body.aggregated_decisions).toHaveLength(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "meeting_insights.analyze_run",
      "u-1",
      "ops",
      expect.objectContaining({ matched: 2, analyzed: 2 }),
    );
  });
});
