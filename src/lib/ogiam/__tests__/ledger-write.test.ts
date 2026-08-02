/**
 * recordDecision write-path tests. The pure hash primitive is covered in
 * ledger-hash.test.ts; this exercises the actual ledger write logic against a
 * mocked pg client: the no-database short circuit, the per-workspace sequence
 * and prev_hash chaining, the advisory lock + transaction, the analytics event
 * selection (authorized vs flagged), and rollback on failure.
 *
 * It does not need a real Postgres: we assert the SQL the writer issues and the
 * arguments it computes, which is where the chain logic lives.
 */

const mockConnect = jest.fn();
// activePool() is what the module actually calls; it closes over the
// module-internal pool, so the `pool` export alone is not enough.
jest.mock("@/lib/db", () => ({ pool: { connect: (...a: unknown[]) => mockConnect(...a) }, activePool: () => ({ connect: (...a: unknown[]) => mockConnect(...a) }) }));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { recordDecision, computeOgiamEntryHash, OGIAM_GENESIS_HASH } from "@/lib/ogiam/ledger";
import type { OgiamAction, OgiamDecision, OgiamPrincipal } from "@/lib/ogiam/types";

const principal: OgiamPrincipal = {
  kind: "ai_agent",
  agent: "instinct.assistant",
  onBehalfOfUserId: "user-1",
  onBehalfOfRole: "ceo",
  workspaceId: "ws-1",
};

function makeInput(over: { decision?: Partial<OgiamDecision>; action?: Partial<OgiamAction> } = {}) {
  const action: OgiamAction = {
    tool: "get_calendar",
    capability: "*",
    isMutation: false,
    surface: "/assistant",
    paramsHash: "ph",
    signals: {},
    ...over.action,
  };
  const decision: OgiamDecision = {
    intendedOutcome: "allow",
    effectiveOutcome: "monitor",
    enforced: false,
    mode: "monitor",
    riskTier: "low",
    policyVersion: "ogiam-test.1",
    ruleId: "R-DEFAULT-ALLOW",
    reason: "ok",
    wouldBlock: false,
    ...over.decision,
  };
  return { principal, action, decision, redactedParams: "{}" };
}

/** Build a fake client that answers each query() by SQL keyword. `prevRow`
 *  is what the prev-row SELECT returns (null = genesis). Records all INSERTs. */
function fakeClient(prevRow: { seq: string; entry_hash: string } | null) {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const calls: string[] = [];
  const client = {
    inserts,
    calls,
    release: jest.fn(),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (/^\s*SELECT seq, entry_hash/i.test(sql)) {
        return { rows: prevRow ? [prevRow] : [] };
      }
      if (/^\s*INSERT INTO ogiam_decisions/i.test(sql)) {
        inserts.push({ sql, params: params ?? [] });
        return { rows: [{ id: "dec-1" }] };
      }
      return { rows: [] };
    }),
  };
  return client;
}

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockConnect.mockReset();
  mockTrackEvent.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("recordDecision: no database", () => {
  it("short-circuits without connecting when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const out = await recordDecision(makeInput());
    expect(out).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe("recordDecision: first entry (genesis)", () => {
  it("opens a transaction, takes the advisory lock, and inserts seq 1 chained to genesis", async () => {
    const client = fakeClient(null);
    mockConnect.mockResolvedValue(client);

    const out = await recordDecision(makeInput());

    // Transaction + per-workspace advisory lock + commit, then release.
    expect(client.calls).toEqual(
      expect.arrayContaining(["BEGIN", "SELECT seq,", "INSERT INTO", "COMMIT"]),
    );
    expect(
      client.query.mock.calls.some(
        (c) => /pg_advisory_xact_lock/.test(c[0]) && Array.isArray(c[1]) && String(c[1][0]).includes("ws-1"),
      ),
    ).toBe(true);
    expect(client.release).toHaveBeenCalled();

    // The inserted row is seq 1, prev_hash = genesis, entry_hash = chained hash.
    const params = client.inserts[0].params;
    const seq = params[1];
    const prevHash = params[23];
    const entryHash = params[24];
    expect(seq).toBe(1);
    expect(prevHash).toBe(OGIAM_GENESIS_HASH);
    expect(typeof entryHash).toBe("string");
    expect(entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toEqual({ id: "dec-1", seq: 1, entryHash });
  });
});

describe("recordDecision: chaining", () => {
  it("uses the prior row's entry_hash as prev_hash and increments seq", async () => {
    const priorHash = "a".repeat(64);
    const client = fakeClient({ seq: "7", entry_hash: priorHash });
    mockConnect.mockResolvedValue(client);

    const out = await recordDecision(makeInput());

    const params = client.inserts[0].params;
    expect(params[1]).toBe(8); // seq incremented
    expect(params[23]).toBe(priorHash); // prev_hash = prior entry_hash
    // entry_hash actually chains off the prior hash (not genesis).
    const genesisChained = computeOgiamEntryHash(OGIAM_GENESIS_HASH, { x: 1 });
    expect(params[24]).not.toBe(genesisChained);
    expect(out?.seq).toBe(8);
  });
});

describe("recordDecision: analytics", () => {
  it("emits action_authorized for an allow, action_flagged when it would block", async () => {
    mockConnect.mockResolvedValue(fakeClient(null));
    await recordDecision(makeInput({ decision: { wouldBlock: false } }));
    expect(mockTrackEvent.mock.calls[0][0]).toBe("ogiam.action_authorized");

    mockTrackEvent.mockReset();
    mockConnect.mockResolvedValue(fakeClient(null));
    await recordDecision(
      makeInput({ decision: { wouldBlock: true, intendedOutcome: "escalate" } }),
    );
    expect(mockTrackEvent.mock.calls[0][0]).toBe("ogiam.action_flagged");
  });
});

describe("recordDecision: failure handling", () => {
  it("rolls back, releases the client, and returns null when the insert throws", async () => {
    const client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        if (/^\s*INSERT INTO ogiam_decisions/i.test(sql)) throw new Error("boom");
        if (/^\s*SELECT seq, entry_hash/i.test(sql)) return { rows: [] };
        return { rows: [] };
      }),
    };
    mockConnect.mockResolvedValue(client);

    const out = await recordDecision(makeInput());

    expect(out).toBeNull();
    expect(client.query.mock.calls.some((c) => /ROLLBACK/.test(c[0]))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});
