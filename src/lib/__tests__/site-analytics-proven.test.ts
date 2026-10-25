/**
 * Proven attacks per site: shaping, the control-plane false-positive exclusion,
 * the fingerprint-not-recorded distinction, and the failed-read state. DB mocked.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: jest.fn(async () => ({ rows: [] })),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { getProvenAttacks, CONTROL_PLANE_FP_ROW, NOT_CONTROL_PLANE_FP, PROVEN_EVENT_TYPES } from "@/lib/site-analytics-proven";
import { FORCEFIELD_CONTROL_PLANE_PATHS } from "@/lib/forcefield-web/enforce";
import { getSiteAnalyticsSummary, SITE_EVENT_TYPES } from "@/lib/site-analytics";

const SINCE = `created_at > now() - ($1 || ' days')::interval`;

function route(map: Record<string, unknown[] | "fail">) {
  mockSafeQuery.mockImplementation((sql: string) => {
    for (const [needle, rows] of Object.entries(map)) {
      if (String(sql).includes(needle)) return Promise.resolve(rows === "fail" ? { rows: [], fromCache: true } : { rows, fromCache: false });
    }
    return Promise.resolve({ rows: [], fromCache: false });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});

describe("control-plane false positive", () => {
  it("reuses the engine's own exemption list, and only for nextjs_middleware_bypass", () => {
    for (const p of Array.from(FORCEFIELD_CONTROL_PLANE_PATHS)) expect(CONTROL_PLANE_FP_ROW).toContain(`'${p}'`);
    expect(CONTROL_PLANE_FP_ROW).toContain("props->>'attack' = 'nextjs_middleware_bypass'");
    // a row with no attack prop must survive the NOT (NULL-safe)
    expect(NOT_CONTROL_PLANE_FP).toMatch(/NOT coalesce\(.*, false\)/);
  });

  it("every proven type is a real site event type", () => {
    for (const t of PROVEN_EVENT_TYPES) expect(SITE_EVENT_TYPES).toContain(t);
  });

  it("is excluded from the proven counts and from every attack count on the board", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await getSiteAnalyticsSummary(30);
    const sqls = mockSafeQuery.mock.calls.map(([sql]) => String(sql));
    const mustExclude = [
      (s: string) => s.includes("IN ('site.agent_payload_attack','site.agent_trap_tripped')"), // proven
      (s: string) => s.includes("event_type = 'site.agent_payload_attack'") && s.includes("coalesce(props->>'attack', 'unknown')"), // payloadIntel
      (s: string) => s.includes("AS hostile_operators"), // forcefield totals (blocked / hostile)
      (s: string) => s.includes("props->>'reason_kind'"), // defense enforcement
      (s: string) => s.includes("SELECT event_type, count(*) AS count"), // byType
    ];
    for (const pick of mustExclude) {
      const matching = sqls.filter(pick);
      expect(matching.length).toBeGreaterThan(0);
      for (const s of matching) expect(s).toContain(NOT_CONTROL_PLANE_FP);
    }
  });
});

describe("getProvenAttacks", () => {
  it("shapes per-site blocked vs report-only by class, sorted by blocked volume", async () => {
    route({
      "GROUP BY 1, 2, 3, 4": [
        { site: "ogiam.com", mode: "blocked", event_type: "site.agent_payload_attack", attack: "path_traversal", count: "76", fingerprints: "12", without_fp: "0", last_seen: "2026-10-23T10:00:00Z" },
        { site: "ogiam.com", mode: "blocked", event_type: "site.agent_trap_tripped", attack: "decoy_trip", count: "82", fingerprints: "0", without_fp: "82", last_seen: "2026-10-22T10:00:00Z" },
        { site: "ogiam.com", mode: "report_only", event_type: "site.agent_payload_attack", attack: "xss", count: "3", fingerprints: "2", without_fp: "1", last_seen: "2026-10-21T10:00:00Z" },
      ],
      "GROUP BY 1, 2": [
        { site: "ogiam.com", mode: "blocked", count: "158", fingerprints: "12", without_fp: "82", last_seen: "2026-10-23T10:00:00Z" },
        { site: "ogiam.com", mode: "report_only", count: "3", fingerprints: "2", without_fp: "1", last_seen: "2026-10-21T10:00:00Z" },
      ],
      "count(*) AS n": [{ site: "instinct", n: "7828" }],
      "AS last_at": [
        { site: "ogiam.com", last_at: "2026-10-24T10:00:00Z" },
        { site: "instinct", last_at: "2026-10-24T09:00:00Z" },
        { site: "weekendwithporsche", last_at: "2026-10-24T08:00:00Z" },
      ],
    });
    const out = await getProvenAttacks(SINCE, "", ["30"], ["aidanmulready", "instinct", "ogiam.com", "weekendwithporsche"]);
    expect(out.available).toBe(true);
    expect(out.sites.map((s) => s.site)).toEqual(["ogiam.com", "aidanmulready", "instinct", "weekendwithporsche"]);
    const og = out.sites[0];
    expect(og.blocked.events).toBe(158);
    expect(og.blocked.fingerprints).toBe(12);
    expect(og.blocked.byClass.map((c) => c.attack)).toEqual(["decoy_trip", "path_traversal"]);
    // a decoy class with no fingerprint recorded is null, never 0
    expect(og.blocked.byClass[0]).toMatchObject({ eventType: "site.agent_trap_tripped", fingerprints: null, withoutFingerprint: 82 });
    expect(og.reportOnly.byClass[0]).toMatchObject({ attack: "xss", fingerprints: 2, withoutFingerprint: 1 });
    // instinct: only false positives -> zero proven, and the exclusion is reported
    const inst = out.sites.find((s) => s.site === "instinct")!;
    expect(inst.blocked.events).toBe(0);
    expect(inst.blocked.fingerprints).toBeNull();
    expect(inst.excludedFalsePositives).toBe(7828);
    expect(out.excludedFalsePositives).toBe(7828);
    // a known site with nothing at all still has a row (its empty state is said)
    const aidan = out.sites.find((s) => s.site === "aidanmulready")!;
    expect(aidan).toMatchObject({ lastReportAt: null, excludedFalsePositives: 0 });
    expect(aidan.blocked.events).toBe(0);
  });

  it("every proven query is restricted to proven types and drops the false positive", async () => {
    route({});
    await getProvenAttacks(SINCE, "", ["30"], []);
    const sqls = mockSafeQuery.mock.calls.map(([sql]) => String(sql));
    const provenSqls = sqls.filter((s) => s.includes("'site.agent_payload_attack','site.agent_trap_tripped'"));
    expect(provenSqls).toHaveLength(2);
    for (const s of provenSqls) expect(s).toContain(NOT_CONTROL_PLANE_FP);
    // the excluded-count query selects exactly the false-positive rows
    expect(sqls.find((s) => s.includes("count(*) AS n"))).toContain(`AND ${CONTROL_PLANE_FP_ROW}`);
  });

  it("a failed read is available=false, never an honest-looking zero", async () => {
    route({ "GROUP BY 1, 2, 3, 4": "fail" });
    const out = await getProvenAttacks(SINCE, "", ["30"], ["ogiam.com"]);
    expect(out.available).toBe(false);
  });

  it("a surface filter binds $2 and only lists that site", async () => {
    route({});
    const out = await getProvenAttacks(SINCE, ` AND coalesce(props->>'site', 'ogiam.com') = $2`, ["30", "weekendwithporsche"], ["ogiam.com", "weekendwithporsche"]);
    expect(out.sites.map((s) => s.site)).toEqual(["weekendwithporsche"]);
    for (const [sql, params] of mockSafeQuery.mock.calls) {
      expect(String(sql)).toMatch(/= \$2/);
      expect(params).toEqual(["30", "weekendwithporsche"]);
    }
  });

  it("is on the board summary", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const summary = await getSiteAnalyticsSummary(30);
    expect(summary.proven).toMatchObject({ available: true, sites: [], excludedFalsePositives: 0 });
  });
});
