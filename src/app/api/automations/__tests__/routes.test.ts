/**
 * Contract tests for the /api/automations route family.
 *
 * Each route is exercised for:
 *   - 401 (no auth)
 *   - 403 (capability missing)
 *   - 404 (unknown automation id)
 *   - 200 happy path with a payload assertion
 *
 * `requireCapability` is mocked per-call. DB queries are mocked.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockGetCounts = jest.fn();
const mockGetDigest = jest.fn();
const mockListExceptions = jest.fn();
const mockResolveException = jest.fn();
const mockInsertOverride = jest.fn();
const mockListOverrides = jest.fn();
jest.mock("@/lib/automations/queries", () => ({
  getAutomationCounts: (...a: unknown[]) => mockGetCounts(...a),
  getChangeDigest: (...a: unknown[]) => mockGetDigest(...a),
  listExceptions: (...a: unknown[]) => mockListExceptions(...a),
  resolveException: (...a: unknown[]) => mockResolveException(...a),
  insertOverride: (...a: unknown[]) => mockInsertOverride(...a),
  listOverrides: (...a: unknown[]) => mockListOverrides(...a),
  getArtifactBytes: jest.fn(),
}));

const mockPollInbox = jest.fn();
jest.mock("@/lib/automations/inbox-poller", () => ({
  pollInbox: (...a: unknown[]) => mockPollInbox(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET as listGET } from "@/app/api/automations/route";
import { GET as detailGET } from "@/app/api/automations/[automationId]/route";
import { GET as changesGET } from "@/app/api/automations/[automationId]/changes/route";
import { POST as pollPOST } from "@/app/api/automations/[automationId]/poll/route";
import {
  GET as overrideGET,
  POST as overridePOST,
} from "@/app/api/automations/[automationId]/override/route";
import { GET as exceptionsGET } from "@/app/api/automations/[automationId]/exceptions/route";
import { POST as resolvePOST } from "@/app/api/automations/[automationId]/exceptions/[exceptionId]/resolve/route";

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

beforeEach(() => {
  jest.clearAllMocks();
});

const PARAMS_PORSCHE = { params: Promise.resolve({ automationId: "porsche-classes" }) };
const PARAMS_UNKNOWN = { params: Promise.resolve({ automationId: "does-not-exist" }) };

/* ------------------------------------------------------------------ */
/* GET /api/automations                                                 */
/* ------------------------------------------------------------------ */

describe("GET /api/automations", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await listGET(req("GET", "http://x/api/automations"));
    expect(r.status).toBe(401);
  });

  it("200 returns automations metadata array", async () => {
    allow();
    const r = await listGET(req("GET", "http://x/api/automations"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { automations: { id: string }[] };
    expect(Array.isArray(body.automations)).toBe(true);
    expect(body.automations.find((a) => a.id === "porsche-classes")).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/automations/[id]                                            */
/* ------------------------------------------------------------------ */

describe("GET /api/automations/[id]", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await detailGET(req("GET", "http://x/api/automations/x"), PARAMS_PORSCHE);
    expect(r.status).toBe(401);
  });

  it("403 when capability missing", async () => {
    deny(403, "forbidden");
    const r = await detailGET(req("GET", "http://x/api/automations/x"), PARAMS_PORSCHE);
    expect(r.status).toBe(403);
  });

  it("404 when automation id is unknown", async () => {
    allow();
    const r = await detailGET(req("GET", "http://x/api/automations/x"), PARAMS_UNKNOWN);
    expect(r.status).toBe(404);
  });

  it("200 returns automation + counts", async () => {
    allow();
    mockGetCounts.mockResolvedValueOnce({
      artifacts_today: 1,
      open_exceptions: 2,
      classes_in_window: 14,
    });
    const r = await detailGET(req("GET", "http://x/api/automations/x"), PARAMS_PORSCHE);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { automation: { id: string }; counts: { classes_in_window: number } };
    expect(body.automation.id).toBe("porsche-classes");
    expect(body.counts.classes_in_window).toBe(14);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/automations/[id]/changes                                    */
/* ------------------------------------------------------------------ */

describe("GET /changes", () => {
  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await changesGET(req("GET", "http://x/changes"), PARAMS_PORSCHE);
    expect(r.status).toBe(401);
  });

  it("200 returns digest rows + window", async () => {
    allow();
    mockGetDigest.mockResolvedValueOnce([
      {
        class_key: "BA101|2026-04-13|Hilton Hotel",
        course_type: "BA101",
        class_date: "2026-04-13",
        location: "Hilton Hotel",
        last_captured_at: "2026-04-20T18:00:00Z",
        added: ["alice"],
        dropped: [],
        net_change: 1,
        is_baseline: false,
        delta_created_at: "2026-04-20T18:00:00Z",
      },
    ]);
    const r = await changesGET(req("GET", "http://x/changes"), PARAMS_PORSCHE);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      classes: { class_key: string }[];
      window: { min: number; max: number };
    };
    expect(body.classes).toHaveLength(1);
    expect(body.classes[0].class_key).toBe("BA101|2026-04-13|Hilton Hotel");
    // Mirrors the real porsche-classes active_window_days (widened from
    // -7/+60 to -30/+365 in commit 82d10245). The route echoes the
    // automation definition's window verbatim.
    expect(body.window.min).toBe(-30);
    expect(body.window.max).toBe(365);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/automations/[id]/poll                                      */
/* ------------------------------------------------------------------ */

describe("POST /poll", () => {
  it("401 when no capability", async () => {
    deny(401, "unauthorized");
    const r = await pollPOST(req("POST", "http://x/poll"), PARAMS_PORSCHE);
    expect(r.status).toBe(401);
  });

  it("404 when automation id is unknown", async () => {
    allow();
    const r = await pollPOST(req("POST", "http://x/poll"), PARAMS_UNKNOWN);
    expect(r.status).toBe(404);
  });

  it("200 returns poll result", async () => {
    allow();
    mockPollInbox.mockResolvedValueOnce({
      automation_id: "porsche-classes",
      messages_seen: 3,
      messages_matched: 2,
      artifacts_ingested: 1,
      artifacts_duplicate: 1,
      artifacts_quarantined: 0,
      errors: 0,
      duration_ms: 12,
    });
    const r = await pollPOST(req("POST", "http://x/poll"), PARAMS_PORSCHE);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; result: { artifacts_ingested: number } };
    expect(body.ok).toBe(true);
    expect(body.result.artifacts_ingested).toBe(1);
  });

  it("500 when poller throws", async () => {
    allow();
    mockPollInbox.mockRejectedValueOnce(new Error("graph down"));
    const r = await pollPOST(req("POST", "http://x/poll"), PARAMS_PORSCHE);
    expect(r.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/automations/[id]/override                                  */
/* ------------------------------------------------------------------ */

describe("POST /override", () => {
  it("401 when no capability", async () => {
    deny(401, "unauthorized");
    const r = await overridePOST(
      req("POST", "http://x/override", {
        kind: "participant_alias",
        from: "Bob",
        to: "Robert",
      }),
      PARAMS_PORSCHE,
    );
    expect(r.status).toBe(401);
  });

  it("400 when kind is invalid", async () => {
    allow();
    const r = await overridePOST(
      req("POST", "http://x/override", { kind: "bogus", from: "x", to: "y" }),
      PARAMS_PORSCHE,
    );
    expect(r.status).toBe(400);
  });

  it("400 when from/to missing", async () => {
    allow();
    const r = await overridePOST(
      req("POST", "http://x/override", { kind: "participant_alias", from: "" }),
      PARAMS_PORSCHE,
    );
    expect(r.status).toBe(400);
  });

  it("201 records override + emits analytics", async () => {
    allow("ops", "u-1", "alicia@t");
    mockInsertOverride.mockResolvedValueOnce({
      id: "ovr_1",
      automation_id: "porsche-classes",
      kind: "participant_alias",
      from_value: "Bob",
      to_value: "Robert",
      reason: "alias",
      created_by: "alicia@t",
      created_at: "now",
    });
    const r = await overridePOST(
      req("POST", "http://x/override", {
        kind: "participant_alias",
        from: "Bob",
        to: "Robert",
        reason: "alias",
      }),
      PARAMS_PORSCHE,
    );
    expect(r.status).toBe(201);
    const body = (await r.json()) as { override: { id: string } };
    expect(body.override.id).toBe("ovr_1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.override_applied",
      "u-1",
      "ops",
      expect.objectContaining({ kind: "participant_alias" }),
    );
  });
});

describe("GET /override", () => {
  it("returns 200 and a list", async () => {
    allow();
    mockListOverrides.mockResolvedValueOnce([
      {
        id: "1",
        automation_id: "porsche-classes",
        kind: "participant_alias",
        from_value: "x",
        to_value: "y",
        reason: null,
        created_by: "x",
        created_at: "now",
      },
    ]);
    const r = await overrideGET(req("GET", "http://x/override"), PARAMS_PORSCHE);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { overrides: unknown[] };
    expect(body.overrides).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/automations/[id]/exceptions                                 */
/* ------------------------------------------------------------------ */

describe("GET /exceptions", () => {
  it("200 returns the open list by default", async () => {
    allow();
    mockListExceptions.mockResolvedValueOnce([]);
    const r = await exceptionsGET(req("GET", "http://x/exceptions"), PARAMS_PORSCHE);
    expect(r.status).toBe(200);
    expect(mockListExceptions).toHaveBeenCalledWith(
      expect.objectContaining({ status: "open" }),
    );
  });

  it("200 honors status query param", async () => {
    allow();
    mockListExceptions.mockResolvedValueOnce([]);
    const r = await exceptionsGET(
      req("GET", "http://x/exceptions?status=resolved"),
      PARAMS_PORSCHE,
    );
    expect(r.status).toBe(200);
    expect(mockListExceptions).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved" }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/automations/[id]/exceptions/[id]/resolve                   */
/* ------------------------------------------------------------------ */

describe("POST /exceptions/:id/resolve", () => {
  const PARAMS = {
    params: Promise.resolve({
      automationId: "porsche-classes",
      exceptionId: "exc_1",
    }),
  };

  it("401 without auth", async () => {
    deny(401, "unauthorized");
    const r = await resolvePOST(req("POST", "http://x/resolve", { outcome: "resolved" }), PARAMS);
    expect(r.status).toBe(401);
  });

  it("400 on bad outcome", async () => {
    allow();
    const r = await resolvePOST(req("POST", "http://x/resolve", { outcome: "explode" }), PARAMS);
    expect(r.status).toBe(400);
  });

  it("404 when exception not found / already resolved", async () => {
    allow();
    mockResolveException.mockResolvedValueOnce(null);
    const r = await resolvePOST(req("POST", "http://x/resolve", { outcome: "resolved" }), PARAMS);
    expect(r.status).toBe(404);
  });

  it("200 returns updated exception + emits analytics", async () => {
    allow("ops", "u-1", "alicia@t");
    mockResolveException.mockResolvedValueOnce({
      id: "exc_1",
      automation_id: "porsche-classes",
      artifact_id: "art_1",
      kind: "parse_failure",
      detail: "boom",
      status: "resolved",
      resolved_by: "alicia@t",
      resolved_at: "now",
      created_at: "earlier",
    });
    const r = await resolvePOST(req("POST", "http://x/resolve", { outcome: "resolved" }), PARAMS);
    expect(r.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.exception_resolved",
      "u-1",
      "ops",
      expect.objectContaining({ outcome: "resolved" }),
    );
  });
});
