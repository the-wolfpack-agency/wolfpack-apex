import { NextRequest } from "next/server";

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));
jest.mock("@/lib/support/repo", () => ({
  listAllPatterns: jest.fn(),
  updatePattern: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { requireCapability } = jest.requireMock("@/lib/auth/require-capability");
const repo = jest.requireMock("@/lib/support/repo");
const { trackEvent } = jest.requireMock("@/lib/analytics");

const user = { id: "u-1", email: "op@x.com", role: "dev" };

function unauth() {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }) as unknown as Response,
  };
}

function authed() {
  return { ok: true, user, capabilities: new Set() };
}

function req(method: "GET" | "PATCH", url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

const patternRow = {
  id: "p-1",
  slug: "aadsts50126-bad-credentials",
  name: "AADSTS50126",
  category: "auth",
  match_signatures: [{ type: "regex", pattern: "AADSTS50126" }],
  draft_template: "Hi {{first_name}}…",
  success_count: 4,
  fail_count: 1,
  enabled: true,
  auto_acknowledge_enabled: false,
  auto_acknowledge_template: null,
  created_at: "2026-04-27T00:00:00Z",
  updated_at: "2026-04-27T00:00:00Z",
};

describe("GET /api/support/patterns", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { GET } = await import("../patterns/route");
    const res = await GET(req("GET", "http://t/api/support/patterns"));
    expect(res.status).toBe(401);
    expect(repo.listAllPatterns).not.toHaveBeenCalled();
  });

  it("returns patterns + total + fires support.patterns_viewed", async () => {
    requireCapability.mockResolvedValue(authed());
    const enabledRow = { ...patternRow, auto_acknowledge_enabled: true };
    repo.listAllPatterns.mockResolvedValue([patternRow, enabledRow]);
    const { GET } = await import("../patterns/route");
    const res = await GET(req("GET", "http://t/api/support/patterns"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patterns).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.patterns[0].id).toBe("p-1");
    expect(trackEvent).toHaveBeenCalledWith(
      "support.patterns_viewed",
      "u-1",
      "dev",
      expect.objectContaining({ count: 2, auto_ack_enabled_count: 1 }),
    );
  });

  it("500 when repo throws", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.listAllPatterns.mockRejectedValue(new Error("db down"));
    const { GET } = await import("../patterns/route");
    const res = await GET(req("GET", "http://t/api/support/patterns"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("db down");
  });
});

describe("PATCH /api/support/patterns/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "p-1" }) };

  beforeEach(() => jest.clearAllMocks());

  it("401 when auth fails", async () => {
    requireCapability.mockResolvedValue(unauth());
    const { PATCH } = await import("../patterns/[id]/route");
    const res = await PATCH(
      req("PATCH", "http://t/api/support/patterns/p-1", {
        auto_acknowledge_enabled: true,
      }),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(repo.updatePattern).not.toHaveBeenCalled();
  });

  it("happy path: toggles auto_acknowledge_enabled, returns pattern, tracks event", async () => {
    requireCapability.mockResolvedValue(authed());
    const after = { ...patternRow, auto_acknowledge_enabled: true };
    repo.updatePattern.mockResolvedValue(after);
    const { PATCH } = await import("../patterns/[id]/route");
    const res = await PATCH(
      req("PATCH", "http://t/api/support/patterns/p-1", {
        auto_acknowledge_enabled: true,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pattern.id).toBe("p-1");
    expect(body.pattern.auto_acknowledge_enabled).toBe(true);
    expect(repo.updatePattern).toHaveBeenCalledWith("p-1", {
      auto_acknowledge_enabled: true,
    });
    expect(trackEvent).toHaveBeenCalledWith(
      "support.pattern_updated",
      "u-1",
      "dev",
      expect.objectContaining({
        pattern_id: "p-1",
        fields_changed: "auto_acknowledge_enabled",
        auto_acknowledge_enabled: true,
      }),
    );
  });

  it("rejects fields outside the allowlist with 400 invalid_field", async () => {
    requireCapability.mockResolvedValue(authed());
    const { PATCH } = await import("../patterns/[id]/route");
    const res = await PATCH(
      req("PATCH", "http://t/api/support/patterns/p-1", {
        slug: "evil-slug",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_field");
    expect(body.field).toBe("slug");
    expect(repo.updatePattern).not.toHaveBeenCalled();
  });

  it("happy path: edits the auto_acknowledge_template text and returns the updated row", async () => {
    requireCapability.mockResolvedValue(authed());
    const newTemplate = "Hi there, please try resetting your password.";
    const after = {
      ...patternRow,
      auto_acknowledge_template: newTemplate,
    };
    repo.updatePattern.mockResolvedValue(after);
    const { PATCH } = await import("../patterns/[id]/route");
    const res = await PATCH(
      req("PATCH", "http://t/api/support/patterns/p-1", {
        auto_acknowledge_template: newTemplate,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pattern.auto_acknowledge_template).toBe(newTemplate);
    expect(repo.updatePattern).toHaveBeenCalledWith("p-1", {
      auto_acknowledge_template: newTemplate,
    });
  });

  it("404 when the pattern id does not exist", async () => {
    requireCapability.mockResolvedValue(authed());
    repo.updatePattern.mockResolvedValue(null);
    const { PATCH } = await import("../patterns/[id]/route");
    const res = await PATCH(
      req("PATCH", "http://t/api/support/patterns/p-1", {
        enabled: false,
      }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("rejects bad type with 400 invalid_field_type", async () => {
    requireCapability.mockResolvedValue(authed());
    const { PATCH } = await import("../patterns/[id]/route");
    const res = await PATCH(
      req("PATCH", "http://t/api/support/patterns/p-1", {
        auto_acknowledge_enabled: "yes",
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_field_type");
    expect(body.field).toBe("auto_acknowledge_enabled");
  });
});
