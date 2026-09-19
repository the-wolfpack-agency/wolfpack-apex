/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@/lib/harness/harness", () => ({
  HARNESS_TTL_MINUTES: 30,
  createHarnessSession: jest.fn(async (i: { goal?: string; agentLabel?: string }) => ({
    id: "hs_test123", goal: i.goal ?? "default goal", agentLabel: i.agentLabel ?? "unlabeled agent", expiresAt: "2026-09-19T00:30:00Z",
  })),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { POST, OPTIONS } from "@/app/api/harness/session/route";

function req(origin: string | null, body?: unknown) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (origin) h.origin = origin;
  return new NextRequest("https://apex.test/api/harness/session", { method: "POST", headers: h, body: body ? JSON.stringify(body) : undefined });
}

describe("POST /api/harness/session (public)", () => {
  it("returns 200 with the sandbox + reading URLs built from the session token", async () => {
    const res = await POST(req("https://ogiam.com", { goal: "find admin", agentLabel: "gpt + custom" }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.sessionId).toBe("hs_test123");
    expect(j.targetUrl).toBe("https://apex.test/harness/hs_test123"); // no trailing slash: the slashed form 308-redirects
    expect(j.targetUrl.endsWith("/")).toBe(false);
    expect(j.readingUrl).toBe("https://apex.test/api/harness/hs_test123/reading");
    expect(j.robotsUrl).toContain("/robots.txt");
    expect(typeof j.instructions).toBe("string");
  });

  it("echoes an allowed origin in the CORS header", async () => {
    const res = await POST(req("https://ogiam.com", {}));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://ogiam.com");
  });

  it("falls back to the default origin for a disallowed origin", async () => {
    const res = await POST(req("https://evil.example", {}));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://ogiam.com");
  });

  it("tolerates an empty/absent body (all fields optional)", async () => {
    const res = await POST(req("https://ogiam.com"));
    expect(res.status).toBe(200);
  });

  it("answers the CORS preflight with 204", async () => {
    const res = await OPTIONS(req("https://ogiam.com"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
