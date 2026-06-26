/**
 * audit-verify.test.ts — verifyChain returns valid=true for clean chains,
 * pinpoints the broken seq when a middle row is tampered.
 *
 * We bypass the public API: simulate rows directly via mock, including
 * a tampered row.
 */

 

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  pool: { connect: jest.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) => mockQuery(...args).then((r: any) => ({ rows: r.rows, fromCache: false })),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import { verifyChain, computeEntryHash, GENESIS_HASH } from "@/lib/audit-log";

/**
 * verifyChain now loads acknowledged re-anchor seqs FIRST (one query against
 * instinct_audit_chain_anchors) before the main rows SELECT. This helper queues
 * the anchor query result then the rows result, in the order verifyChain reads.
 */
function mockVerifyQueries(anchorSeqs: number[], rows: Row[]): void {
  mockQuery.mockResolvedValueOnce({ rows: anchorSeqs.map((s) => ({ seq: String(s) })) });
  mockQuery.mockResolvedValueOnce({ rows });
}

type Row = {
  seq: string;
  ts: string;
  actor_user_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: unknown;
  after_state: unknown;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  prev_hash: string | null;
  entry_hash: string;
};

function buildChain(count: number): Row[] {
  const rows: Row[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= count; i++) {
    const ts = `2026-04-15T00:00:0${i}.000Z`;
    const hash = computeEntryHash(prev, {
      seq: i,
      ts,
      actor_user_id: "u1",
      actor_role: "cto",
      action: `a.${i}`,
      resource_type: "r",
      resource_id: null,
      before_state: null,
      after_state: { idx: i },
      ip_address: null,
      user_agent: null,
      request_id: null,
    });
    rows.push({
      seq: String(i),
      ts,
      actor_user_id: "u1",
      actor_role: "cto",
      action: `a.${i}`,
      resource_type: "r",
      resource_id: null,
      before_state: null,
      after_state: { idx: i },
      ip_address: null,
      user_agent: null,
      request_id: null,
      prev_hash: i === 1 ? null : prev,
      entry_hash: hash,
    });
    prev = hash;
  }
  return rows;
}

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
});

beforeEach(() => jest.clearAllMocks());

describe("verifyChain", () => {
  it("returns valid=true for a clean 5-row chain", async () => {
    const rows = buildChain(5);
    mockVerifyQueries([], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(5);
    expect(result.brokenAt).toBeUndefined();
  });

  it("returns brokenAt=N when row N's after_state is tampered", async () => {
    const rows = buildChain(5);
    // Tamper row 3: change after_state
    rows[2].after_state = { idx: 999 };
    mockVerifyQueries([], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it("returns brokenAt=N when row N's prev_hash is tampered", async () => {
    const rows = buildChain(5);
    // Tamper row 4's prev_hash
    rows[3].prev_hash = "0".repeat(64);
    mockVerifyQueries([], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.reason).toBe("prev_hash_mismatch");
  });

  it("returns valid=true for an empty table", async () => {
    mockVerifyQueries([], []);
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Segment-aware verification: re-anchored breaks are EXPECTED, not tamper.
// This is the seq-509 concurrency-fork scenario: a legitimate chain fork that
// an admin acknowledged via reanchorChain. verifyChain must pass ACROSS it while
// still catching any UNanchored break or any rewritten-content (entry_hash) row.
// ---------------------------------------------------------------------------

/**
 * Build a chain that FORKS at `forkSeq`: rows 1..forkSeq-1 chain cleanly, then
 * row forkSeq starts a brand-new segment off a fresh genesis (its prev_hash does
 * NOT match row forkSeq-1's entry_hash) and rows forkSeq..count chain cleanly
 * within that new segment. This simulates the seq-509 write-path fork.
 */
function buildForkedChain(count: number, forkSeq: number, segmentGenesis: string): Row[] {
  const rows: Row[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= count; i++) {
    if (i === forkSeq) prev = segmentGenesis; // new segment genesis
    const ts = `2026-04-15T00:00:0${i % 10}.000Z`;
    const hash = computeEntryHash(prev, {
      seq: i,
      ts,
      actor_user_id: "u1",
      actor_role: "cto",
      action: `a.${i}`,
      resource_type: "r",
      resource_id: null,
      before_state: null,
      after_state: { idx: i },
      ip_address: null,
      user_agent: null,
      request_id: null,
    });
    rows.push({
      seq: String(i),
      ts,
      actor_user_id: "u1",
      actor_role: "cto",
      action: `a.${i}`,
      resource_type: "r",
      resource_id: null,
      before_state: null,
      after_state: { idx: i },
      ip_address: null,
      user_agent: null,
      request_id: null,
      // row 1 genesis is null; the forked row stores its own (fresh) prev_hash.
      prev_hash: i === 1 ? null : prev,
      entry_hash: hash,
    });
    prev = hash;
  }
  return rows;
}

describe("verifyChain — segment-aware re-anchoring", () => {
  const SEGMENT_GENESIS = "f".repeat(64); // a fresh prev_hash for the new segment

  it("PASSES across an ACKNOWLEDGED break (anchored seq) — seq-509 case", async () => {
    const rows = buildForkedChain(6, 4, SEGMENT_GENESIS);
    // Without the anchor this is a prev_hash_mismatch at seq 4. WITH the anchor
    // at seq 4, verifyChain must treat seq 4 as a new segment genesis and pass.
    mockVerifyQueries([4], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(6);
    expect(result.honoredAnchors).toEqual([4]);
  });

  it("STILL FAILS on an UNacknowledged prev_hash mismatch (real tamper)", async () => {
    const rows = buildForkedChain(6, 4, SEGMENT_GENESIS);
    // No anchor recorded for seq 4 -> the break is unexplained -> must fail.
    mockVerifyQueries([], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.reason).toBe("prev_hash_mismatch");
  });

  it("STILL FAILS on a CONTENT (entry_hash) mismatch even AT an anchored seq", async () => {
    // An anchor excuses a chain break, NEVER a rewritten row. Tamper the content
    // of the anchored row itself; its own entry_hash no longer matches its
    // fields, so verification must fail at that seq.
    const rows = buildForkedChain(6, 4, SEGMENT_GENESIS);
    rows[3].after_state = { idx: 999 }; // tamper the anchored row's content
    mockVerifyQueries([4], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.reason).toBe("entry_hash_mismatch");
  });

  it("STILL FAILS on a CONTENT mismatch in a row AFTER an anchored break", async () => {
    const rows = buildForkedChain(6, 4, SEGMENT_GENESIS);
    rows[4].after_state = { idx: 777 }; // tamper seq 5, inside the new segment
    mockVerifyQueries([4], rows);
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(5);
    expect(result.reason).toBe("entry_hash_mismatch");
  });
});
