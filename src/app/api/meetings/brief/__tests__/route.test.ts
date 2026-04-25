/**
 * Contract tests for GET /api/meetings/brief.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockAssembleBrief = jest.fn();
jest.mock("@/lib/automations/meeting-insights/brief", () => ({
  assembleBrief: (...a: unknown[]) => mockAssembleBrief(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/meetings/brief/route";

function req(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
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

describe("GET /api/meetings/brief", () => {
  it("401 without auth", async () => {
    deny(401);
    const r = await GET(req("http://x/api/meetings/brief?title=x"));
    expect(r.status).toBe(401);
  });

  it("400 when title missing", async () => {
    allow();
    const r = await GET(req("http://x/api/meetings/brief"));
    expect(r.status).toBe(400);
  });

  it("200 with brief: null when no feed matches", async () => {
    allow();
    mockAssembleBrief.mockResolvedValueOnce(null);
    const r = await GET(req("http://x/api/meetings/brief?title=Stand-up&start=2026-04-22"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ brief: null });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "meeting_insights.brief_viewed",
      "u-1",
      "ops",
      expect.objectContaining({ matched: false }),
    );
  });

  it("200 with brief payload when feed matches", async () => {
    allow();
    mockAssembleBrief.mockResolvedValueOnce({
      feed: { id: "f1", slug: "weekly", name: "Weekly" },
      recent_messages: [],
      open_action_items: [],
      recurring_topics: [],
      exception_count: 2,
    });
    const r = await GET(req("http://x/api/meetings/brief?title=Weekly"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { brief: { feed: { slug: string } } };
    expect(body.brief.feed.slug).toBe("weekly");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "meeting_insights.brief_viewed",
      "u-1",
      "ops",
      expect.objectContaining({ matched: true, feed_slug: "weekly", exception_count: 2 }),
    );
  });

  it("passes attendee[] through to the assembler", async () => {
    allow();
    mockAssembleBrief.mockResolvedValueOnce(null);
    await GET(
      req(
        "http://x/api/meetings/brief?title=foo&start=now&attendee=a%40x&attendee=b%40x",
      ),
    );
    expect(mockAssembleBrief).toHaveBeenCalledWith("foo", "now", ["a@x", "b@x"]);
  });
});
