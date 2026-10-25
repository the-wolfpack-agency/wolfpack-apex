/** @jest-environment node */
import {
  getBlockedFingerprints,
  captureBlockedFingerprints,
  clearBlockedFingerprints,
  autoBlockOperator,
  autoBlockFingerprint,
  gateAutoBlock,
  planOperatorAutoBlock,
  isBlockActive,
  AUTO_BLOCK_MAX_FINGERPRINTS,
  AUTO_BLOCK_TTL_DAYS,
  type FingerprintEvidence,
} from "@/lib/forcefield/blocked-fingerprints";

const mockQuery = jest.fn();
const mockListBlocked = jest.fn();
const mockPolicy = jest.fn();
const mockTrack = jest.fn();
const mockTrackAwait = jest.fn(async () => {});
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/agent-operators", () => ({ listBlockedOperatorKeys: (...a: unknown[]) => mockListBlocked(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => mockPolicy(...a) }));
const mockDispatch = jest.fn(async () => null);
jest.mock("@/lib/forcefield-web/alerts", () => ({
  ...jest.requireActual("@/lib/forcefield-web/alerts"),
  dispatchForcefieldAlert: (...a: unknown[]) => mockDispatch(...(a as [])),
  liveForcefieldAlertDeps: () => ({}),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
  trackEventAwait: (...a: unknown[]) => mockTrackAwait(...(a as [])),
}));

const ENFORCE = { mode: "enforce", autoBlock: true };
const ORIG = process.env.DATABASE_URL;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://x";
  mockPolicy.mockResolvedValue(ENFORCE);
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIG;
});

const NOW = new Date("2026-10-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const ev = (fp: string, d: number, proven = false): FingerprintEvidence => ({ fp, lastSeen: daysAgo(d), proven });

describe("getBlockedFingerprints", () => {
  it("returns ONLY the fingerprints whose operator is still blocked", async () => {
    mockListBlocked.mockResolvedValue(new Set(["op_blocked"]));
    mockQuery.mockResolvedValue({
      rows: [
        { fp: "aaaa", operator_key: "op_blocked", expires_at: null },
        { fp: "bbbb", operator_key: "op_blocked", expires_at: null },
        { fp: "cccc", operator_key: "op_stale", expires_at: null },
      ],
    });
    expect((await getBlockedFingerprints("default", NOW)).sort()).toEqual(["aaaa", "bbbb"]);
  });

  it("the SQL filters expired rows (expires_at IS NULL OR expires_at > now())", async () => {
    mockListBlocked.mockResolvedValue(new Set());
    mockQuery.mockResolvedValue({ rows: [] });
    await getBlockedFingerprints("default");
    expect(mockQuery.mock.calls[0][0]).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
  });

  it("EXPIRY STOPS ENFORCEMENT: an expired automatic row is not served, an unexpired one is", async () => {
    mockListBlocked.mockResolvedValue(new Set());
    mockQuery.mockResolvedValue({
      rows: [
        { fp: "aaaa0001:sqlmap", operator_key: "auto:honeytoken", expires_at: daysAgo(-3) },
        { fp: "aaaa0002:sqlmap", operator_key: "auto:honeytoken", expires_at: daysAgo(1) },
      ],
    });
    expect(await getBlockedFingerprints("default", NOW)).toEqual(["aaaa0001:sqlmap"]);
  });

  it("ADMIN BLOCKS PERSIST: an admin row with no expiry enforces however old it is", async () => {
    mockListBlocked.mockResolvedValue(new Set(["op_admin"]));
    mockQuery.mockResolvedValue({ rows: [{ fp: "old", operator_key: "op_admin", expires_at: null }] });
    expect(await getBlockedFingerprints("default", new Date("2030-01-01T00:00:00Z"))).toEqual(["old"]);
  });

  it("automatic rows are withdrawn when the edge policy turns auto-block off", async () => {
    mockListBlocked.mockResolvedValue(new Set(["op_admin"]));
    mockPolicy.mockResolvedValue({ mode: "enforce", autoBlock: false });
    mockQuery.mockResolvedValue({
      rows: [
        { fp: "aaaa0003:sqlmap", operator_key: "auto:honeytoken", expires_at: daysAgo(-3) },
        { fp: "adm", operator_key: "op_admin", expires_at: null },
      ],
    });
    expect(await getBlockedFingerprints("default", NOW)).toEqual(["adm"]);
  });

  it("fail-safe: returns empty on a DB error (never serves a wrong block list)", async () => {
    mockQuery.mockResolvedValue({ rows: [{ fp: "a", operator_key: "op", expires_at: null }] });
    mockListBlocked.mockRejectedValue(new Error("db down"));
    expect(await getBlockedFingerprints("default")).toEqual([]);
  });

  it("returns empty without a database configured", async () => {
    delete process.env.DATABASE_URL;
    expect(await getBlockedFingerprints("default")).toEqual([]);
  });
});

describe("isBlockActive", () => {
  it("no expiry = active forever; past expiry = inactive", () => {
    expect(isBlockActive(null, NOW)).toBe(true);
    expect(isBlockActive(daysAgo(-1), NOW)).toBe(true);
    expect(isBlockActive(daysAgo(0), NOW)).toBe(false);
  });
});

describe("planOperatorAutoBlock (cap + expiry)", () => {
  it("each row expires TTL days after that fingerprint was last seen", () => {
    const p = planOperatorAutoBlock([ev("a", 2)], { now: NOW });
    expect(p.rows).toEqual([{ fp: "a", expiresAt: new Date(new Date(daysAgo(2)).getTime() + AUTO_BLOCK_TTL_DAYS * 86_400_000).toISOString() }]);
    expect(p.capped).toBe(false);
  });

  it("drops a fingerprint not seen within the TTL (it would arrive expired)", () => {
    const p = planOperatorAutoBlock([ev("fresh", 1), ev("stale", AUTO_BLOCK_TTL_DAYS + 1)], { now: NOW });
    expect(p.rows.map((r) => r.fp)).toEqual(["fresh"]);
    expect(p.stale).toBe(1);
  });

  it("THE CAP APPLIES: over the cap only fingerprints that carried proof are kept", () => {
    const many = Array.from({ length: 101 }, (_, i) => ev(`fp${i}`, 1, i < 3));
    const p = planOperatorAutoBlock(many, { now: NOW });
    expect(p.capped).toBe(true);
    expect(p.resolved).toBe(101);
    expect(p.rows.map((r) => r.fp)).toEqual(["fp0", "fp1", "fp2"]);
  });

  it("at or under the cap every fresh fingerprint is kept", () => {
    const n = Array.from({ length: AUTO_BLOCK_MAX_FINGERPRINTS }, (_, i) => ev(`fp${i}`, 1));
    const p = planOperatorAutoBlock(n, { now: NOW });
    expect(p.capped).toBe(false);
    expect(p.rows).toHaveLength(AUTO_BLOCK_MAX_FINGERPRINTS);
  });
});

describe("gateAutoBlock (edge policy + qualifiesForAutoBlock)", () => {
  it("PROVEN-ONLY: refuses an unproven (inferred) operator even when hostile, and records why", async () => {
    const g = await gateAutoBlock({ workspaceId: "w", proven: false, trustBand: "hostile", reason: "auto:learned:x" });
    expect(g.allowed).toBe(false);
    expect(g.why).toMatch(/Inferred/);
    expect(mockTrack).toHaveBeenCalledWith("forcefield.autoblock_skipped", "system", "forcefield", expect.objectContaining({ proven: false }));
  });

  it("refuses an elevated (untrusted) operator even when proven", async () => {
    expect((await gateAutoBlock({ workspaceId: "w", proven: true, trustBand: "untrusted", reason: "r" })).allowed).toBe(false);
  });

  it("refuses everything when the edge policy is monitor or auto_block is off", async () => {
    mockPolicy.mockResolvedValueOnce({ mode: "monitor", autoBlock: true });
    expect((await gateAutoBlock({ workspaceId: "w", proven: true, trustBand: "hostile", reason: "r" })).allowed).toBe(false);
    mockPolicy.mockResolvedValueOnce({ mode: "enforce", autoBlock: false });
    expect((await gateAutoBlock({ workspaceId: "w", proven: true, trustBand: "hostile", reason: "r" })).allowed).toBe(false);
  });

  it("fails closed when the policy read throws", async () => {
    mockPolicy.mockRejectedValueOnce(new Error("db"));
    expect((await gateAutoBlock({ workspaceId: "w", proven: true, trustBand: "hostile", reason: "r" })).allowed).toBe(false);
  });

  it("allows a proven-hostile operator under enforce + auto_block", async () => {
    expect((await gateAutoBlock({ workspaceId: "w", proven: true, trustBand: "hostile", reason: "r" })).allowed).toBe(true);
  });
});

/** Feed resolveOperatorEvidence: event rows for one journey key with fp. */
function eventRows(n: number, provenCount: number) {
  return Array.from({ length: n }, (_, i) => ({
    event_type: i < provenCount ? "site.agent_trap_tripped" : "site.agent_flagged",
    path: "/x", created_at: new Date().toISOString(), sig: `sig${i}`, nonce: null, fp: `fp${i}:sqlmap`,
    agent: null, attack: null, tool: null, client_type: "script",
  }));
}

describe("autoBlockOperator", () => {
  it("returns 0 without a database (no throw)", async () => {
    delete process.env.DATABASE_URL;
    expect(await autoBlockOperator("op_x", "learned:abcd1234", { proven: true, trustBand: "hostile" })).toBe(0);
  });

  it("never writes when the gate refuses (unproven)", async () => {
    expect(await autoBlockOperator("op_x", "learned:abcd1234", { proven: false, trustBand: "hostile" })).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("is a no-op (0) when the operator resolves to no fingerprints", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await autoBlockOperator("op_x", "learned:abcd1234", { proven: true, trustBand: "hostile" })).toBe(0);
  });

  it("COUNTING FIX: returns rows INSERTED, not fingerprints resolved (a re-run adds 0)", async () => {
    // We cannot easily predict buildJourneys' operator key, so resolve via the
    // real pipeline and then assert on the write's RETURNING rows.
    const rows = eventRows(3, 3);
    const { buildJourneys } = jest.requireActual("@/lib/agent-behavior");
    const { buildAgentProfile } = jest.requireActual("@/lib/agent-profile");
    const journeys = buildJourneys(rows.map((r) => ({ key: r.sig, keyKind: "fingerprint", type: r.event_type, path: r.path, at: r.created_at, nonceLinked: false, clientType: r.client_type })));
    const opKey = buildAgentProfile(journeys[0]).operatorKey;
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ inserted: false }, { inserted: false }] }); // all existed: refreshed only
    const n = await autoBlockOperator(opKey, "learned:abcd1234", { proven: true, trustBand: "hostile" });
    expect(n).toBe(0);
    expect(mockTrack).not.toHaveBeenCalledWith("forcefield.fingerprint_autoblocked", expect.anything(), expect.anything(), expect.anything());
    const write = mockQuery.mock.calls[1];
    expect(write[0]).toMatch(/expires_at/);
    expect(write[0]).toMatch(/RETURNING \(xmax = 0\) AS inserted/);
  });

  it("records forcefield.autoblock_capped and writes only proven fingerprints over the cap", async () => {
    const rows = eventRows(AUTO_BLOCK_MAX_FINGERPRINTS + 10, 2);
    // Every row shares one journey key so they resolve to ONE operator.
    for (const r of rows) r.sig = "shared";
    const { buildJourneys } = jest.requireActual("@/lib/agent-behavior");
    const { buildAgentProfile } = jest.requireActual("@/lib/agent-profile");
    const journeys = buildJourneys(rows.map((r) => ({ key: r.sig, keyKind: "fingerprint", type: r.event_type, path: r.path, at: r.created_at, nonceLinked: false, clientType: r.client_type })));
    const opKey = buildAgentProfile(journeys[0]).operatorKey;
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ inserted: true }, { inserted: true }] });
    const n = await autoBlockOperator(opKey, "learned:abcd1234", { proven: true, trustBand: "hostile" });
    expect(n).toBe(2);
    expect(mockTrackAwait).toHaveBeenCalledWith("forcefield.autoblock_capped", "system", "forcefield", expect.objectContaining({ resolved: AUTO_BLOCK_MAX_FINGERPRINTS + 10, proven: 2, cap: AUTO_BLOCK_MAX_FINGERPRINTS }));
    const fpsWritten = mockQuery.mock.calls[1][1][2];
    expect(fpsWritten.sort()).toEqual(["fp0:sqlmap", "fp1:sqlmap"]);
  });
});

describe("autoBlockFingerprint (honeytoken)", () => {
  it("writes with an expiry and returns rows inserted", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ inserted: true }] });
    expect(await autoBlockFingerprint("ab12cd34:sqlmap", "honeytoken")).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/expires_at/);
    expect(params[1]).toBe("auto:honeytoken");
    expect(params[3][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is refused by the edge policy when auto-block is off", async () => {
    mockPolicy.mockResolvedValueOnce({ mode: "monitor", autoBlock: false });
    expect(await autoBlockFingerprint("ab12cd34:sqlmap", "honeytoken")).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("captureBlockedFingerprints (admin)", () => {
  it("is a no-op (0) when no events map to the operator", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await captureBlockedFingerprints("default", "op_x")).toBe(0);
  });

  it("returns 0 without a database (no throw)", async () => {
    delete process.env.DATABASE_URL;
    expect(await captureBlockedFingerprints("default", "op_x")).toBe(0);
  });
});

describe("clearBlockedFingerprints", () => {
  it("deletes the operator's rows", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await clearBlockedFingerprints("default", "op_x");
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM instinct_agent_blocked_fingerprints"), ["default", "op_x"]);
  });
});
