import { NextRequest } from "next/server";

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

const { getUserFromRequest } = jest.requireMock("@/lib/auth");
const { safeQuery } = jest.requireMock("@/lib/db");
const { trackEvent } = jest.requireMock("@/lib/analytics");

const user = { id: "u-1", email: "x@y", name: "X", role: "dev" };

function req(method: "GET" | "POST", body?: unknown, auth = "Bearer t"): NextRequest {
  return new NextRequest("http://t/api/me/welcome-tooltip", {
    method,
    headers: {
      authorization: auth,
      "content-type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

describe("GET /api/me/welcome-tooltip", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when unauthenticated", async () => {
    getUserFromRequest.mockReturnValue(null);
    const { GET } = await import("../route");
    const res = await GET(req("GET", undefined, ""));
    expect(res.status).toBe(401);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("should_show=true when user has no dismissal or knowledge-click event + fires shown event", async () => {
    getUserFromRequest.mockReturnValue(user);
    safeQuery.mockResolvedValue({ rows: [] });
    const { GET } = await import("../route");
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.should_show).toBe(true);
    expect(trackEvent).toHaveBeenCalledWith(
      "welcome_tooltip.shown",
      "u-1",
      "dev",
      {},
    );
  });

  it("should_show=false when dismissal exists — does NOT fire shown event", async () => {
    getUserFromRequest.mockReturnValue(user);
    safeQuery.mockResolvedValue({ rows: [{ any: "1" }] });
    const { GET } = await import("../route");
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.should_show).toBe(false);
    expect(trackEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/me/welcome-tooltip", () => {
  beforeEach(() => jest.clearAllMocks());

  it("401 when unauthenticated", async () => {
    getUserFromRequest.mockReturnValue(null);
    const { POST } = await import("../route");
    const res = await POST(req("POST", { action: "dismissed" }, ""));
    expect(res.status).toBe(401);
  });

  it("400 on bad JSON", async () => {
    getUserFromRequest.mockReturnValue(user);
    const bad = new NextRequest("http://t/api/me/welcome-tooltip", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: "{not json",
    });
    const { POST } = await import("../route");
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it("400 when action is missing or invalid", async () => {
    getUserFromRequest.mockReturnValue(user);
    const { POST } = await import("../route");
    for (const action of [undefined, "", "other", 123]) {
      const res = await POST(req("POST", { action }));
      expect(res.status).toBe(400);
    }
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("records welcome_tooltip.dismissed on action=dismissed", async () => {
    getUserFromRequest.mockReturnValue(user);
    const { POST } = await import("../route");
    const res = await POST(req("POST", { action: "dismissed" }));
    expect(res.status).toBe(200);
    expect(trackEvent).toHaveBeenCalledWith(
      "welcome_tooltip.dismissed",
      "u-1",
      "dev",
      {},
    );
  });

  it("records welcome_tooltip.knowledge_clicked on action=knowledge_clicked", async () => {
    getUserFromRequest.mockReturnValue(user);
    const { POST } = await import("../route");
    const res = await POST(req("POST", { action: "knowledge_clicked" }));
    expect(res.status).toBe(200);
    expect(trackEvent).toHaveBeenCalledWith(
      "welcome_tooltip.knowledge_clicked",
      "u-1",
      "dev",
      {},
    );
  });
});
