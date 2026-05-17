/**
 * /api/health/integrations — per-workspace integration health envelope.
 *
 * Two modes:
 *   - default (no params): reads latest persisted rows from the
 *     integration_health_latest view. Cheap; safe to poll.
 *   - ?run=true: actively probes each vendor + persists. AgenticQA's
 *     nightly orchestrator hits this endpoint.
 *
 * Tests pin: auth gate, response shape, run=true side effects, drift
 * computation against the prior schema_hash.
 */

const mockSafeQuery = jest.fn();
const mockRunProbe = jest.fn();
const mockPersistProbeResult = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/health/integration-probes", () => ({
  runProbe: (...a: unknown[]) => mockRunProbe(...a),
  persistProbeResult: (...a: unknown[]) => mockPersistProbeResult(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

const AUTH_USER = { id: "u1", role: "cto", name: "Nick", email: "n@x.co", workspaceId: "ws1" };
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => AUTH_USER,
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function get(url = "https://x.test/api/health/integrations"): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockRunProbe.mockReset();
  mockPersistProbeResult.mockReset();
  mockTrackEvent.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  mockSafeQuery.mockResolvedValue({ rows: [] });
});

describe("GET /api/health/integrations", () => {
  test("returns 401 when caller is unauthenticated", async () => {
    jest.resetModules();
    jest.doMock("@/lib/auth", () => ({ getUserFromRequest: () => null }));
    const { GET: FreshGET } = await import("../route");
    const res = await FreshGET(get());
    expect(res.status).toBe(401);
  });

  test("returns the per-vendor envelope from the latest view", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          vendor: "microsoft",
          probe_kind: "connectivity",
          object_type: null,
          ok: true,
          status_code: null,
          schema_hash: null,
          error_message: null,
          duration_ms: 42,
          probed_at: "2026-05-17T11:00:00Z",
        },
        {
          vendor: "salesforce",
          probe_kind: "schema",
          object_type: "deal",
          ok: true,
          status_code: 200,
          schema_hash: "hash-A",
          error_message: null,
          duration_ms: 200,
          probed_at: "2026-05-17T11:00:00Z",
        },
      ],
    });
    /* Drift lookup returns no prior row → not drifted. */
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const res = await GET(get());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.workspaceId).toBe("ws1");
    expect(body.sweepRan).toBe(false);
    const ms = body.vendors.find((v: { vendor: string }) => v.vendor === "microsoft");
    expect(ms.connectivity.ok).toBe(true);
    const sf = body.vendors.find((v: { vendor: string }) => v.vendor === "salesforce");
    expect(sf.schema[0]).toEqual(
      expect.objectContaining({ objectType: "deal", ok: true, schemaHash: "hash-A", drifted: false }),
    );
  });

  test("?run=true fans out probes + persists each result", async () => {
    mockRunProbe.mockResolvedValue({
      vendor: "microsoft",
      probeKind: "connectivity",
      ok: true,
      durationMs: 10,
    });
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const res = await GET(get("https://x.test/api/health/integrations?run=true"));
    expect(res.status).toBe(200);
    /* Probes fire for each (vendor, objectType) row in DEFAULT_VENDORS.
     * Persistence is called for each one. */
    expect(mockRunProbe).toHaveBeenCalled();
    expect(mockPersistProbeResult).toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "integration.health_sweep",
      "u1",
      "cto",
      expect.objectContaining({ workspace_id: "ws1" }),
    );
    const body = await res.json();
    expect(body.sweepRan).toBe(true);
  });

  test("computes drifted=true when a prior schema_hash differs", async () => {
    mockSafeQuery
      /* First call: latest rows. */
      .mockResolvedValueOnce({
        rows: [
          {
            vendor: "salesforce",
            probe_kind: "schema",
            object_type: "deal",
            ok: true,
            status_code: 200,
            schema_hash: "hash-NEW",
            error_message: null,
            duration_ms: 200,
            probed_at: "2026-05-17T11:00:00Z",
          },
        ],
      })
      /* Second call: drift lookup returns a different prior hash. */
      .mockResolvedValueOnce({ rows: [{ schema_hash: "hash-OLD" }] });
    const res = await GET(get());
    const body = await res.json();
    const sf = body.vendors.find((v: { vendor: string }) => v.vendor === "salesforce");
    expect(sf.schema[0].drifted).toBe(true);
  });

  test("skips schema probes when connectivity fails for that vendor", async () => {
    /* First call (microsoft connectivity) → not ok. Subsequent
     * vendor calls still happen but their schema probes are
     * skipped because connectivity didn't return ok. */
    mockRunProbe.mockImplementation(
      async (vendor: string, kind: string) => ({
        vendor,
        probeKind: kind,
        ok: false,
        errorMessage: "down",
        durationMs: 5,
      }),
    );
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await GET(get("https://x.test/api/health/integrations?run=true"));
    /* Verify NO schema probe call was made — only connectivity calls
     * for each of the 4 vendors. */
    const schemaCalls = mockRunProbe.mock.calls.filter((c) => c[1] === "schema");
    expect(schemaCalls).toHaveLength(0);
  });
});
