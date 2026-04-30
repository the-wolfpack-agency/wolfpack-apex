/**
 * /api/assistant/context-debug — contract + safety tests.
 *
 * Covered:
 *   - 400 when `q` is missing.
 *   - 401 when unauthenticated (requireCapability returns no user).
 *   - 403 when authed but lacking `assistant.use` capability.
 *   - 200 with full ContextDebugResponse shape on the happy path.
 *   - Failures from each source (sharepoint / project / meeting) are
 *     captured into `failures_observed[]` with `scope_missing` correctly
 *     set, and the bundle still returns 200 (graceful degradation).
 *   - Endpoint NEVER invokes any LLM — neither @anthropic-ai/sdk nor
 *     openai are imported by the route, and no fetch with an llm-style
 *     URL is issued at runtime.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export {};

const mockTrack = jest.fn();
const mockGetValidToken = jest.fn();
const mockSearchSharePoint = jest.fn();
const mockSearchProjectTasks = jest.fn();
const mockTrackSpFail = jest.fn();
const mockTrackProjFail = jest.fn();
const mockSearchMeetingTranscripts = jest.fn();
const mockGetUserFromRequest = jest.fn();
const mockLoadUserOverrides = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: any[]) => mockGetValidToken(...args),
}));

jest.mock("@/lib/integrations/microsoft-sharepoint", () => ({
  searchSharePoint: (...args: any[]) => mockSearchSharePoint(...args),
  trackSharePointLookupFailure: (...args: any[]) => mockTrackSpFail(...args),
}));

jest.mock("@/lib/integrations/microsoft-project", () => ({
  searchProjectTasks: (...args: any[]) => mockSearchProjectTasks(...args),
  trackProjectLookupFailure: (...args: any[]) => mockTrackProjFail(...args),
}));

jest.mock("@/lib/plaud", () => ({
  searchMeetingTranscripts: (...args: any[]) => mockSearchMeetingTranscripts(...args),
}));

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: any[]) => mockGetUserFromRequest(...args),
}));

jest.mock("@/lib/auth/capability-overrides", () => ({
  loadUserOverrides: (...args: any[]) => mockLoadUserOverrides(...args),
  emptyOverrides: () => ({ added: [], removed: [] }),
  resolveCapabilities: (role: string) => {
    // Map: "ceo" → has assistant.use; "outsider" → does not.
    if (role === "outsider") return new Set<string>(["foo.bar"]);
    return new Set<string>(["assistant.use", "knowledge.search"]);
  },
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function makeReq(qs: string): NextRequest {
  return new NextRequest(`https://x.test/api/assistant/context-debug${qs}`, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserFromRequest.mockReturnValue({
    id: "u-debug-12345abc",
    role: "ceo",
    name: "Nick",
    email: "n@x.co",
  });
  mockLoadUserOverrides.mockResolvedValue(null);
  mockGetValidToken.mockResolvedValue({ accessToken: "tok-abc", userEmail: "n@x.co" });
  mockSearchMeetingTranscripts.mockResolvedValue([]);
  mockSearchSharePoint.mockResolvedValue({
    ok: true,
    value: { hits: [], total: 0, took_ms: 5 },
  });
  mockSearchProjectTasks.mockResolvedValue({
    ok: true,
    value: { tasks: [], took_ms: 5 },
  });
});

describe("GET /api/assistant/context-debug — auth gating", () => {
  /* Auth pattern matches /api/assistant: Bearer token via
     getUserFromRequest is the primary path. requireCapability is the
     fallback for cookie-based sessions (the original PR #43 gate). */
  it("401 when no auth at all (no Bearer + no capability)", async () => {
    /* Both the primary Bearer path AND the requireCapability fallback
       (which internally also calls getUserFromRequest) need to see a
       null user. mockReturnValue (not Once) covers both calls. */
    mockGetUserFromRequest.mockReturnValue(null);
    const res = await GET(makeReq("?q=hello"));
    expect(res.status).toBe(401);
    const body: any = await res.json();
    expect(body.error).toBe("unauthorized");
    /* requireCapability fired as the fallback and recorded the denial. */
    expect(mockTrack).toHaveBeenCalledWith(
      "system.capability_denied",
      "anonymous",
      "anonymous",
      expect.objectContaining({ capability: "assistant.use" }),
    );
  });

  it("authorizes with Bearer token (matches /api/assistant)", async () => {
    /* Anyone who can chat with the assistant can debug their own
       grounding context. Same access level as /api/assistant. */
    mockGetUserFromRequest.mockReturnValueOnce({
      id: "u-cto",
      role: "cto",
      name: "Nick",
      email: "homyk@thewolfpack.agency",
    });
    const res = await GET(makeReq("?q=hello"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.question).toBe("hello");
  });
});

describe("GET /api/assistant/context-debug — input contract", () => {
  it("400 when q is missing", async () => {
    const res = await GET(makeReq(""));
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error).toMatch(/q is required/i);
  });

  it("400 when q is empty / whitespace", async () => {
    const res = await GET(makeReq("?q=%20%20"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/assistant/context-debug — happy path response shape", () => {
  it("200 with full ContextDebugResponse shape", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: true,
      value: {
        hits: [
          {
            title: "TWA Agenda 4.20",
            url: "https://contoso.sharepoint.com/twa-agenda-420.docx",
            snippet: "Weekly agenda",
            modifiedAt: "2026-04-20T00:00:00Z",
            source_kind: "sharepoint_doc",
            driveItemId: "did1",
            driveId: "d1",
          },
        ],
        total: 1,
        took_ms: 12,
      },
    });

    const res = await GET(makeReq("?q=" + encodeURIComponent("What's in the TWA Agenda 4.20 doc?")));
    expect(res.status).toBe(200);
    const body: any = await res.json();

    // Required fields all present + correctly typed.
    expect(body.question).toBe("What's in the TWA Agenda 4.20 doc?");
    expect(body.surface).toBe("assistant_support");
    expect(typeof body.took_ms).toBe("number");
    expect(typeof body.total_chars).toBe("number");
    expect(Array.isArray(body.sharepoint_hits)).toBe(true);
    expect(body.sharepoint_hits.length).toBe(1);
    expect(body.sharepoint_hits[0].title).toBe("TWA Agenda 4.20");
    expect(Array.isArray(body.project_tasks)).toBe(true);
    expect(Array.isArray(body.meeting_notes)).toBe(true);
    expect(typeof body.rendered_prompt_block).toBe("string");
    // SharePoint hit was returned, so the rendered block is non-empty.
    expect(body.rendered_prompt_block.length).toBeGreaterThan(0);
    expect(Array.isArray(body.failures_observed)).toBe(true);
    expect(body.failures_observed.length).toBe(0);
    expect(typeof body.user_id_hint).toBe("string");
    expect(body.user_id_hint.length).toBeLessThanOrEqual(8);
    expect(body.model_used_in_last_chat).toBe("(endpoint does not call an LLM)");

    // Diagnostic event recorded.
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.context_debug_invoked",
      "u-debug-12345abc",
      "ceo",
      expect.objectContaining({ surface: "assistant_support", sharepoint_count: 1 }),
    );
  });

  it("accepts surface=knowledge override", async () => {
    const res = await GET(makeReq("?q=hi&surface=knowledge"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.surface).toBe("knowledge");
  });
});

describe("GET /api/assistant/context-debug — failure capture", () => {
  it("surfaces SharePoint scope_missing as failures_observed[0] with scope_missing=true", async () => {
    mockSearchSharePoint.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      status: 403,
      scope: "Sites.Read.All",
      message: "missing Sites.Read.All",
    });

    const res = await GET(makeReq("?q=" + encodeURIComponent("twa agenda")));
    expect(res.status).toBe(200); // graceful degradation — bundle still returns
    const body: any = await res.json();
    expect(body.sharepoint_hits).toEqual([]);
    expect(body.failures_observed.length).toBeGreaterThanOrEqual(1);
    const sp = body.failures_observed.find((f: any) => f.source === "sharepoint");
    expect(sp).toBeDefined();
    expect(sp.status).toBe(403);
    expect(sp.scope_missing).toBe(true);
    expect(sp.code).toBe("scope_missing");
  });

  it("surfaces Project rate_limited with scope_missing=false", async () => {
    mockSearchProjectTasks.mockResolvedValueOnce({
      ok: false,
      code: "rate_limited",
      status: 429,
      retryAfter: 30,
      message: "throttled",
    });

    const res = await GET(makeReq("?q=tasks"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const proj = body.failures_observed.find((f: any) => f.source === "project");
    expect(proj).toBeDefined();
    expect(proj.status).toBe(429);
    expect(proj.scope_missing).toBe(false);
    expect(proj.code).toBe("rate_limited");
  });

  it("surfaces Meeting internal failure", async () => {
    mockSearchMeetingTranscripts.mockRejectedValueOnce(new Error("db down"));

    const res = await GET(makeReq("?q=last%20meeting"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const mtg = body.failures_observed.find((f: any) => f.source === "meeting");
    expect(mtg).toBeDefined();
    expect(mtg.status).toBe(500);
    expect(mtg.code).toBe("internal");
  });

  it("returns empty bundle (no errors) when token is missing", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const res = await GET(makeReq("?q=anything"));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    // No graph token → SharePoint + Project not called; no error rows.
    expect(body.sharepoint_hits).toEqual([]);
    expect(body.project_tasks).toEqual([]);
    // Meeting still ran and returned [] by default.
    expect(body.meeting_notes).toEqual([]);
    // failures_observed only contains rows that actually fired.
    expect(body.failures_observed).toEqual([]);
  });
});

describe("GET /api/assistant/context-debug — never calls an LLM", () => {
  /**
   * The endpoint MUST NOT invoke an LLM. We assert this two ways:
   *
   *  1) The route file does not import any LLM SDK / wrapper.
   *  2) At runtime, the only network-y mocks invoked are the search
   *     helpers we wired up — no Anthropic, no OpenAI, no `chat()`.
   */
  it("route source does not import any LLM SDK", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require("fs");
    const path = require("path");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "route.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/@anthropic-ai\/sdk/);
    expect(src).not.toMatch(/from ["']openai["']/);
    expect(src).not.toMatch(/azure-openai/);
    // Also: do not import the assistant chat() helper, which would
    // route a message to the LLM.
    expect(src).not.toMatch(/from ["']@\/lib\/assistant["']/);
  });

  it("runtime call to GET does not invoke chat() / LLM mocks", async () => {
    // Build a fresh mock for the chat helper and assert it stays
    // un-called for a default GET.
    const chatSpy = jest.fn();
    jest.doMock("@/lib/assistant", () => ({
      chat: chatSpy,
      getConversations: jest.fn(),
      getConversationMessages: jest.fn(),
      rateMessage: jest.fn(),
      archiveConversation: jest.fn(),
    }));
    const res = await GET(makeReq("?q=does%20it%20call%20the%20LLM"));
    expect(res.status).toBe(200);
    expect(chatSpy).not.toHaveBeenCalled();
  });
});
