/**
 * Contract tests for the Phase 2/3 analysis + themes API routes.
 *
 *   GET    /api/meetings/feeds/[slug]/messages/[messageId]/analysis
 *   POST   /api/meetings/feeds/[slug]/messages/[messageId]/analysis/regenerate
 *   GET    /api/meetings/feeds/[slug]/themes
 *   GET    /api/meetings/feeds/[slug]/search
 *
 * requireCapability + repos are mocked. No DB, no LLM.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockGetFeedBySlug = jest.fn();
jest.mock("@/lib/automations/meeting-insights/feeds-repo", () => ({
  getFeedBySlug: (...a: unknown[]) => mockGetFeedBySlug(...a),
}));

const mockGetMessage = jest.fn();
jest.mock("@/lib/automations/meeting-insights/messages-repo", () => ({
  getMessage: (...a: unknown[]) => mockGetMessage(...a),
}));

const mockGetLatestAnalysis = jest.fn();
jest.mock("@/lib/automations/meeting-insights/analyses-repo", () => ({
  getLatestAnalysisForMessage: (...a: unknown[]) => mockGetLatestAnalysis(...a),
  upsertAnalysis: jest.fn(),
}));

const mockRunAnalyzer = jest.fn();
jest.mock("@/lib/automations/meeting-insights/run-analyzer", () => ({
  runAnalyzer: (...a: unknown[]) => mockRunAnalyzer(...a),
}));

const mockIsAnalyzerAvailable = jest.fn(() => true);
jest.mock("@/lib/automations/meeting-insights/analyzer/anthropic", () => ({
  isAnalyzerAvailable: () => mockIsAnalyzerAvailable(),
}));

const mockRecurring = jest.fn();
const mockStale = jest.fn();
const mockOpenActions = jest.fn();
const mockSemantic = jest.fn();
jest.mock("@/lib/automations/meeting-insights/themes", () => ({
  recurringTopics: (...a: unknown[]) => mockRecurring(...a),
  staleTopics: (...a: unknown[]) => mockStale(...a),
  openActionItems: (...a: unknown[]) => mockOpenActions(...a),
  semanticSearch: (...a: unknown[]) => mockSemantic(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET as analysisGET } from "@/app/api/meetings/feeds/[slug]/messages/[messageId]/analysis/route";
import {
  POST as regeneratePOST,
  __test__ as regenerateTestExports,
} from "@/app/api/meetings/feeds/[slug]/messages/[messageId]/analysis/regenerate/route";
import { GET as themesGET } from "@/app/api/meetings/feeds/[slug]/themes/route";
import { GET as searchGET } from "@/app/api/meetings/feeds/[slug]/search/route";

function req(method: string, url: string, body?: unknown): NextRequest {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new NextRequest(url, init);
}

function allow(role = "ops", userId = "u-1") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: { id: userId, email: "u@t", name: "u", role, created_at: "" },
    capabilities: new Set<string>(),
  });
}

function deny(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

const FEED = {
  id: "f-1",
  slug: "weekly",
  name: "Weekly",
  description: null,
  filters: { sender_match: [], subject_match: [] },
  is_enabled: true,
  created_by: "u@t",
  created_at: "",
  updated_at: "",
};

const MSG = {
  id: "m-1",
  feed_id: "f-1",
  source_message_id: "src",
  artifact_id: "a",
  subject: "Weekly",
  from_address: "a@x",
  from_name: null,
  to_addresses: [],
  cc_addresses: [],
  received_at: "2026-04-01T00:00:00Z",
  body_text: "",
  body_html: null,
  has_attachments: false,
  created_at: "",
};

const PARAMS_MSG = (slug: string, messageId: string) => ({
  params: Promise.resolve({ slug, messageId }),
});
const PARAMS_FEED = (slug: string) => ({
  params: Promise.resolve({ slug }),
});

beforeEach(() => {
  jest.clearAllMocks();
  // mockResolvedValueOnce queues are not flushed by clearAllMocks, so
  // explicitly drain them between tests to avoid leftover mocks
  // affecting later expectations.
  for (const fn of [
    mockRequireCapability,
    mockGetFeedBySlug,
    mockGetMessage,
    mockGetLatestAnalysis,
    mockRunAnalyzer,
    mockRecurring,
    mockStale,
    mockOpenActions,
    mockSemantic,
    mockTrackEvent,
  ]) {
    fn.mockReset();
  }
  mockIsAnalyzerAvailable.mockReturnValue(true);
  // Clear the in-memory rate-limit cache between tests.
  if (regenerateTestExports?.recenteranalyses) {
    regenerateTestExports.recenteranalyses.clear();
  }
});

/* ------------------------------------------------------------------ */
/* GET analysis                                                        */
/* ------------------------------------------------------------------ */

describe("GET /analysis", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await analysisGET(
      req("GET", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(401);
  });

  it("404 when feed missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await analysisGET(
      req("GET", "http://x/y"),
      PARAMS_MSG("missing", "m-1"),
    );
    expect(r.status).toBe(404);
  });

  it("404 when message missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(null);
    const r = await analysisGET(
      req("GET", "http://x/y"),
      PARAMS_MSG("weekly", "m-x"),
    );
    expect(r.status).toBe(404);
  });

  it("200 with null when analyzer hasn't run", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockGetLatestAnalysis.mockResolvedValueOnce(null);
    const r = await analysisGET(
      req("GET", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { analysis: unknown };
    expect(body.analysis).toBeNull();
  });

  it("200 with the analysis payload + analyzer_available", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockGetLatestAnalysis.mockResolvedValueOnce({
      id: "an-1",
      message_id: "m-1",
      analyzer_version: "v1",
      analyzed_at: "",
      decisions: [],
      action_items: [],
      topics: ["pricing"],
      attendees: [],
      blockers: [],
      next_steps: [],
      raw_llm_response: null,
      model: null,
      tokens_used: null,
      status: "success",
      error_detail: null,
      created_at: "",
    });
    mockIsAnalyzerAvailable.mockReturnValueOnce(true);
    const r = await analysisGET(
      req("GET", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      analysis: { topics: string[] };
      analyzer_available: boolean;
    };
    expect(body.analysis.topics).toEqual(["pricing"]);
    expect(body.analyzer_available).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* POST regenerate                                                     */
/* ------------------------------------------------------------------ */

describe("POST /analysis/regenerate", () => {
  it("403 without manage capability", async () => {
    deny(403, "forbidden");
    const r = await regeneratePOST(
      req("POST", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(403);
  });

  it("404 when message missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(null);
    const r = await regeneratePOST(
      req("POST", "http://x/y"),
      PARAMS_MSG("weekly", "x"),
    );
    expect(r.status).toBe(404);
  });

  it("200 returns the new analysis and fires both events", async () => {
    allow("ops", "u-1");
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockGetLatestAnalysis.mockResolvedValueOnce(null);
    mockRunAnalyzer.mockResolvedValueOnce({
      ok: true,
      record: {
        id: "an-2",
        message_id: "m-1",
        analyzer_version: "v2",
        analyzed_at: "",
        decisions: [{ summary: "Ship" }],
        action_items: [],
        topics: ["x"],
        attendees: [],
        blockers: [],
        next_steps: [],
        raw_llm_response: null,
        model: null,
        tokens_used: 10,
        status: "success",
        error_detail: null,
        created_at: "",
      },
    });
    const r = await regeneratePOST(
      req("POST", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.message_reanalyze_requested",
      "u-1",
      "ops",
      expect.objectContaining({ message_id: "m-1" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.message_analyzed",
      "u-1",
      "ops",
      expect.objectContaining({ triggered_by: "manual" }),
    );
  });

  it("429 when called twice quickly for same user+message", async () => {
    allow("ops", "u-1");
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockGetLatestAnalysis.mockResolvedValueOnce(null);
    mockRunAnalyzer.mockResolvedValueOnce({
      ok: true,
      record: {
        id: "an-3",
        message_id: "m-1",
        analyzer_version: "v",
        analyzed_at: "",
        decisions: [],
        action_items: [],
        topics: [],
        attendees: [],
        blockers: [],
        next_steps: [],
        raw_llm_response: null,
        model: null,
        tokens_used: null,
        status: "success",
        error_detail: null,
        created_at: "",
      },
    });
    const r1 = await regeneratePOST(
      req("POST", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r1.status).toBe(200);

    // Second call: still allowed for same user, immediate re-trigger.
    allow("ops", "u-1");
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(MSG);
    const r2 = await regeneratePOST(
      req("POST", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r2.status).toBe(429);
  });

  it("500 when runAnalyzer returns no record", async () => {
    allow("ops", "u-2");
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockGetMessage.mockResolvedValueOnce(MSG);
    mockGetLatestAnalysis.mockResolvedValueOnce(null);
    mockRunAnalyzer.mockResolvedValueOnce({
      ok: false,
      record: null,
      error: "boom",
    });
    const r = await regeneratePOST(
      req("POST", "http://x/y"),
      PARAMS_MSG("weekly", "m-1"),
    );
    expect(r.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/* GET themes                                                          */
/* ------------------------------------------------------------------ */

describe("GET /themes", () => {
  it("404 when feed missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await themesGET(req("GET", "http://x/y"), PARAMS_FEED("missing"));
    expect(r.status).toBe(404);
  });

  it("200 returns recurring/stale/action_items", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockRecurring.mockResolvedValueOnce([
      { topic: "pricing", mention_count: 2, first_seen: "", last_seen: "", message_ids: [] },
    ]);
    mockStale.mockResolvedValueOnce([]);
    mockOpenActions.mockResolvedValueOnce([
      {
        message_id: "m-1",
        message_subject: "x",
        message_received_at: "",
        description: "do thing",
        owner: null,
        due: null,
        source_quote: null,
      },
    ]);

    const r = await themesGET(req("GET", "http://x/y"), PARAMS_FEED("weekly"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      recurring: unknown[];
      stale: unknown[];
      action_items: unknown[];
    };
    expect(body.recurring).toHaveLength(1);
    expect(body.action_items).toHaveLength(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.themes_viewed",
      "u-1",
      "ops",
      expect.objectContaining({ recurring: 1, open_action_items: 1 }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* GET search                                                          */
/* ------------------------------------------------------------------ */

describe("GET /search", () => {
  it("400 when q missing", async () => {
    allow();
    const r = await searchGET(
      req("GET", "http://x/y/search?q="),
      PARAMS_FEED("weekly"),
    );
    expect(r.status).toBe(400);
  });

  it("400 when q is too long", async () => {
    allow();
    const r = await searchGET(
      req(
        "GET",
        "http://x/y/search?q=" + encodeURIComponent("a".repeat(201)),
      ),
      PARAMS_FEED("weekly"),
    );
    expect(r.status).toBe(400);
  });

  it("404 when feed missing", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(null);
    const r = await searchGET(
      req("GET", "http://x/y/search?q=foo"),
      PARAMS_FEED("missing"),
    );
    expect(r.status).toBe(404);
  });

  it("200 returns hits and emits analytics", async () => {
    allow();
    mockGetFeedBySlug.mockResolvedValueOnce(FEED);
    mockSemantic.mockResolvedValueOnce([
      {
        message_id: "m-1",
        subject: "Weekly",
        received_at: "",
        topics: ["pricing"],
        score: 0,
        highlight: "…pricing v2…",
      },
    ]);
    const r = await searchGET(
      req("GET", "http://x/y/search?q=pricing"),
      PARAMS_FEED("weekly"),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hits: unknown[] };
    expect(body.hits).toHaveLength(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.themes_searched",
      "u-1",
      "ops",
      expect.objectContaining({ hit_count: 1 }),
    );
  });
});
