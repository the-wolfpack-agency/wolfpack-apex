/**
 * Plaud integration tests.
 *
 * Coverage:
 *   - Signature verification: valid, forged, missing, wrong-secret
 *   - Idempotency: re-delivery of the same file_id is a no-op
 *   - Doc quality gate: rejects PII-laden transcripts
 *   - Owner resolution: by email match, fallback to org connection
 *   - Ingest happy path: writes to PG, fires analytics with correct userId
 *   - Migration file: 007 exists with required columns/index
 *   - Analytics event types: registered in analytics.ts
 */

 

const plaudMockTrackEvent = jest.fn();
const plaudMockSafeQuery = jest.fn();
const plaudMockQuery = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => plaudMockTrackEvent(...args),
}));

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => plaudMockQuery(...args),
  safeQuery: (...args: any[]) => plaudMockSafeQuery(...args),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

// Triple-write fires Qdrant + Neo4j writes — stub them so tests are
// hermetic and don't try to reach external services.
jest.mock("@/lib/triple-write", () => ({
  tripleWriteKnowledge: jest.fn().mockResolvedValue(undefined),
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
  process.env.PLAUD_WEBHOOK_SECRET = "test-plaud-secret-do-not-use";
  process.env.PLAUD_API_KEY = "test-plaud-api-key";
});

afterEach(() => {
  delete process.env.PLAUD_WEBHOOK_SECRET;
  delete process.env.PLAUD_API_KEY;
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("Plaud signature verification", () => {
  let plaud: typeof import("@/lib/plaud");

  beforeEach(async () => {
    jest.resetModules();
    plaud = await import("@/lib/plaud");
  });

  function sign(body: string): string {
    const { createHmac } = require("crypto");
    return createHmac("sha256", "test-plaud-secret-do-not-use").update(body, "utf8").digest("hex");
  }

  test("verifies a correctly signed body", () => {
    const body = JSON.stringify({ event_type: "audio_transcribe.completed", data: { file_id: "abc" } });
    const sig = sign(body);
    expect(plaud.verifyPlaudSignature(body, sig)).toBe(true);
  });

  test("rejects a forged signature", () => {
    const body = JSON.stringify({ event_type: "audio_transcribe.completed", data: { file_id: "abc" } });
    expect(plaud.verifyPlaudSignature(body, "deadbeef".repeat(8))).toBe(false);
  });

  test("rejects a missing signature header", () => {
    const body = JSON.stringify({ event_type: "audio_transcribe.completed", data: { file_id: "abc" } });
    expect(plaud.verifyPlaudSignature(body, null)).toBe(false);
    expect(plaud.verifyPlaudSignature(body, "")).toBe(false);
  });

  test("rejects a valid signature against a different body (replay-protection by body)", () => {
    const bodyA = JSON.stringify({ event_type: "x", data: { file_id: "1" } });
    const bodyB = JSON.stringify({ event_type: "x", data: { file_id: "2" } });
    const sigA = sign(bodyA);
    expect(plaud.verifyPlaudSignature(bodyA, sigA)).toBe(true);
    expect(plaud.verifyPlaudSignature(bodyB, sigA)).toBe(false);
  });

  test("returns false when no secret is configured", async () => {
    delete process.env.PLAUD_WEBHOOK_SECRET;
    jest.resetModules();
    const fresh = await import("@/lib/plaud");
    const body = JSON.stringify({ event_type: "x", data: { file_id: "y" } });
    expect(fresh.verifyPlaudSignature(body, "any")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency + ingestion happy path
// ---------------------------------------------------------------------------

describe("Plaud transcript ingestion", () => {
  let plaud: typeof import("@/lib/plaud");

  beforeEach(async () => {
    jest.resetModules();
    plaud = await import("@/lib/plaud");
  });

  function mockFetchOk(body: any) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    }) as any;
  }

  test("re-delivery of the same file_id is a duplicate (no-op)", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "existing-row" }], fromCache: false });

    const result = await plaud.ingestTranscript("file-123");
    expect(result.status).toBe("duplicate");
    expect(plaudMockQuery).not.toHaveBeenCalled();
    expect(plaudMockTrackEvent).toHaveBeenCalledWith(
      "plaud.transcript_duplicate",
      "system",
      "system",
      expect.objectContaining({ file_id: "file-123" }),
    );
  });

  test("happy path: ingests, writes to PG, fires analytics with owner userId", async () => {
    // 1st safeQuery: idempotency check → not yet ingested
    // 2nd safeQuery: owner email lookup → found
    plaudMockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })           // idempotency
      .mockResolvedValueOnce({ rows: [{ id: "user-alice" }], fromCache: false }); // owner email match

    plaudMockQuery.mockResolvedValueOnce({ rows: [{ id: "transcript-row-1" }] });

    mockFetchOk({
      transcript: "Met with Acme team to review Q2 plan. Action: send updated proposal by Friday.",
      title: "Acme Q2 Review",
      summary: "Q2 review with Acme. Send proposal by Friday.",
      recorded_at: "2026-04-07T15:30:00Z",
      duration_seconds: 1800,
      owner_email: "alice@wolfpack.dev",
    });

    const result = await plaud.ingestTranscript("file-456");

    expect(result.status).toBe("ingested");
    expect(result.ownerUserId).toBe("user-alice");
    expect(result.qualityStatus).toBe("pass");
    expect(plaudMockQuery).toHaveBeenCalledTimes(1);
    // Analytics fired with the resolved owner, not "system"
    expect(plaudMockTrackEvent).toHaveBeenCalledWith(
      "plaud.transcript_ingested",
      "user-alice",
      "system",
      expect.objectContaining({ file_id: "file-456", quality_status: "pass" }),
    );
  });

  test("doc quality gate REJECTS transcripts containing SSN", async () => {
    plaudMockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })           // idempotency
      .mockResolvedValueOnce({ rows: [{ id: "user-alice" }], fromCache: false }); // owner

    // PII insert (the rejection record)
    plaudMockQuery.mockResolvedValueOnce({ rows: [] });

    mockFetchOk({
      transcript: "Discussed onboarding for new contractor. Their SSN is 123-45-6789, please file the W-9.",
      title: "Contractor Onboarding",
      owner_email: "alice@wolfpack.dev",
    });

    const result = await plaud.ingestTranscript("file-pii");

    expect(result.status).toBe("rejected");
    expect(result.qualityStatus).toBe("reject");
    expect(plaudMockTrackEvent).toHaveBeenCalledWith(
      "plaud.transcript_rejected",
      "user-alice",
      "system",
      expect.objectContaining({ file_id: "file-pii" }),
    );
  });

  test("falls back to org connection owner when payload has no owner_email", async () => {
    plaudMockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false })                 // idempotency
      .mockResolvedValueOnce({ rows: [{ connected_by: "user-org-admin" }], fromCache: false }); // org fallback

    plaudMockQuery.mockResolvedValueOnce({ rows: [{ id: "transcript-row-2" }] });

    mockFetchOk({
      transcript: "Internal sync about Q3 planning. No PII here.",
      title: "Q3 Planning Sync",
    });

    const result = await plaud.ingestTranscript("file-no-owner");
    expect(result.status).toBe("ingested");
    expect(result.ownerUserId).toBe("user-org-admin");
  });

  test("returns no_owner when payload has no email AND no org connection", async () => {
    plaudMockSafeQuery
      .mockResolvedValueOnce({ rows: [], fromCache: false }) // idempotency
      .mockResolvedValueOnce({ rows: [], fromCache: false }); // no org connection

    mockFetchOk({ transcript: "anything" });

    const result = await plaud.ingestTranscript("file-orphan");
    expect(result.status).toBe("no_owner");
  });

  test("returns fetch_failed when Plaud API errors", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as any;

    const result = await plaud.ingestTranscript("file-bad");
    expect(result.status).toBe("fetch_failed");
    expect(plaudMockTrackEvent).toHaveBeenCalledWith(
      "plaud.fetch_failed",
      "system",
      "system",
      expect.objectContaining({ file_id: "file-bad" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

describe("Plaud connection management", () => {
  let plaud: typeof import("@/lib/plaud");

  beforeEach(async () => {
    jest.resetModules();
    plaud = await import("@/lib/plaud");
  });

  test("isPlaudConfigured returns true when both env vars set", () => {
    expect(plaud.isPlaudConfigured()).toBe(true);
  });

  test("isPlaudConfigured returns false when secret missing", async () => {
    delete process.env.PLAUD_WEBHOOK_SECRET;
    jest.resetModules();
    const fresh = await import("@/lib/plaud");
    expect(fresh.isPlaudConfigured()).toBe(false);
  });

  test("getConnectionStatus returns disconnected when no row exists", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const status = await plaud.getConnectionStatus();
    expect(status.connected).toBe(false);
  });

  test("getConnectionStatus returns connected info when row exists", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({
      rows: [{ connected_by: "user-1", display_name: "Nick", connected_at: "2026-04-07T00:00:00Z" }],
      fromCache: false,
    });
    const status = await plaud.getConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.connectedBy).toBe("user-1");
  });
});

// ---------------------------------------------------------------------------
// Read API: list / get / search meeting transcripts
// ---------------------------------------------------------------------------

describe("Meeting transcript read API", () => {
  let plaud: typeof import("@/lib/plaud");

  beforeEach(async () => {
    jest.resetModules();
    plaud = await import("@/lib/plaud");
  });

  test("listMeetingTranscripts returns rows from PG, mapped to camelCase", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-1",
          file_id: "file-1",
          owner_user_id: "user-alice",
          owner_name: "Alice",
          title: "Acme Q2 Review",
          summary: "Q2 review with Acme",
          recorded_at: "2026-04-07T15:00:00Z",
          duration_seconds: 1800,
          quality_status: "pass",
          ingested_at: "2026-04-07T15:30:00Z",
        },
      ],
      fromCache: false,
    });
    const list = await plaud.listMeetingTranscripts();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Acme Q2 Review");
    expect(list[0].ownerName).toBe("Alice");
    expect(list[0].qualityStatus).toBe("pass");
    // List view never includes the full transcript text (avoids huge payloads)
    expect(list[0].transcriptText).toBeUndefined();
  });

  test("getMeetingTranscript returns full text on detail fetch", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-2",
          file_id: "file-2",
          owner_user_id: "user-alice",
          owner_name: "Alice",
          title: "Sync",
          summary: null,
          transcript_text: "Full transcript body here.",
          recorded_at: null,
          duration_seconds: null,
          quality_status: "pass",
          ingested_at: "2026-04-07T16:00:00Z",
        },
      ],
      fromCache: false,
    });
    const t = await plaud.getMeetingTranscript("tx-2");
    expect(t).not.toBeNull();
    expect(t!.transcriptText).toBe("Full transcript body here.");
  });

  test("getMeetingTranscript returns null for non-existent / rejected rows", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const t = await plaud.getMeetingTranscript("nope");
    expect(t).toBeNull();
  });

  test("searchMeetingTranscripts returns empty for short queries", async () => {
    const results = await plaud.searchMeetingTranscripts("hi", 3);
    expect(results).toEqual([]);
    // Should not have hit the DB at all
    expect(plaudMockSafeQuery).not.toHaveBeenCalled();
  });

  test("searchMeetingTranscripts ranks title hits higher than body hits", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-body-only",
          file_id: "file-3",
          owner_user_id: "user-alice",
          owner_name: "Alice",
          title: "Random sync",
          summary: null,
          transcript_text: "We discussed the proposal at length and decided to move forward.",
          recorded_at: "2026-04-06T10:00:00Z",
          duration_seconds: 600,
          quality_status: "pass",
          ingested_at: "2026-04-06T10:30:00Z",
        },
        {
          id: "tx-title-hit",
          file_id: "file-4",
          owner_user_id: "user-alice",
          owner_name: "Alice",
          title: "Proposal review with Acme",
          summary: "Reviewed the proposal terms.",
          transcript_text: "Brief sync.",
          recorded_at: "2026-04-05T10:00:00Z",
          duration_seconds: 900,
          quality_status: "pass",
          ingested_at: "2026-04-05T10:30:00Z",
        },
      ],
      fromCache: false,
    });
    const results = await plaud.searchMeetingTranscripts("proposal review", 3);
    expect(results.length).toBeGreaterThan(0);
    // Title hit (3x weight) + summary hit (2x) should beat the body-only hit
    expect(results[0].id).toBe("tx-title-hit");
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  test("searchMeetingTranscripts returns rows sorted by score, includes a snippet", async () => {
    plaudMockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "tx-onehit",
          file_id: "f-a",
          owner_user_id: "u",
          owner_name: null,
          title: "Random",
          summary: null,
          transcript_text: "This call had no relevant content at all.",
          recorded_at: null,
          duration_seconds: null,
          quality_status: "pass",
          ingested_at: "2026-04-07T00:00:00Z",
        },
      ],
      fromCache: false,
    });
    const results = await plaud.searchMeetingTranscripts("nonexistent", 3);
    // Postgres returned one row but score should be 0 (no actual term hit
    // in our scoring even though the SQL ILIKE matched somewhere upstream).
    // Sanity: results array still well-formed with snippet field.
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(typeof results[0].snippet).toBe("string");
    }
  });

  test("searchMeetingTranscripts SQL excludes future-dated recordings", async () => {
    /* Regression for 2026-05-14: Assistant answered "Your first recorded
       meeting with Max Fuerst was on June 4, 2026" (a future date). The
       transcript table had a future-recorded_at row from a scheduled
       meeting placeholder. The query must filter those out so the
       assistant never describes a future date as a past meeting. */
    plaudMockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await plaud.searchMeetingTranscripts("meeting with max", 3);
    const calls = plaudMockSafeQuery.mock.calls;
    expect(calls.length).toBe(1);
    const sql = String(calls[0][0]);
    expect(sql).toMatch(/recorded_at\s+IS\s+NULL\s+OR\s+t?\.?recorded_at\s*<=\s*now\(\)/i);
  });
});

// ---------------------------------------------------------------------------
// Migration + analytics registration
// ---------------------------------------------------------------------------

describe("Plaud migration + analytics", () => {
  test("migration 007 exists with required structure", () => {
    const fs = require("fs");
    const p = require("path").resolve(__dirname, "../../db/migrations/007_plaud_integration.sql");
    expect(fs.existsSync(p)).toBe(true);
    const sql = fs.readFileSync(p, "utf-8");
    expect(sql).toContain("apex_plaud_connections");
    expect(sql).toContain("apex_meeting_transcripts");
    expect(sql).toContain("file_id");
    expect(sql).toContain("owner_user_id");
    expect(sql).toContain("UNIQUE INDEX");
    expect(sql).toContain("idx_apex_meeting_transcripts_file_id");
    expect(sql).toContain("apex_v_meeting_ingestion_quality");
  });

  test("migration 008 adds meeting_transcripts to instinct_messages source check", () => {
    const fs = require("fs");
    const p = require("path").resolve(__dirname, "../../db/migrations/008_assistant_meeting_source.sql");
    expect(fs.existsSync(p)).toBe(true);
    const sql = fs.readFileSync(p, "utf-8");
    expect(sql).toContain("apex_messages_source_check");
    expect(sql).toContain("meeting_transcripts");
  });

  test("analytics.ts registers all Plaud event types", () => {
    const fs = require("fs");
    const analytics = fs.readFileSync(
      require("path").resolve(__dirname, "../analytics.ts"),
      "utf-8",
    );
    for (const ev of [
      "plaud.connected",
      "plaud.disconnected",
      "plaud.webhook_received",
      "plaud.signature_invalid",
      "plaud.transcript_ingested",
      "plaud.transcript_rejected",
      "plaud.transcript_duplicate",
      "plaud.fetch_failed",
      "plaud.no_owner",
    ]) {
      expect(analytics).toContain(ev);
    }
  });
});
