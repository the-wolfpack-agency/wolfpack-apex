/** @jest-environment node */
/**
 * Automatic blocks must target the attacker, not every user of a common tool.
 * Incident 2026-10-25: one honeytoken replay from one machine wrote an automatic
 * block on `1c168f78:curl`, and the ruleset then 403'd every default curl client
 * on every connected site. These tests pin the fix end to end: the scope rule,
 * the write path, the read (ruleset) path, and the edge decision.
 */
import {
  classifyAutoBlockScope,
  isStaticallyGeneric,
  splitFingerprint,
  staticFingerprintScope,
  attackToolKinds,
  GENERIC_MIN_COUNTRIES,
  GENERIC_MIN_KINDS,
} from "@/lib/forcefield/autoblock-scope";
import {
  autoBlockFingerprint,
  autoBlockOperator,
  getBlockedFingerprints,
  loadHeaderShapeSpread,
  AUTO_BLOCK_MAX_FINGERPRINTS,
} from "@/lib/forcefield/blocked-fingerprints";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import { operatorFingerprint } from "@/lib/forcefield-web/fingerprint";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const mockQuery = jest.fn();
const mockListBlocked = jest.fn();
const mockPolicy = jest.fn();
const mockTrack = jest.fn();
const mockTrackAwait = jest.fn(async () => {});
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/agent-operators", () => ({ listBlockedOperatorKeys: (...a: unknown[]) => mockListBlocked(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => mockPolicy(...a) }));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
  trackEventAwait: (...a: unknown[]) => mockTrackAwait(...(a as [])),
}));
const mockDispatch = jest.fn(async () => null);
jest.mock("@/lib/forcefield-web/alerts", () => ({
  ...jest.requireActual("@/lib/forcefield-web/alerts"),
  dispatchForcefieldAlert: (...a: unknown[]) => mockDispatch(...(a as [])),
  liveForcefieldAlertDeps: () => ({}),
}));

// Default curl's header shape, as the edge computes it.
const CURL_HEADERS = ["host", "user-agent", "accept"];
const CURL_FP = operatorFingerprint(CURL_HEADERS, "curl");
const SQLMAP_FP = operatorFingerprint(["host", "user-agent", "accept-encoding", "x-sqlmap"], "sqlmap");
const RARE_UNKNOWN_FP = "5eed89ba:unknown";

const ENFORCE = { mode: "enforce", autoBlock: true };
const ORIG = process.env.DATABASE_URL;
const NOW = new Date("2026-10-25T15:00:00Z");
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://x";
  mockPolicy.mockResolvedValue(ENFORCE);
  mockListBlocked.mockResolvedValue(new Set());
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIG;
});

const insertCalls = () => mockQuery.mock.calls.filter((c) => /INSERT INTO instinct_agent_blocked_fingerprints/.test(String(c[0])));
const withheldEvents = () => (mockTrackAwait.mock.calls as unknown as unknown[][]).filter((c) => c[0] === "forcefield.autoblock_withheld_generic");

/** A request from some client, from an IP the edge sees. */
const req = (userAgent: string, headerNames: string[], ip: string) => ({ path: "/", method: "GET", userAgent, headerNames, ip });

describe("scope rule (pure)", () => {
  it("the incident fingerprint is generic: default curl is shared by unrelated users", () => {
    expect(CURL_FP).toMatch(/^[0-9a-f]{8}:curl$/);
    expect(staticFingerprintScope(CURL_FP)).toEqual({ verdict: "generic", why: "common_client_kind", kind: "curl" });
    expect(isStaticallyGeneric("1c168f78:curl")).toBe(true);
  });

  it.each(["python-requests", "go-http-client", "node-fetch", "headlesschrome", "playwright", "known_crawler", "browser", "scripted_library", "headless", "some-new-tool"])(
    "%s is generic (a common client, or an unrecognized name: fail toward not blocking)",
    (kind) => expect(isStaticallyGeneric(`abcd1234:${kind}`)).toBe(true),
  );

  it("a legacy header-only fingerprint (no kind) is generic", () => {
    expect(staticFingerprintScope("1c168f78")).toMatchObject({ verdict: "generic", why: "legacy_no_kind" });
  });

  it("a named attack tool is distinctive", () => {
    for (const k of attackToolKinds()) expect(staticFingerprintScope(`abcd1234:${k}`)?.verdict).toBe("distinctive");
    expect(staticFingerprintScope(SQLMAP_FP)).toMatchObject({ verdict: "distinctive", why: "named_attack_tool" });
  });

  it("'unknown' needs data: rare shape distinctive, shared or widely spread shape generic, no data generic", () => {
    expect(staticFingerprintScope(RARE_UNKNOWN_FP)).toBeNull();
    expect(classifyAutoBlockScope(RARE_UNKNOWN_FP, { kinds: 1, countries: 1 })).toMatchObject({ verdict: "distinctive", why: "rare_header_shape" });
    expect(classifyAutoBlockScope(RARE_UNKNOWN_FP, { kinds: GENERIC_MIN_KINDS, countries: 1 })).toMatchObject({ verdict: "generic", why: "shared_header_shape" });
    expect(classifyAutoBlockScope(RARE_UNKNOWN_FP, { kinds: 1, countries: GENERIC_MIN_COUNTRIES })).toMatchObject({ verdict: "generic", why: "wide_country_spread" });
    expect(classifyAutoBlockScope(RARE_UNKNOWN_FP, null)).toMatchObject({ verdict: "generic", why: "spread_unavailable" });
    expect(isStaticallyGeneric(RARE_UNKNOWN_FP)).toBe(false);
  });

  it("splitFingerprint", () => {
    expect(splitFingerprint("1C168F78:Curl")).toEqual({ shape: "1c168f78", kind: "curl" });
    expect(splitFingerprint("1c168f78")).toEqual({ shape: "1c168f78", kind: "" });
  });
});

describe("write path: autoBlockFingerprint (honeytoken)", () => {
  it("a generic curl fingerprint is WITHHELD: no row and a durable event, but NO alert of its own", async () => {
    const alert = jest.fn(async () => null);
    expect(await autoBlockFingerprint(CURL_FP, "honeytoken", { alert })).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(withheldEvents()).toHaveLength(1);
    expect(withheldEvents()[0]).toEqual(["forcefield.autoblock_withheld_generic", "system", "forcefield", expect.objectContaining({ reason: "auto:honeytoken", withheld: 1, fps: CURL_FP, why: "common_client_kind" })]);
    // One email per incident: the trap trip is already an incident, and its
    // email reads this durable event back (alerts.ts lookupBlockDecision).
    expect(alert).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalledWith("forcefield.fingerprint_autoblocked", expect.anything(), expect.anything(), expect.anything());
  });

  it("the default path dispatches nothing either (no second email for one trap trip)", async () => {
    await autoBlockFingerprint(CURL_FP, "honeytoken");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("a distinctive attack-tool fingerprint STILL auto-blocks fingerprint-wide, with an expiry", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ inserted: true }] });
    const loadSpread = jest.fn();
    expect(await autoBlockFingerprint(SQLMAP_FP, "honeytoken", { loadSpread })).toBe(1);
    expect(loadSpread).not.toHaveBeenCalled(); // static verdict, no data read
    const [, params] = insertCalls()[0];
    expect(params[2]).toEqual([SQLMAP_FP]);
    expect(params[3][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(withheldEvents()).toHaveLength(0);
  });

  it("an 'unknown' fingerprint with a rare header shape auto-blocks; a shared shape is withheld", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ inserted: true }] });
    expect(await autoBlockFingerprint(RARE_UNKNOWN_FP, "honeytoken", { loadSpread: async () => ({ kinds: 1, countries: 1 }), alert: async () => null })).toBe(1);
    jest.clearAllMocks();
    mockPolicy.mockResolvedValue(ENFORCE);
    expect(await autoBlockFingerprint(RARE_UNKNOWN_FP, "honeytoken", { loadSpread: async () => ({ kinds: 4, countries: 8 }), alert: async () => null })).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(withheldEvents()[0][3]).toMatchObject({ why: "shared_header_shape" });
  });

  it("the safe-blocking gate still runs first: auto_block off writes nothing and raises no withheld alert", async () => {
    mockPolicy.mockResolvedValueOnce({ mode: "enforce", autoBlock: false });
    const alert = jest.fn();
    expect(await autoBlockFingerprint(SQLMAP_FP, "honeytoken", { alert })).toBe(0);
    expect(await autoBlockFingerprint(CURL_FP, "honeytoken", { alert })).toBe(0);
    expect(insertCalls()).toHaveLength(0);
  });
});

describe("loadHeaderShapeSpread (read-only data)", () => {
  it("queries the fp prefix range and maps counts", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ kinds: "4", countries: "8" }] });
    expect(await loadHeaderShapeSpread("1c168f78")).toEqual({ kinds: 4, countries: 8 });
    expect(mockQuery.mock.calls[0][0]).toMatch(/^\s*SELECT/);
    expect(mockQuery.mock.calls[0][1]).toEqual(["30", "1c168f78:%"]);
  });

  it("null on a DB error or a malformed shape (the rule treats null as generic)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db"));
    expect(await loadHeaderShapeSpread("1c168f78")).toBeNull();
    expect(await loadHeaderShapeSpread("x%' OR 1=1")).toBeNull();
  });
});

/** Event rows that resolve to ONE operator (shared journey key). */
function eventRows(fps: string[], provenCount: number) {
  return fps.map((fp, i) => ({
    event_type: i < provenCount ? "site.agent_trap_tripped" : "site.agent_flagged",
    path: "/x", created_at: new Date().toISOString(), sig: "shared", nonce: null, fp,
    agent: null, attack: null, tool: null, client_type: "script",
  }));
}
function opKeyFor(rows: ReturnType<typeof eventRows>): string {
  const { buildJourneys } = jest.requireActual("@/lib/agent-behavior");
  const { buildAgentProfile } = jest.requireActual("@/lib/agent-profile");
  const journeys = buildJourneys(rows.map((r) => ({ key: r.sig, keyKind: "fingerprint", type: r.event_type, path: r.path, at: r.created_at, nonceLinked: false, clientType: r.client_type })));
  return buildAgentProfile(journeys[0]).operatorKey;
}

describe("write path: autoBlockOperator (learned signature)", () => {
  it("writes only the distinctive fingerprints and withholds the generic ones", async () => {
    const rows = eventRows([SQLMAP_FP, CURL_FP, "62e0d866:python-requests"], 3);
    mockQuery.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [{ inserted: true }] });
    const alert = jest.fn(async () => null);
    const n = await autoBlockOperator(opKeyFor(rows), "learned:abcd1234", { proven: true, trustBand: "hostile" }, { alert });
    expect(n).toBe(1);
    expect(insertCalls()[0][1][2]).toEqual([SQLMAP_FP]);
    expect(withheldEvents()[0][3]).toMatchObject({ withheld: 2, reason: "auto:learned:abcd1234" });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("THE CAP STILL APPLIES before scope: over the cap only proven fingerprints survive, then generic ones are withheld", async () => {
    const fps = Array.from({ length: AUTO_BLOCK_MAX_FINGERPRINTS + 5 }, (_, i) => (i === 1 ? CURL_FP : `${i.toString(16).padStart(8, "0")}:nikto`));
    const rows = eventRows(fps, 3); // fps[0..2] proven; fps[1] is generic curl
    mockQuery.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [{ inserted: true }, { inserted: true }] });
    const n = await autoBlockOperator(opKeyFor(rows), "learned:abcd1234", { proven: true, trustBand: "hostile" }, { alert: async () => null });
    expect(n).toBe(2);
    expect(mockTrackAwait).toHaveBeenCalledWith("forcefield.autoblock_capped", "system", "forcefield", expect.objectContaining({ proven: 3 }));
    expect(insertCalls()[0][1][2].sort()).toEqual([fps[0], fps[2]].sort());
  });
});

describe("read path: the ruleset no longer distributes a generic automatic block", () => {
  it("the existing 1c168f78:curl auto row is filtered out; it is not deleted or altered", async () => {
    mockQuery.mockResolvedValue({ rows: [{ fp: "1c168f78:curl", operator_key: "auto:honeytoken", expires_at: daysAhead(14) }] });
    expect(await getBlockedFingerprints("default", NOW)).toEqual([]);
    for (const [sql] of mockQuery.mock.calls) expect(String(sql)).not.toMatch(/DELETE|UPDATE|INSERT/);
  });

  it("generic auto rows are dropped, distinctive auto rows and ADMIN tool-wide rows are served", async () => {
    mockListBlocked.mockResolvedValue(new Set(["op_admin"]));
    mockQuery.mockResolvedValue({
      rows: [
        { fp: CURL_FP, operator_key: "auto:honeytoken", expires_at: daysAhead(10) },
        { fp: "62e0d866:python-requests", operator_key: "auto:learned:x", expires_at: daysAhead(10) },
        { fp: "1c168f78", operator_key: "auto:learned:x", expires_at: daysAhead(10) },
        { fp: SQLMAP_FP, operator_key: "auto:honeytoken", expires_at: daysAhead(10) },
        { fp: RARE_UNKNOWN_FP, operator_key: "auto:learned:x", expires_at: daysAhead(10) },
        { fp: "9d89fd0b:curl", operator_key: "op_admin", expires_at: null },
      ],
    });
    expect((await getBlockedFingerprints("default", NOW)).sort()).toEqual([SQLMAP_FP, RARE_UNKNOWN_FP, "9d89fd0b:curl"].sort());
  });

  it("EXPIRY STILL APPLIES to a distinctive auto row", async () => {
    mockQuery.mockResolvedValue({ rows: [{ fp: SQLMAP_FP, operator_key: "auto:honeytoken", expires_at: daysAhead(-1) }] });
    expect(await getBlockedFingerprints("default", NOW)).toEqual([]);
  });
});

describe("edge decision on the served list", () => {
  const ruleset = { ...DEFAULT_RULESET };

  it("a generic curl auto-block does not block a curl client on a DIFFERENT network", async () => {
    mockQuery.mockResolvedValue({ rows: [{ fp: CURL_FP, operator_key: "auto:honeytoken", expires_at: daysAhead(14) }] });
    const blockedFingerprints = await getBlockedFingerprints("default", NOW);
    const d = decideEnforcement(req("curl/8.7.1", CURL_HEADERS, "203.0.113.7"), ruleset, { blockedFingerprints });
    expect(d.block).toBe(false);
  });

  it("an ADMIN tool-wide block on the same curl fingerprint still blocks every network", async () => {
    mockListBlocked.mockResolvedValue(new Set(["op_admin"]));
    mockQuery.mockResolvedValue({ rows: [{ fp: CURL_FP, operator_key: "op_admin", expires_at: null }] });
    const blockedFingerprints = await getBlockedFingerprints("default", NOW);
    for (const ip of ["203.0.113.7", "198.51.100.9"]) {
      const d = decideEnforcement(req("curl/8.7.1", CURL_HEADERS, ip), ruleset, { blockedFingerprints });
      expect(d).toMatchObject({ block: true, reasonKind: "blocked_fingerprint" });
    }
  });

  it("a distinctive auto-blocked fingerprint still blocks at the edge", async () => {
    const headers = ["host", "user-agent", "x-custom-probe"];
    const fp = operatorFingerprint(headers, undefined, "unknown");
    mockQuery.mockResolvedValue({ rows: [{ fp, operator_key: "auto:learned:x", expires_at: daysAhead(5) }] });
    const blockedFingerprints = await getBlockedFingerprints("default", NOW);
    expect(decideEnforcement(req("probe-kit", headers, "203.0.113.7"), ruleset, { blockedFingerprints })).toMatchObject({ block: true, reasonKind: "blocked_fingerprint" });
  });
});
