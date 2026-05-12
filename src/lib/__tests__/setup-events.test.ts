/**
 * Setup Events Tests
 *
 * Covers:
 *   - Migration 016 idempotency patterns
 *   - POST /api/analytics writes to instinct_setup_events for setup events
 *   - Non-setup events do NOT write to instinct_setup_events
 *   - Malformed setup event (missing step) is handled gracefully
 */

 

import { resolve } from "path";
import fs from "fs";

const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetUserFromRequest = jest.fn();

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
  getEventCounts: jest.fn().mockResolvedValue({}),
}));

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: any[]) => mockGetUserFromRequest(...args),
}));

// ---------------------------------------------------------------------------
// 1. Migration idempotency
// ---------------------------------------------------------------------------

describe("Migration 016 idempotency", () => {
  const migrationPath = resolve(__dirname, "../../db/migrations/016_setup_events.sql");
  const sql = fs.readFileSync(migrationPath, "utf-8");

  it("uses CREATE TABLE IF NOT EXISTS", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS instinct_setup_events");
  });

  it("uses CREATE OR REPLACE VIEW for the funnel view", () => {
    expect(sql).toContain("CREATE OR REPLACE VIEW instinct_setup_funnel");
  });

  it("uses CREATE INDEX IF NOT EXISTS for all indexes", () => {
    const indexMatches = sql.match(/CREATE INDEX/g) || [];
    const ifNotExistsMatches = sql.match(/CREATE INDEX IF NOT EXISTS/g) || [];
    expect(ifNotExistsMatches.length).toBe(indexMatches.length);
    expect(ifNotExistsMatches.length).toBeGreaterThan(0);
  });

  it("contains no DROP TABLE or DROP INDEX statements", () => {
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+INDEX/i);
    expect(sql).not.toMatch(/DROP\s+VIEW/i);
  });

  it("defines all required columns", () => {
    expect(sql).toContain("user_id");
    expect(sql).toContain("event_type");
    expect(sql).toContain("step");
    expect(sql).toContain("integration");
    expect(sql).toContain("duration_ms");
    expect(sql).toContain("attempt_number");
    expect(sql).toContain("metadata");
    expect(sql).toContain("created_at");
  });

  it("funnel view computes completion_rate and median_duration_ms", () => {
    expect(sql).toContain("completion_rate");
    expect(sql).toContain("median_duration_ms");
  });
});

// ---------------------------------------------------------------------------
// 2. POST /api/analytics — setup event writes to instinct_setup_events
// ---------------------------------------------------------------------------

describe("POST /api/analytics — setup event structured write", () => {
  const fakeUser = { id: "user@example.com", role: "cto", name: "Test User" };

  beforeEach(() => {
    jest.resetModules();
    mockSafeQuery.mockReset();
    mockTrackEvent.mockReset();
    mockGetUserFromRequest.mockReturnValue(fakeUser);
    // Default: safeQuery resolves without error
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  });

  function buildRequest(body: object, authHeader = "Bearer token") {
    return {
      headers: { get: (key: string) => (key === "authorization" ? authHeader : null) },
      json: async () => body,
    } as any;
  }

  async function callPost(body: object) {
    const { POST } = require("@/app/api/analytics/route");
    return POST(buildRequest(body));
  }

  it("writes to instinct_setup_events for system.setup_step_viewed with valid step", async () => {
    const res = await callPost({
      event: "system.setup_step_viewed",
      metadata: { step: "profile", step_name: "Profile", duration_ms: 1200, attempt_number: 1, user_role: "cto" },
    });
    const json = await res.json();
    expect(json.ok).toBe(true);

    const setupWrite = mockSafeQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("instinct_setup_events"),
    );
    expect(setupWrite).toBeDefined();
    // Second arg is the params array
    const params = setupWrite![1] as any[];
    expect(params[0]).toBe("user@example.com"); // user_id
    expect(params[1]).toBe("setup_step_viewed"); // event_type
    expect(params[2]).toBe("profile");           // step
  });

  it("passes integration column when present", async () => {
    await callPost({
      event: "system.setup_integration_connect_started",
      metadata: { step: "integrations", integration: "microsoft", attempt_number: 1, user_role: "cto" },
    });

    const setupWrite = mockSafeQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("instinct_setup_events"),
    );
    expect(setupWrite).toBeDefined();
    const params = setupWrite![1] as any[];
    expect(params[3]).toBe("microsoft"); // integration
  });

  it("does NOT write to instinct_setup_events for system.page_viewed", async () => {
    await callPost({
      event: "system.page_viewed",
      metadata: { page: "dashboard" },
    });

    const setupWrite = mockSafeQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("instinct_setup_events"),
    );
    expect(setupWrite).toBeUndefined();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.page_viewed",
      fakeUser.id,
      fakeUser.role,
      expect.any(Object),
    );
  });

  it("does NOT write to instinct_setup_events for non-setup system events", async () => {
    await callPost({ event: "system.login", metadata: {} });

    const setupWrite = mockSafeQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("instinct_setup_events"),
    );
    expect(setupWrite).toBeUndefined();
  });

  it("handles malformed setup event with missing step — logs warning, returns 200", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await callPost({
      event: "system.setup_step_viewed",
      metadata: { step_name: "Profile" }, // missing 'step'
    });
    const json = await res.json();

    // Should not crash — returns ok
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    // Should not have written to instinct_setup_events
    const setupWrite = mockSafeQuery.mock.calls.find(
      (call: any[]) => typeof call[0] === "string" && call[0].includes("instinct_setup_events"),
    );
    expect(setupWrite).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("returns 400 when event field is missing", async () => {
    const res = await callPost({ metadata: {} });
    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetUserFromRequest.mockReturnValue(null);
    const { POST } = require("@/app/api/analytics/route");
    const req = buildRequest({ event: "system.setup_step_viewed" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

export {};
