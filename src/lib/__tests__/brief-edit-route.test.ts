/**
 * /api/sites/[id]/brief-edit route tests.
 *
 * Covers:
 *  - POST auth gate, empty body, AI unavailable, blocked patch, happy path.
 *  - PATCH decision route: accept + reject paths, analytics metadata.
 *
 * Follows the existing sites-route.test.ts pattern: jest.mock all deps,
 * assemble a Next.js Request directly, invoke the route handler and
 * inspect the NextResponse.
 */

const mockGetUser = jest.fn();
const mockHasRole = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  hasRole: (...args: unknown[]) => mockHasRole(...args),
}));

const mockGetSite = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...args: unknown[]) => mockGetSite(...args),
}));

const mockGenerate = jest.fn();
const mockRecord = jest.fn();

class FakeValidationError extends Error {
  reason: "patch_blocked" | "brief_invalid" | "bad_ai_output";
  details: Record<string, unknown>;
  constructor(
    msg: string,
    reason: "patch_blocked" | "brief_invalid" | "bad_ai_output",
    details: Record<string, unknown> = {},
  ) {
    super(msg);
    this.name = "BriefEditValidationError";
    this.reason = reason;
    this.details = details;
  }
}
class FakeAIUnavailable extends Error {
  constructor(msg = "ai offline") {
    super(msg);
    this.name = "BriefEditAIUnavailableError";
  }
}
class FakeAINotConfigured extends Error {
  constructor(msg = "ANTHROPIC_API_KEY is not set") {
    super(msg);
    this.name = "BriefEditNotConfiguredError";
  }
}
jest.mock("@/lib/brief-edit", () => ({
  generateBriefEdit: (...args: unknown[]) => mockGenerate(...args),
  recordBriefEditDecision: (...args: unknown[]) => mockRecord(...args),
  BriefEditValidationError: FakeValidationError,
  BriefEditAIUnavailableError: FakeAIUnavailable,
  BriefEditNotConfiguredError: FakeAINotConfigured,
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { POST as briefEditPOST } from "@/app/api/sites/[id]/brief-edit/route";
import { PATCH as briefEditPATCH } from "@/app/api/sites/[id]/brief-edit/[editId]/route";

function req(method: string, body?: unknown, opts: { auth?: string } = {}) {
  return new NextRequest("http://test/api/sites/site_1/brief-edit", {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const STUB_RESULT = {
  editId: "brief_edit_1",
  patch: [
    { op: "replace", path: "/pages/0/sections/0/heading", value: "Season One" },
  ],
  renderedBrief: {
    client: "cftr",
    product: { name: "Cleared for Takeoff Racing" },
    pages: [
      {
        route: "/",
        sections: [{ type: "hero", heading: "Season One" }],
      },
    ],
  },
  explanation: "Update hero headline.",
  metrics: {
    latencyMs: 180,
    tokensIn: 100,
    tokensOut: 40,
    costUsd: 0.0003,
    model: "claude-haiku-4-5-20251001",
  },
};

describe("POST /api/sites/[id]/brief-edit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasRole.mockReturnValue(true);
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await briefEditPOST(
      req("POST", { instruction: "x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(401);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("403 when role is below sales", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockHasRole.mockReturnValueOnce(false);
    const res = await briefEditPOST(
      req("POST", { instruction: "x" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("400 on empty instruction", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await briefEditPOST(
      req("POST", { instruction: "   " }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const bad = new NextRequest("http://test/api/sites/site_1/brief-edit", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: "{ not json",
    });
    const res = await briefEditPOST(bad, { params: Promise.resolve({ id: "site_1" }) });
    expect(res.status).toBe(400);
  });

  it("404 when project missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce(null);
    const res = await briefEditPOST(
      req("POST", { instruction: "x" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("200 returns edit_id, patch, renderedBrief, explanation on happy path", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({
      id: "site_1",
      brief: { client: "cftr", product: { name: "x" }, pages: [] },
    });
    mockGenerate.mockResolvedValueOnce(STUB_RESULT);

    const res = await briefEditPOST(
      req(
        "POST",
        { instruction: "Make hero headline 'Season One'" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.edit_id).toBe("brief_edit_1");
    expect(data.patch).toHaveLength(1);
    expect(data.renderedBrief.pages[0].sections[0].heading).toBe("Season One");
    expect(data.explanation).toContain("headline");

    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "site_1",
        instruction: "Make hero headline 'Season One'",
        userId: "u_1",
        userRole: "sales",
      }),
    );
  });

  it("502 reason=ai_unavailable when AI is offline", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockGenerate.mockRejectedValueOnce(new FakeAIUnavailable());

    const res = await briefEditPOST(
      req("POST", { instruction: "x" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.reason).toBe("ai_unavailable");
  });

  // Regression for 2026-04-18: user opened the prompt editor, saw
  // "try again in a moment" every time, and had no way to learn that
  // ANTHROPIC_API_KEY was missing in the Vercel env. Separate typed
  // error + separate HTTP code + actionable message.
  it("503 reason=ai_not_configured when ANTHROPIC_API_KEY missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockGenerate.mockRejectedValueOnce(new FakeAINotConfigured());

    const res = await briefEditPOST(
      req("POST", { instruction: "x" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.reason).toBe("ai_not_configured");
    // Message MUST name the env var so an admin knows what to set.
    expect(data.error).toMatch(/ANTHROPIC_API_KEY/);
    // Message MUST NOT tell the user to retry — retrying won't help.
    expect(data.error).not.toMatch(/try again/i);
  });

  it("422 reason=patch_blocked with blockedPaths on guardrail rejection", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockGenerate.mockRejectedValueOnce(
      new FakeValidationError("bad", "patch_blocked", {
        blockedPaths: ["/client_slug"],
        editId: "brief_edit_bad",
      }),
    );

    const res = await briefEditPOST(
      req("POST", { instruction: "rename slug" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.reason).toBe("patch_blocked");
    expect(data.blockedPaths).toContain("/client_slug");
  });

  it("422 reason=brief_invalid when the rendered brief fails validation", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockGenerate.mockRejectedValueOnce(
      new FakeValidationError("bad brief", "brief_invalid"),
    );

    const res = await briefEditPOST(
      req("POST", { instruction: "nuke pages" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.reason).toBe("brief_invalid");
  });

  it("500 on unexpected error", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce({ id: "site_1", brief: {} });
    mockGenerate.mockRejectedValueOnce(new Error("kaboom"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await briefEditPOST(
      req("POST", { instruction: "x" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});

describe("PATCH /api/sites/[id]/brief-edit/[editId]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasRole.mockReturnValue(true);
  });

  function patchReq(body: unknown, opts: { auth?: string } = {}) {
    return new NextRequest(
      "http://test/api/sites/site_1/brief-edit/brief_edit_1",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(opts.auth ? { authorization: opts.auth } : {}),
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await briefEditPATCH(patchReq({ accepted: true }), {
      params: Promise.resolve({ id: "site_1", editId: "brief_edit_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 when accepted is missing or not boolean", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await briefEditPATCH(patchReq({}, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1", editId: "brief_edit_1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 with accepted=true calls recordBriefEditDecision", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRecord.mockResolvedValueOnce({ projectId: "site_1" });
    const res = await briefEditPATCH(
      patchReq({ accepted: true }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1", editId: "brief_edit_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith(
      "brief_edit_1",
      true,
      "u_1",
      "sales",
      undefined,
    );
  });

  it("200 with accepted=false + rejectionReason passes metadata through", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRecord.mockResolvedValueOnce({ projectId: "site_1" });
    const res = await briefEditPATCH(
      patchReq(
        { accepted: false, rejectionReason: "wrong tone" },
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1", editId: "brief_edit_1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(
      "brief_edit_1",
      false,
      "u_1",
      "sales",
      "wrong tone",
    );
  });

  it("500 when recordBriefEditDecision throws", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRecord.mockRejectedValueOnce(new Error("db down"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await briefEditPATCH(
      patchReq({ accepted: true }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1", editId: "brief_edit_1" }) },
    );
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});
