/**
 * Contract tests for POST /api/automations/[automationId]/quarantine/[id]/reprocess.
 *
 * The DB + ingest pipeline are mocked — we assert the route's auth gate,
 * 200/401/404/409 response shapes, and that the ingest function is
 * called with the persisted artifact bytes + canonical internet_message_id
 * (not the legacy mailbox-scoped source_message_id).
 */

import { NextRequest } from "next/server";

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

const mockIngest = jest.fn();
jest.mock("@/lib/automations/porsche-classes/ingest", () => ({
  ingestArtifact: (...a: unknown[]) => mockIngest(...a),
}));

// Capability mock — return ok with a synthetic admin user when the
// caller passes a "Bearer test" auth header; 401 otherwise.
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(async (req: NextRequest) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer test") {
      return {
        ok: true,
        user: {
          id: "u_admin",
          email: "admin@thewolfpack.agency",
          role: "admin",
        },
        capabilities: new Set(),
      };
    }
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    };
  }),
}));

import { POST } from "../route";

beforeEach(() => {
  jest.clearAllMocks();
});

function makeReq(authed: boolean): NextRequest {
  const headers = new Headers();
  if (authed) headers.set("authorization", "Bearer test");
  return new NextRequest("http://localhost/api/automations/porsche-classes/quarantine/exc-1/reprocess", {
    method: "POST",
    headers,
  });
}

describe("POST /api/automations/[automationId]/quarantine/[id]/reprocess", () => {
  it("returns 401 when the caller is unauthenticated", async () => {
    const res = await POST(makeReq(false), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "exc-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the automation slug is unknown", async () => {
    const res = await POST(makeReq(true), {
      params: Promise.resolve({ automationId: "not-real", id: "exc-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the exception row doesn't exist", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await POST(makeReq(true), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the exception was already resolved", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          exception_id: "exc-1",
          exception_status: "resolved",
          exception_kind: "parse_failure",
          exception_detail: "old failure",
          automation_id: "porsche-classes",
          artifact_id: "art-1",
          artifact_bytes: Buffer.from("xx"),
          artifact_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          artifact_received_at: "2026-05-01T10:00:00Z",
          artifact_source_message_id: "graph-msg-1",
          artifact_internet_message_id: "imid-1@host",
        },
      ],
    });
    const res = await POST(makeReq(true), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "exc-1" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 200 with the new ingest result when reprocess succeeds", async () => {
    // 1. Look up exception + artifact
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          exception_id: "exc-1",
          exception_status: "open",
          exception_kind: "parse_failure",
          exception_detail: "old failure",
          automation_id: "porsche-classes",
          artifact_id: "art-1",
          artifact_bytes: Buffer.from("xx"),
          artifact_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          artifact_received_at: "2026-05-01T10:00:00Z",
          artifact_source_message_id: "graph-msg-1",
          artifact_internet_message_id: "imid-1@host",
        },
      ],
    });
    // 2. Update artifact dedup_key (free up the canonical key)
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art-1" }] });
    // 3. Resolve the exception
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "exc-1" }] });
    // 4. Ingest returns success
    mockIngest.mockResolvedValueOnce({
      artifact_id: "art-2",
      was_duplicate: false,
      parse_status: "processed",
      snapshots_written: 1,
      deltas_written: 1,
    });

    const res = await POST(makeReq(true), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "exc-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: string; ingest: unknown };
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("processed");

    // The ingest must be called with the canonical RFC 5322 id so the
    // new dedup key is "imid:..." (the bug fix the migration is built
    // around).
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        source_type: "porsche_xlsx",
        internet_message_id: "imid-1@host",
        bytes: expect.any(Buffer),
      }),
    );

    // Analytics event was emitted.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "automations.quarantine_reprocessed",
      "u_admin",
      "admin",
      expect.objectContaining({
        automation_id: "porsche-classes",
        outcome: "processed",
      }),
    );
  });

  it("reports outcome='still_quarantined' when the new ingest also fails to parse", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          exception_id: "exc-2",
          exception_status: "open",
          exception_kind: "parse_failure",
          exception_detail: "bad header",
          automation_id: "porsche-classes",
          artifact_id: "art-2",
          artifact_bytes: Buffer.from("xx"),
          artifact_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          artifact_received_at: "2026-05-02T10:00:00Z",
          artifact_source_message_id: null,
          artifact_internet_message_id: null,
        },
      ],
    });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "art-2" }] });
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "exc-2" }] });
    mockIngest.mockResolvedValueOnce({
      artifact_id: "art-2-new",
      was_duplicate: false,
      parse_status: "error_quarantined",
      snapshots_written: 0,
      deltas_written: 0,
      exception_id: "exc-3",
    });
    const res = await POST(makeReq(true), {
      params: Promise.resolve({ automationId: "porsche-classes", id: "exc-2" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("still_quarantined");
  });
});
