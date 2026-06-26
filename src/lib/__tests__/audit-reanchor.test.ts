/**
 * audit-reanchor.test.ts — reanchorChain records an acknowledged, non-tamper
 * chain break, audits the action (hash-chained, no secrets), and emits the
 * learning-loop analytics event. Idempotent on an already-anchored seq.
 */

export {};

const mockConnect = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  pool: { connect: (...args: unknown[]) => mockConnect(...args) },
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) =>
    mockQuery(...args).then((r: any) => ({ rows: r.rows, fromCache: false })),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { reanchorChain } from "@/lib/audit-log";

/** A recordAudit-shaped pg client (BEGIN, lock, SELECT prev, nextval, INSERT, COMMIT). */
function buildAuditClient() {
  let idx = 0;
  const rows = [
    [], // BEGIN
    [], // pg_advisory_xact_lock
    [], // SELECT prev (empty)
    [{ nextval: "510" }], // nextval
    [{ id: "uuid-reanchor-audit" }], // INSERT RETURNING id
    [], // COMMIT
  ];
  return {
    query: jest.fn(async () => ({ rows: rows[idx++] ?? [] })),
    release: jest.fn(),
  };
}

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("reanchorChain", () => {
  it("inserts a fresh anchor, audits the action, and emits the analytics event", async () => {
    // First mockQuery call = the anchor INSERT ... RETURNING seq (fresh => 1 row).
    mockQuery.mockResolvedValueOnce({ rows: [{ seq: "509" }] });
    // recordAudit (called inside reanchorChain) connects a client.
    mockConnect.mockResolvedValueOnce(buildAuditClient());

    const result = await reanchorChain(509, "concurrency fork (read-committed FOR UPDATE)", {
      user_id: "u_cto",
      role: "cto",
    });

    expect(result.seq).toBe(509);
    expect(result.acknowledgedBy).toBe("u_cto");
    expect(result.alreadyAnchored).toBe(false);

    // Anchor INSERT is idempotent (ON CONFLICT DO NOTHING).
    const insertCall = mockQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO instinct_audit_chain_anchors"),
    );
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toContain("ON CONFLICT (seq) DO NOTHING");
    expect((insertCall![1] as unknown[])[0]).toBe(509);

    // The re-anchor is itself audited via recordAudit (a client was connected).
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Learning-loop event emitted with meta only (no secrets).
    const evt = mockTrackEvent.mock.calls.find((c) => c[0] === "system.audit_log_reanchored");
    expect(evt).toBeDefined();
    expect(evt![1]).toBe("u_cto");
    expect(evt![3]).toEqual(
      expect.objectContaining({ seq: 509, already_anchored: false }),
    );
  });

  it("is idempotent: an already-anchored seq returns alreadyAnchored=true", async () => {
    // ON CONFLICT DO NOTHING => no returned row.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockConnect.mockResolvedValueOnce(buildAuditClient());

    const result = await reanchorChain(509, "re-ack", { user_id: "u_cto", role: "cto" });

    expect(result.alreadyAnchored).toBe(true);
    const evt = mockTrackEvent.mock.calls.find((c) => c[0] === "system.audit_log_reanchored");
    expect(evt![3]).toEqual(expect.objectContaining({ already_anchored: true }));
  });

  it("is a no-op (shadow values) when DATABASE_URL is unset", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const result = await reanchorChain(509, "x", { user_id: "u_cto", role: "cto" });
      expect(result.seq).toBe(509);
      expect(result.alreadyAnchored).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
