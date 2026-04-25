/**
 * Contract tests for the /api/meetings/feeds route family.
 *
 * Auth, validation, idempotency, happy paths. requireCapability and
 * the feeds-repo are mocked.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockListFeeds = jest.fn();
const mockGetFeedBySlug = jest.fn();
const mockCreateFeed = jest.fn();
const mockUpdateFeed = jest.fn();
const mockDisableFeed = jest.fn();
jest.mock("@/lib/automations/meeting-insights/feeds-repo", () => ({
  listFeeds: (...a: unknown[]) => mockListFeeds(...a),
  getFeedBySlug: (...a: unknown[]) => mockGetFeedBySlug(...a),
  createFeed: (...a: unknown[]) => mockCreateFeed(...a),
  updateFeed: (...a: unknown[]) => mockUpdateFeed(...a),
  disableFeed: (...a: unknown[]) => mockDisableFeed(...a),
  unionEnabledFilters: jest.fn(),
}));

const mockListMessagesForFeed = jest.fn();
const mockGetMessage = jest.fn();
const mockListAttachments = jest.fn();
jest.mock("@/lib/automations/meeting-insights/messages-repo", () => ({
  listMessagesForFeed: (...a: unknown[]) => mockListMessagesForFeed(...a),
  getMessage: (...a: unknown[]) => mockGetMessage(...a),
  listAttachmentsForMessage: (...a: unknown[]) => mockListAttachments(...a),
}));

const mockPollInbox = jest.fn();
jest.mock("@/lib/automations/inbox-poller", () => ({
  pollInbox: (...a: unknown[]) => mockPollInbox(...a),
  pollInboxHistorical: (...a: unknown[]) => mockPollInbox(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET as feedsGET, POST as feedsPOST } from "@/app/api/meetings/feeds/route";
import {
  GET as feedDetailGET,
  PUT as feedDetailPUT,
  DELETE as feedDetailDELETE,
} from "@/app/api/meetings/feeds/[slug]/route";
import { POST as pollPOST } from "@/app/api/meetings/feeds/[slug]/poll/route";
import { GET as messagesGET } from "@/app/api/meetings/feeds/[slug]/messages/route";
import { GET as messageGET } from "@/app/api/meetings/feeds/[slug]/messages/[messageId]/route";
import { GET as downloadGET } from "@/app/api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/download/route";

function req(method: string, url: string, body?: unknown): NextRequest {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new NextRequest(url, init);
}

function allow(role = "ops", userId = "u-1", email = "u@t") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: userId, email, name: email, role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function deny(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

const PARAMS = (slug: string) => ({ params: Promise.resolve({ slug }) });
const PARAMS_MSG = (slug: string, messageId: string) => ({
  params: Promise.resolve({ slug, messageId }),
});
const PARAMS_DL = (slug: string, messageId: string, attachmentId: string) => ({
  params: Promise.resolve({ slug, messageId, attachmentId }),
});

beforeEach(() => {
  jest.clearAllMocks();
});

const FEED = {
  id: "f-1",
  slug: "weekly",
  name: "Weekly",
  description: null,
  filters: { sender_match: ["@x"], subject_match: [], since: undefined },
  is_enabled: true,
  created_by: "u@t",
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

/* ------------------------------------------------------------------ */
/* GET /api/meetings/feeds                                             */
/* ------------------------------------------------------------------ */

describe("GET /api/meetings/feeds", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await feedsGET(req("GET", "http://x/api/meetings/feeds"));
    expect(r.status).toBe(401);
  });

  it("200 returns feeds array", async () => {
    allow();
    mockListFeeds.mockResolvedValueOnce([FEED]);
    const r = await feedsGET(req("GET", "http://x/api/meetings/feeds"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { feeds: { id: string }[] };
    expect(body.feeds).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/meetings/feeds                                            */
/* ------------------------------------------------------------------ */

describe("POST /api/meetings/feeds", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await feedsPOST(
      req("POST", "http://x/api/meetings/feeds", { name: "x", filters: {} }),
    );
    expect(r.status).toBe(401);
  });

  it("400 on invalid input", async () => {
    allow();
    const r = await feedsPOST(req("POST", "http://x/api/meetings/feeds", { name: "" }));
    expect(r.status).toBe(400);
  });

  it("400 on non-JSON body", async () => {
    allow();
    const init: ConstructorParameters<typeof NextRequest>[1] = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    };
    const r = await feedsPOST(new NextRequest("http://x/api/meetings/feeds", init));
    expect(r.status).toBe(400);
  });

  it("201 creates a feed and emits analytics", async () => {
    allow("ops", "u-1", "alicia@t");
    mockCreateFeed.mockResolvedValueOnce(FEED);
    const r = await feedsPOST(
      req("POST", "http://x/api/meetings/feeds", {
        name: "Weekly",
        filters: { sender_match: ["@x"], subject_match: [] },
      }),
    );
    expect(r.status).toBe(201);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.feed_created",
      "u-1",
      "ops",
      expect.objectContaining({ feed_slug: "weekly" }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* GET / PUT / DELETE /api/meetings/feeds/[slug]                       */
/* ------------------------------------------------------------------ */

describe("GET /api/meetings/feeds/[slug]", () => {
  it("404 when slug unknown", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await feedDetailGET(
      req("GET", "http://x/api/meetings/feeds/x"),
      PARAMS("x"),
    );
    expect(r.status).toBe(404);
  });

  it("200 returns the feed", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    const r = await feedDetailGET(
      req("GET", "http://x/api/meetings/feeds/weekly"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(200);
  });
});

describe("PUT /api/meetings/feeds/[slug]", () => {
  it("403 without manage capability", async () => {
    deny(403, "forbidden");
    const r = await feedDetailPUT(
      req("PUT", "http://x/api/meetings/feeds/weekly", { name: "X" }),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(403);
  });

  it("400 on invalid patch", async () => {
    allow();
    const r = await feedDetailPUT(
      req("PUT", "http://x/api/meetings/feeds/weekly", { name: "" }),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(400);
  });

  it("404 when slug missing", async () => {
    allow();
    mockUpdateFeed.mockResolvedValueOnce(null);
    const r = await feedDetailPUT(
      req("PUT", "http://x/api/meetings/feeds/weekly", { name: "Other" }),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(404);
  });

  it("200 patches and fires analytics", async () => {
    allow("ops", "u-1");
    mockUpdateFeed.mockResolvedValueOnce({ ...FEED, name: "Renamed" });
    const r = await feedDetailPUT(
      req("PUT", "http://x/api/meetings/feeds/weekly", { name: "Renamed" }),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.feed_updated",
      "u-1",
      "ops",
      expect.objectContaining({ fields: "name" }),
    );
  });
});

describe("DELETE /api/meetings/feeds/[slug]", () => {
  it("200 soft-deletes and fires analytics", async () => {
    allow("ops", "u-1");
    mockDisableFeed.mockResolvedValueOnce({ ...FEED, is_enabled: false });
    const r = await feedDetailDELETE(
      req("DELETE", "http://x/api/meetings/feeds/weekly"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.feed_disabled",
      "u-1",
      "ops",
      expect.objectContaining({ feed_slug: "weekly" }),
    );
  });

  it("404 when feed not found", async () => {
    allow();
    mockDisableFeed.mockResolvedValueOnce(null);
    const r = await feedDetailDELETE(
      req("DELETE", "http://x/api/meetings/feeds/weekly"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/meetings/feeds/[slug]/poll                                */
/* ------------------------------------------------------------------ */

describe("POST /api/meetings/feeds/[slug]/poll", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await pollPOST(
      req("POST", "http://x/api/meetings/feeds/weekly/poll"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(401);
  });

  it("404 when feed missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await pollPOST(
      req("POST", "http://x/api/meetings/feeds/weekly/poll"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(404);
  });

  it("409 when feed disabled", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce({ ...FEED, is_enabled: false });
    const r = await pollPOST(
      req("POST", "http://x/api/meetings/feeds/weekly/poll"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(409);
  });

  it("200 returns the poll result", async () => {
    allow("ops", "u-1");
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockPollInbox.mockResolvedValueOnce({
      automation_id: "meeting-insights",
      messages_seen: 1,
      messages_matched: 1,
      artifacts_ingested: 1,
      artifacts_duplicate: 0,
      artifacts_quarantined: 0,
      errors: 0,
      duration_ms: 1,
    });
    const r = await pollPOST(
      req("POST", "http://x/api/meetings/feeds/weekly/poll"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/meetings/feeds/[slug]/messages                             */
/* ------------------------------------------------------------------ */

describe("GET /api/meetings/feeds/[slug]/messages", () => {
  it("404 when feed missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await messagesGET(
      req("GET", "http://x/api/meetings/feeds/x/messages"),
      PARAMS("x"),
    );
    expect(r.status).toBe(404);
  });

  it("200 returns messages", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockListMessagesForFeed.mockResolvedValueOnce([]);
    const r = await messagesGET(
      req("GET", "http://x/api/meetings/feeds/weekly/messages"),
      PARAMS("weekly"),
    );
    expect(r.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/meetings/feeds/[slug]/messages/[messageId]                 */
/* ------------------------------------------------------------------ */

describe("GET /api/meetings/feeds/[slug]/messages/[messageId]", () => {
  it("404 when feed missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await messageGET(
      req("GET", "http://x/api/meetings/feeds/x/messages/y"),
      PARAMS_MSG("x", "y"),
    );
    expect(r.status).toBe(404);
  });

  it("404 when message missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(null);
    const r = await messageGET(
      req("GET", "http://x/api/meetings/feeds/weekly/messages/y"),
      PARAMS_MSG("weekly", "y"),
    );
    expect(r.status).toBe(404);
  });

  it("200 returns message + attachments", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce({ id: "m-1", subject: "Hi" });
    mockListAttachments.mockResolvedValueOnce([]);
    const r = await messageGET(
      req("GET", "http://x/api/meetings/feeds/weekly/messages/m-1"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* GET .../attachments/[id]/download (Stream B stub)                   */
/* ------------------------------------------------------------------ */

describe("GET .../attachments/[id]/download", () => {
  it("403 without meetings.export", async () => {
    deny(403, "forbidden");
    const r = await downloadGET(
      req("GET", "http://x/dl"),
      PARAMS_DL("weekly", "m-1", "att-1"),
    );
    expect(r.status).toBe(403);
  });

  /* Stream B replaced the 501 stub with the real bytes-streaming
     implementation. The full coverage (200 / 401 / 404 / mime / DB
     query shape) lives alongside the route file at
     .../download/__tests__/route.test.ts where it can mock the db
     module. Only the auth gate stays here — that's framework-level
     and doesn't depend on the route body. */
});
