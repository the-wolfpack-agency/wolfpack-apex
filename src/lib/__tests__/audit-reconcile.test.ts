/**
 * audit-reconcile.test.ts — analyzeChain classifies EVERY chain break in one
 * pass (authentic concurrency fork vs genuine content tamper), and reconcileChain
 * acknowledges all authentic forks at once while REFUSING if any tamper exists.
 *
 * This is the permanent fix for the whack-a-mole the seq-509 / seq-1216 alerts
 * exposed: verifyChain stops at the first break, so anchoring one fork just
 * revealed the next legacy fork. analyzeChain sees them all; reconcileChain
 * drains them safely without ever papering over a rewritten row.
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
jest.mock("@/lib/analytics", () => ({ trackEvent: (...args: unknown[]) => mockTrackEvent(...args) }));

import { analyzeChain, reconcileChain, computeEntryHash, GENESIS_HASH } from "@/lib/audit-log";

type Row = {
  seq: string; ts: string; actor_user_id: string; actor_role: string; action: string;
  resource_type: string; resource_id: string | null; before_state: unknown; after_state: unknown;
  ip_address: string | null; user_agent: string | null; request_id: string | null;
  prev_hash: string | null; entry_hash: string;
};

/** Build a row whose entry_hash is computed over `after`, but whose STORED
 *  after_state is `storedAfter` (defaults to `after`). Passing a different
 *  storedAfter simulates a content tamper (hash no longer matches the row). */
function mkRow(seq: number, prevHash: string, after: unknown, storedAfter?: unknown): Row {
  const ts = `2026-04-15T00:00:${String(seq).padStart(2, "0")}.000Z`;
  const entry_hash = computeEntryHash(prevHash, {
    seq, ts, actor_user_id: "u1", actor_role: "cto", action: `a.${seq}`,
    resource_type: "r", resource_id: null, before_state: null, after_state: after,
    ip_address: null, user_agent: null, request_id: null,
  });
  return {
    seq: String(seq), ts, actor_user_id: "u1", actor_role: "cto", action: `a.${seq}`,
    resource_type: "r", resource_id: null, before_state: null,
    after_state: storedAfter !== undefined ? storedAfter : after,
    ip_address: null, user_agent: null, request_id: null,
    prev_hash: seq === 1 ? null : prevHash, entry_hash,
  };
}

function mockAnalyze(anchorSeqs: number[], rows: Row[]): void {
  mockQuery.mockResolvedValueOnce({ rows: anchorSeqs.map((s) => ({ seq: String(s) })) }); // anchors
  mockQuery.mockResolvedValueOnce({ rows }); // full chain
}

/** A recordAudit-shaped pg client (BEGIN, lock, SELECT prev, nextval, INSERT RETURNING, COMMIT). */
function buildAuditClient() {
  let idx = 0;
  const rows = [[], [], [], [{ nextval: "100" }], [{ id: "uuid-x" }], []];
  return { query: jest.fn(async () => ({ rows: rows[idx++] ?? [] })), release: jest.fn() };
}

beforeAll(() => { process.env.DATABASE_URL = "postgres://test"; });
beforeEach(() => jest.clearAllMocks());

describe("analyzeChain", () => {
  it("clean chain: valid, no forks, no tampers", async () => {
    const r1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const r2 = mkRow(2, r1.entry_hash, { i: 2 });
    const r3 = mkRow(3, r2.entry_hash, { i: 3 });
    mockAnalyze([], [r1, r2, r3]);
    const a = await analyzeChain();
    expect(a).toMatchObject({ valid: true, checkedCount: 3, forkSeqs: [], tamperSeqs: [] });
  });

  it("authentic concurrency fork: flagged as a fork, NOT a tamper", async () => {
    const f1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const f2 = mkRow(2, f1.entry_hash, { i: 2 });
    // seq 3 links to f1 (stale, should be f2) but its hash is self-valid off f1.
    const f3 = mkRow(3, f1.entry_hash, { i: 3 });
    const f4 = mkRow(4, f3.entry_hash, { i: 4 }); // resumes cleanly off f3
    mockAnalyze([], [f1, f2, f3, f4]);
    const a = await analyzeChain();
    expect(a.valid).toBe(false);
    expect(a.forkSeqs).toEqual([3]);
    expect(a.tamperSeqs).toEqual([]);
    expect(a.checkedCount).toBe(4);
  });

  it("content tamper: row hash no longer matches its fields -> tamper, not fork", async () => {
    const t1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const t2 = mkRow(2, t1.entry_hash, { i: 2 });
    const t3 = mkRow(3, t2.entry_hash, { i: 3 }, { i: 999 }); // stored content != hashed content
    mockAnalyze([], [t1, t2, t3]);
    const a = await analyzeChain();
    expect(a.tamperSeqs).toEqual([3]);
    expect(a.forkSeqs).toEqual([]);
  });

  it("mixed: reports both the fork and the tamper distinctly", async () => {
    const m1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const m2 = mkRow(2, m1.entry_hash, { i: 2 });
    const m3 = mkRow(3, m1.entry_hash, { i: 3 }); // fork
    const m4 = mkRow(4, m3.entry_hash, { i: 4 });
    const m5 = mkRow(5, m4.entry_hash, { i: 5 }, { i: 999 }); // tamper
    mockAnalyze([], [m1, m2, m3, m4, m5]);
    const a = await analyzeChain();
    expect(a.forkSeqs).toEqual([3]);
    expect(a.tamperSeqs).toEqual([5]);
  });

  it("notes forks already acknowledged in the anchors table", async () => {
    const f1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const f2 = mkRow(2, f1.entry_hash, { i: 2 });
    const f3 = mkRow(3, f1.entry_hash, { i: 3 });
    mockAnalyze([3], [f1, f2, f3]);
    const a = await analyzeChain();
    expect(a.forkSeqs).toEqual([3]);
    expect(a.alreadyAnchored).toEqual([3]);
  });
});

describe("reconcileChain", () => {
  it("REFUSES (anchors nothing) when any genuine tamper is present", async () => {
    const t1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const t2 = mkRow(2, t1.entry_hash, { i: 2 }, { i: 999 }); // tamper
    mockAnalyze([], [t1, t2]);
    const r = await reconcileChain({ user_id: "cto", role: "cto" });
    expect(r.refused).toBe(true);
    expect(r.reconciled).toBe(0);
    expect(r.tamperSeqs).toEqual([2]);
    // analyzeChain did its 2 reads; no anchor INSERT was attempted.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("anchors every authentic fork and reports the count", async () => {
    const f1 = mkRow(1, GENESIS_HASH, { i: 1 });
    const f2 = mkRow(2, f1.entry_hash, { i: 2 });
    const f3 = mkRow(3, f1.entry_hash, { i: 3 }); // fork
    mockAnalyze([], [f1, f2, f3]);
    // reanchorChain(3): anchor INSERT returns a fresh row, then recordAudit connects.
    mockQuery.mockResolvedValueOnce({ rows: [{ seq: "3" }] });
    mockConnect.mockResolvedValueOnce(buildAuditClient());

    const r = await reconcileChain({ user_id: "cto", role: "cto" });
    expect(r.refused).toBe(false);
    expect(r.forkSeqs).toEqual([3]);
    expect(r.reconciled).toBe(1);
    expect(r.newlyReconciledSeqs).toEqual([3]);
    // The anchor INSERT carried the concurrency-fork reason.
    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes("instinct_audit_chain_anchors") && String(c[0]).includes("INSERT"));
    expect(insertCall).toBeTruthy();
    expect(String(insertCall![1])).toContain("concurrency_fork");
  });
});
