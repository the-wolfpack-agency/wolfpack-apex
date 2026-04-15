/**
 * Tests for GET /api/security-posture
 *
 * Asserts:
 *   - Returns 200 with markdown content when Accept: application/json
 *   - Response contains "quantum" and "crypto-agile"
 *   - Emits system.security_posture_viewed analytics event
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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

// Mock fs.readFileSync to return a controlled markdown string
jest.mock("fs", () => ({
  readFileSync: jest.fn().mockReturnValue(
    "# Test Security Posture\n\nThis platform is crypto-agile and quantum-ready.\n\nHybrid TLS and post-quantum migration roadmap."
  ),
}));

import { NextRequest } from "next/server";

async function getHandler() {
  jest.resetModules();
  jest.mock("@/lib/analytics", () => ({
    trackEvent: (...args: any[]) => mockTrackEvent(...args),
  }));
  jest.mock("fs", () => ({
    readFileSync: jest.fn().mockReturnValue(
      "# Test Security Posture\n\nThis platform is crypto-agile and quantum-ready.\n\nHybrid TLS and post-quantum migration roadmap."
    ),
  }));
  const mod = await import("@/app/api/security-posture/route");
  return mod.GET;
}

describe("GET /api/security-posture", () => {
  beforeEach(() => {
    mockTrackEvent.mockClear();
  });

  it("returns 200 with markdown content", async () => {
    const GET = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/security-posture", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.content).toBeDefined();
    expect(json.format).toBe("markdown");
  });

  it("response content contains 'quantum'", async () => {
    const GET = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/security-posture", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const res = await GET(req);
    const json = await res.json();
    expect(json.content.toLowerCase()).toContain("quantum");
  });

  it("response content contains 'crypto-agile'", async () => {
    const GET = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/security-posture", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const res = await GET(req);
    const json = await res.json();
    expect(json.content.toLowerCase()).toContain("crypto-agile");
  });

  it("emits system.security_posture_viewed analytics event", async () => {
    const GET = await getHandler();
    const req = new NextRequest("https://instinct.wolfpackagency.com/api/security-posture", {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "TestAgent/1.0" },
    });
    await GET(req);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.security_posture_viewed",
      "anonymous",
      "public",
      expect.objectContaining({ user_agent_hash: expect.any(String) }),
    );
  });
});
