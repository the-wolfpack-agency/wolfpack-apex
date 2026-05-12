/**
 * Tests for POST /api/csp-report
 *
 * Asserts:
 *   - Valid report writes analytics event and returns 204
 *   - Malformed payload returns 400
 *   - Non-JSON body returns 400
 */

 

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock("@/lib/triple-write", () => ({
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";

async function getHandler() {
  jest.resetModules();
  jest.mock("@/lib/analytics", () => ({
    trackEvent: (...args: any[]) => mockTrackEvent(...args),
  }));
  const mod = await import("@/app/api/csp-report/route");
  return mod.POST;
}

describe("POST /api/csp-report", () => {
  beforeEach(() => {
    mockTrackEvent.mockClear();
  });

  it("accepts a valid CSP report and returns 204", async () => {
    const POST = await getHandler();
    const body = {
      "csp-report": {
        "blocked-uri": "https://evil.example.com/tracker.js",
        "violated-directive": "script-src 'self'",
        "source-file": "https://instinct.wolfpackagency.com/app",
        "line-number": 42,
      },
    };
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.csp_violation_reported",
      "system",
      "system",
      expect.objectContaining({
        blocked_uri: "https://evil.example.com/tracker.js",
        violated_directive: "script-src 'self'",
        source_file: "https://instinct.wolfpackagency.com/app",
        line_number: 42,
      }),
    );
  });

  it("returns 400 when csp-report key is missing", async () => {
    const POST = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ something: "else" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it("returns 400 for non-JSON body", async () => {
    const POST = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/csp-report", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when csp-report value is null", async () => {
    const POST = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "csp-report": null }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
