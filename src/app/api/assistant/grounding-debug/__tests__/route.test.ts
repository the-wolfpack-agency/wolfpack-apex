/**
 * /api/assistant/grounding-debug — contract + unit tests.
 *
 * Covers:
 *   - 401 when no Bearer / unauthenticated.
 *   - 200 with full GroundingDebugResponse shape on the happy path.
 *   - Token decoded → scopes computed correctly (present + missing).
 *   - Probe failures (403 with AccessDenied) flagged scope_missing=true.
 *   - Default question used when ?q= is omitted.
 *   - Pure helpers — decodeMsToken, computeScopeReport, diagnose — are
 *     table-tested.
 *   - Endpoint never invokes an LLM (no openai / anthropic imports).
 */
 

export {};

const mockGetUser = jest.fn();
const mockGetValidToken = jest.fn();
const mockGetRelevantContext = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));
jest.mock("@/lib/assistant/context-resolver", () => ({
  getRelevantContext: (...a: any[]) => mockGetRelevantContext(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import {
  GET,
  decodeMsToken,
  computeScopeReport,
  diagnose,
  EXPECTED_GROUNDING_SCOPES,
  DEFAULT_QUESTION,
  type ProbeResult,
  type GroundingDebugResponse,
} from "../route";

function makeReq(qs = ""): NextRequest {
  return new NextRequest(`https://x.test/api/assistant/grounding-debug${qs}`, {
    method: "GET",
    headers: { authorization: "Bearer test" },
  });
}

function fakeJwt(scp: string, expSec?: number): string {
  const exp = expSec ?? Math.floor(Date.now() / 1000) + 600;
  const payload = Buffer.from(
    JSON.stringify({
      scp,
      aud: "https://graph.microsoft.com",
      tid: "tnt-1",
      upn: "x@y.z",
      exp,
    }),
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({
    id: "u-572d8029-9c94-4dab-8842-b4cb022de824",
    role: "ceo",
    name: "Nick Homyk",
    email: "homyk@thewolfpack.agency",
  });
  mockGetRelevantContext.mockResolvedValue({
    question: DEFAULT_QUESTION,
    surface: "assistant_support",
    sharepoint_hits: [],
    project_tasks: [],
    meeting_notes: [],
    rendered_prompt_block: "",
    total_chars: 0,
    took_ms: 12,
    errors: undefined,
  });
  // Default fetch mock: every Graph probe returns 200 empty.
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as any;
});

afterEach(() => {
  delete (global as any).fetch;
});

/* ------------------------------------------------------------------ */
/* Pure unit tests                                                    */
/* ------------------------------------------------------------------ */

describe("decodeMsToken", () => {
  it("decodes a well-formed JWS payload", () => {
    const tok = fakeJwt("User.Read Mail.Read");
    const decoded = decodeMsToken(tok);
    expect(decoded?.scp).toBe("User.Read Mail.Read");
    expect(decoded?.upn).toBe("x@y.z");
  });

  it("returns null on a non-JWT string", () => {
    expect(decodeMsToken("not.a.jwt.maybe")).toBeNull();
    expect(decodeMsToken("opaque-token")).toBeNull();
    expect(decodeMsToken("")).toBeNull();
  });

  it("returns null on bad base64", () => {
    expect(decodeMsToken("a.@@@.c")).toBeNull();
  });
});

describe("computeScopeReport", () => {
  it("flags every expected scope as missing when token has none", () => {
    const r = computeScopeReport([]);
    expect(r.scopes_in_token).toEqual([]);
    expect(r.expected_present).toEqual([]);
    expect(r.expected_missing).toEqual([...EXPECTED_GROUNDING_SCOPES]);
    expect(r.has_all_expected).toBe(false);
  });

  it("partitions present + missing correctly", () => {
    const r = computeScopeReport([
      "User.Read",
      "Mail.Read",
      "Calendars.Read",
      "extra.Scope",
    ]);
    expect(r.expected_present).toContain("User.Read");
    expect(r.expected_present).toContain("Mail.Read");
    expect(r.expected_present).toContain("Calendars.Read");
    expect(r.expected_missing).toContain("Sites.Read.All");
    expect(r.has_all_expected).toBe(false);
    expect(r.scopes_in_token).toContain("extra.Scope");
  });

  it("reports has_all_expected when all required scopes are present", () => {
    const r = computeScopeReport([...EXPECTED_GROUNDING_SCOPES]);
    expect(r.expected_missing).toEqual([]);
    expect(r.has_all_expected).toBe(true);
  });
});

describe("diagnose", () => {
  const baseProbe = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
    name: "sharepoint_search_query",
    label: "SharePoint /search/query",
    endpoint: "/search/query",
    method: "POST",
    status: 200,
    ok: true,
    scope_missing: false,
    took_ms: 10,
    ...overrides,
  });

  it("flags missing token", () => {
    const out = diagnose({
      hasToken: false,
      expiresInSec: null,
      scopeReport: null,
      probes: [],
      bundle: { sharepoint_hits: 0, meeting_notes: 0, total_chars: 0 },
    });
    expect(out).toMatch(/no microsoft 365 token/i);
  });

  it("flags expired token", () => {
    const out = diagnose({
      hasToken: true,
      expiresInSec: -10,
      scopeReport: { scopes_in_token: [], expected_present: [], expected_missing: [], has_all_expected: true },
      probes: [],
      bundle: { sharepoint_hits: 0, meeting_notes: 0, total_chars: 0 },
    });
    expect(out).toMatch(/expired/i);
  });

  it("flags missing scopes ahead of probe failures", () => {
    const out = diagnose({
      hasToken: true,
      expiresInSec: 600,
      scopeReport: {
        scopes_in_token: ["User.Read"],
        expected_present: ["User.Read"],
        expected_missing: ["Sites.Read.All"],
        has_all_expected: false,
      },
      probes: [baseProbe({ status: 403, ok: false, scope_missing: true })],
      bundle: { sharepoint_hits: 0, meeting_notes: 0, total_chars: 0 },
    });
    expect(out).toMatch(/Sites\.Read\.All/);
    expect(out).toMatch(/sign out/i);
  });

  it("flags consent-not-granted when scopes are present but probe still 403s", () => {
    const out = diagnose({
      hasToken: true,
      expiresInSec: 600,
      scopeReport: {
        scopes_in_token: [...EXPECTED_GROUNDING_SCOPES],
        expected_present: [...EXPECTED_GROUNDING_SCOPES],
        expected_missing: [],
        has_all_expected: true,
      },
      probes: [baseProbe({ status: 403, ok: false, scope_missing: true })],
      bundle: { sharepoint_hits: 0, meeting_notes: 0, total_chars: 0 },
    });
    expect(out).toMatch(/admin consent/i);
  });

  it("flags index miss when SharePoint 200 but bundle empty", () => {
    const out = diagnose({
      hasToken: true,
      expiresInSec: 600,
      scopeReport: {
        scopes_in_token: [...EXPECTED_GROUNDING_SCOPES],
        expected_present: [...EXPECTED_GROUNDING_SCOPES],
        expected_missing: [],
        has_all_expected: true,
      },
      probes: [baseProbe({ status: 200, ok: true, count: 0 })],
      bundle: { sharepoint_hits: 0, meeting_notes: 0, total_chars: 0 },
    });
    expect(out).toMatch(/search index/i);
  });

  it("returns all-green when nothing is wrong", () => {
    const out = diagnose({
      hasToken: true,
      expiresInSec: 600,
      scopeReport: {
        scopes_in_token: [...EXPECTED_GROUNDING_SCOPES],
        expected_present: [...EXPECTED_GROUNDING_SCOPES],
        expected_missing: [],
        has_all_expected: true,
      },
      probes: [
        baseProbe({ name: "sharepoint_search_query", count: 3 }),
        baseProbe({ name: "calendar_view", count: 1 }),
        baseProbe({ name: "mail_search", count: 2 }),
      ],
      bundle: { sharepoint_hits: 3, meeting_notes: 0, total_chars: 1500 },
    });
    expect(out).toMatch(/healthy/i);
  });
});

/* ------------------------------------------------------------------ */
/* GET handler — contract                                             */
/* ------------------------------------------------------------------ */

describe("GET /api/assistant/grounding-debug", () => {
  it("401 when unauthenticated", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("200 with no_token shape when user has no MS token", async () => {
    mockGetValidToken.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroundingDebugResponse;
    expect(body.token.has_token).toBe(false);
    expect(body.probes).toEqual([]);
    expect(body.diagnosis).toMatch(/no microsoft 365 token/i);
    expect(body.question).toBe(DEFAULT_QUESTION);
  });

  it("uses default question when ?q is omitted", async () => {
    mockGetValidToken.mockResolvedValue(null);
    const res = await GET(makeReq(""));
    const body = (await res.json()) as GroundingDebugResponse;
    expect(body.question).toBe(DEFAULT_QUESTION);
  });

  it("uses ?q= when provided", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockGetRelevantContext.mockResolvedValue({
      question: "custom q",
      surface: "assistant_support",
      sharepoint_hits: [],
      project_tasks: [],
      meeting_notes: [],
      rendered_prompt_block: "",
      total_chars: 0,
      took_ms: 5,
    });
    const res = await GET(makeReq("?q=custom%20q"));
    const body = (await res.json()) as GroundingDebugResponse;
    expect(body.question).toBe("custom q");
  });

  it("decodes scopes and runs probes when token present", async () => {
    mockGetValidToken.mockResolvedValue({
      accessToken: fakeJwt("User.Read Mail.Read Calendars.Read"),
      userEmail: "homyk@thewolfpack.agency",
    });
    const res = await GET(makeReq());
    const body = (await res.json()) as GroundingDebugResponse;
    expect(body.token.has_token).toBe(true);
    expect(body.token.decodable).toBe(true);
    expect(body.token.scopes?.expected_present).toContain("User.Read");
    expect(body.token.scopes?.expected_missing).toContain("Sites.Read.All");
    // We have 6 probes defined in runProbes — verify the count.
    expect(body.probes.length).toBe(6);
    // Scope-missing flag drives the diagnosis.
    expect(body.diagnosis).toMatch(/missing required scopes/i);
  });

  it("flags 403 AccessDenied probe as scope_missing", async () => {
    mockGetValidToken.mockResolvedValue({
      accessToken: fakeJwt(EXPECTED_GROUNDING_SCOPES.join(" ")),
      userEmail: "x@y.z",
    });
    // Override fetch to return 403 with AccessDenied for SharePoint search.
    let callIdx = 0;
    global.fetch = jest.fn(async () => {
      const idx = callIdx++;
      // probes order: user_profile(0), sharepoint_sites_search(1),
      // sharepoint_search_query(2), calendar_view(3), mail_search(4),
      // todo_lists(5)
      if (idx === 1 || idx === 2) {
        return new Response(
          JSON.stringify({
            error: { code: "AccessDenied", message: "Insufficient privileges" },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    const res = await GET(makeReq());
    const body = (await res.json()) as GroundingDebugResponse;
    const sp = body.probes.find((p) => p.name === "sharepoint_search_query");
    expect(sp?.status).toBe(403);
    expect(sp?.scope_missing).toBe(true);
    expect(sp?.error_code).toBe("AccessDenied");
    expect(body.diagnosis).toMatch(/admin consent/i);
  });

  it("flattens bundle errors into failures_observed", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockGetRelevantContext.mockResolvedValue({
      question: DEFAULT_QUESTION,
      surface: "assistant_support",
      sharepoint_hits: [],
      project_tasks: [],
      meeting_notes: [],
      rendered_prompt_block: "",
      total_chars: 0,
      took_ms: 8,
      errors: {
        sharepoint: { ok: false, code: "scope_missing", status: 403, message: "no Sites.Read.All" },
        meeting: { ok: false, code: "internal", status: 500 },
      },
    });
    const res = await GET(makeReq());
    const body = (await res.json()) as GroundingDebugResponse;
    expect(body.bundle.failures_observed).toHaveLength(2);
    const sp = body.bundle.failures_observed.find((f) => f.source === "sharepoint");
    expect(sp?.scope_missing).toBe(true);
  });

  it("user_id_hint is 8-char prefix and never the full id", async () => {
    mockGetValidToken.mockResolvedValue(null);
    const res = await GET(makeReq());
    const body = (await res.json()) as GroundingDebugResponse;
    expect(body.user.id_hint).toBe("u-572d80");
    expect(body.user.id_hint).not.toContain("b4cb022de824");
  });

  it("never returns the raw access token in the response", async () => {
    const tok = fakeJwt("User.Read");
    mockGetValidToken.mockResolvedValue({
      accessToken: tok,
      userEmail: "x@y.z",
    });
    const res = await GET(makeReq());
    const text = await res.text();
    expect(text).not.toContain(tok);
    expect(text).not.toContain(tok.split(".")[1]); // payload segment
  });

  it("fires assistant.grounding_debug_invoked analytics", async () => {
    mockGetValidToken.mockResolvedValue(null);
    await GET(makeReq());
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.grounding_debug_invoked",
      expect.any(String),
      "ceo",
      expect.objectContaining({ has_token: false }),
    );
  });
});

describe("LLM safety", () => {
  it("route module does not import any LLM SDK", () => {
     
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "route.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/@anthropic-ai\/sdk/);
    expect(src).not.toMatch(/from ['"]openai['"]/);
     
  });
});
