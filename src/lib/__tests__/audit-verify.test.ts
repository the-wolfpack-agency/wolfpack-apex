/**
 * audit-verify.test.ts — verifyChain returns valid=true for clean chains,
 * pinpoints the broken seq when a middle row is tampered.
 *
 * We bypass the public API: simulate rows directly via mock, including
 * a tampered row.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
    mockQuery.mockResolvedValueOnce({ rows });
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(5);
    expect(result.brokenAt).toBeUndefined();
  });

  it("returns brokenAt=N when row N's after_state is tampered", async () => {
    const rows = buildChain(5);
    // Tamper row 3: change after_state
    rows[2].after_state = { idx: 999 };
    mockQuery.mockResolvedValueOnce({ rows });
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it("returns brokenAt=N when row N's prev_hash is tampered", async () => {
    const rows = buildChain(5);
    // Tamper row 4's prev_hash
    rows[3].prev_hash = "0".repeat(64);
    mockQuery.mockResolvedValueOnce({ rows });
    const result = await verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.reason).toBe("prev_hash_mismatch");
  });

  it("returns valid=true for an empty table", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await verifyChain();
    expect(result.valid).toBe(true);
    expect(result.checkedCount).toBe(0);
  });
});
