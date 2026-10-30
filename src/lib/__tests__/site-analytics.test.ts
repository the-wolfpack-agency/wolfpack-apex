/**
 * site-analytics lib: recordSiteEvent persists one row; getSiteAnalyticsSummary
 * shapes the aggregate rows the admin page renders. DB is mocked.
 */

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  recordSiteEvent,
  repeatCollapseKey,
  getSiteAnalyticsSummary,
  isSiteEventType,
  countVerdictFalsePositives,
  HOSTILE_EVENT_TYPES,
  SITE_EVENT_TYPES,
} from "@/lib/site-analytics";

const ORIGINAL_DB = process.env.DATABASE_URL;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB;
});

describe("isSiteEventType", () => {
  it("accepts the closed vocabulary and rejects others", () => {
    expect(isSiteEventType("site.page_viewed")).toBe(true);
    expect(isSiteEventType("site.cta_clicked")).toBe(true);
    expect(isSiteEventType("site.evil")).toBe(false);
    expect(isSiteEventType(42)).toBe(false);
  });
});

describe("repeat trap trips collapse (one row per source per 10 minutes)", () => {
  const trap = { site: "ogiam.com", fp: "fpA", reason_kind: "decoy" };

  it("keys a trap trip on site, source and kind; fingerprint first, else session sig", () => {
    expect(repeatCollapseKey("site.agent_trap_tripped", trap)).toEqual({ site: "ogiam.com", source: "fpA", kind: "decoy" });
    expect(repeatCollapseKey("site.agent_trap_tripped", { site: "s", sig: "sig1" })).toEqual({ site: "s", source: "sig1", kind: "" });
  });

  it("never collapses synthetic probes, sourceless trips or other event types", () => {
    expect(repeatCollapseKey("site.agent_trap_tripped", { ...trap, synthetic: true })).toBeNull();
    expect(repeatCollapseKey("site.agent_trap_tripped", { site: "s" })).toBeNull();
    expect(repeatCollapseKey("site.agent_payload_attack", trap)).toBeNull();
  });

  it("a repeat folds into the open row and inserts nothing", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "1" }] });
    await recordSiteEvent({ eventType: "site.agent_trap_tripped", path: "/_ff/x", props: trap });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/UPDATE site_analytics_events[\s\S]*repeat_count/);
  });

  it("the first trip in a window inserts a row", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await recordSiteEvent({ eventType: "site.agent_trap_tripped", path: "/_ff/x", props: trap });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(String(mockQuery.mock.calls[1][0])).toMatch(/INSERT INTO site_analytics_events/);
  });
});

describe("recordSiteEvent", () => {
  it("inserts an anonymous row with the given fields", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await recordSiteEvent({
      eventType: "site.page_viewed",
      path: "/ogiam-iam",
      country: "US",
      referrerHost: "google.com",
      props: { surface: "dropdown" },
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const params = mockQuery.mock.calls[0][1];
    expect(params[0]).toBe("site.page_viewed");
    expect(params[1]).toBe("/ogiam-iam");
    expect(params[2]).toBe("US");
    expect(params[3]).toBe("google.com");
    expect(JSON.parse(params[4])).toEqual({ surface: "dropdown" });
  });

  it("is a no-op without DATABASE_URL and never throws", async () => {
    delete process.env.DATABASE_URL;
    await expect(recordSiteEvent({ eventType: "site.page_viewed" })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("getSiteAnalyticsSummary", () => {
  it("aggregates rows into the heatmap + breakdown shapes", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] }); // anything not scripted below
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ hour: 9, count: "12" }, { hour: 14, count: "30" }] }) // byHour
      .mockResolvedValueOnce({ rows: [{ path: "/ogiam-iam", count: "40" }] }) // byPage
      .mockResolvedValueOnce({ rows: [{ country: "US", count: "35" }] }) // byCountry
      .mockResolvedValueOnce({ rows: [{ event_type: "site.page_viewed", count: "42" }] }) // byType
      .mockResolvedValueOnce({ rows: [{ page_views: "42", total: "55" }] }) // totals
      .mockResolvedValueOnce({ rows: [{ welcomed: "3", flagged: "5", trapped: "2", blocked: "1", hostile_operators: "2", hostile_events: "4" }] }) // forcefield counts
      .mockResolvedValueOnce({ rows: [{ agent: "GPTBot", count: "3" }] }) // forcefield top agents
      .mockResolvedValueOnce({ rows: [ // journey rows (correlated agent events)
        { event_type: "site.agent_trap_tripped", path: "/_ff/x", created_at: "2026-09-18T10:00:00Z", sig: "fp1", nonce: null, agent: null },
        { event_type: "site.agent_probed_sensitive", path: "/admin", created_at: "2026-09-18T10:00:05Z", sig: "fp1", nonce: null, agent: null },
      ] })
      .mockResolvedValueOnce({ rows: [ // agent origins by country
        { country: "US", total: "12", welcomed: "2", welcomed_verified: "1", flagged: "6", hostile: "4" },
        { country: "DE", total: "3", welcomed: "0", welcomed_verified: "0", flagged: "3", hostile: "0" },
      ] })
      .mockResolvedValueOnce({ rows: [ // payload attacks by kind
        { attack: "sql_injection", count: "3" },
        { attack: "xss", count: "1" },
      ] })
      .mockResolvedValueOnce({ rows: [{ surface: "ogiam.com" }, { surface: "instinct" }] }) // distinct surfaces
      .mockResolvedValueOnce({ rows: [{ has_pv: true }] }) // lifetime page-view existence
      .mockResolvedValueOnce({ rows: [{ shadow: "2", enforcing: "1", auto_blocked: "3" }] }); // learned signatures

    const summary = await getSiteAnalyticsSummary(30);
    expect(summary.rangeDays).toBe(30);
    expect(summary.totalPageViews).toBe(42);
    // This property has page-view telemetry, so the count is real, not n/a.
    expect(summary.collectsPageViews).toBe(true);
    expect(summary.totalEvents).toBe(55);
    expect(summary.byHour).toEqual([
      { hour: 9, count: 12 },
      { hour: 14, count: 30 },
    ]);
    expect(summary.byPage).toEqual([{ path: "/ogiam-iam", count: 40 }]);
    expect(summary.byCountry).toEqual([{ country: "US", count: 35 }]);
    expect(summary.byType).toEqual([{ type: "site.page_viewed", count: 42 }]);
    // the property picker's options + the default (unfiltered) selection
    expect(summary.surfaces).toEqual(["ogiam.com", "instinct"]);
    expect(summary.surface).toBe("all");
    expect(summary.forcefield).toEqual({
      welcomed: 3, flagged: 5, trapped: 2, blocked: 1, wouldBlock: 0, hostileOperators: 2, hostileEvents: 4, topAgents: [{ agent: "GPTBot", count: 3 }],
    });
    expect(summary.learnedSignatures).toEqual({ shadow: 2, enforcing: 1, autoBlocked: 3 });
    // The two correlated events (same fingerprint) fuse into one classified journey.
    expect(summary.journeys).toHaveLength(1);
    expect(summary.journeys[0].behaviorClass).toBe("vuln_scanner"); // probing outranks scraping when both present
    expect(summary.journeys[0].confidence).toBe("proven"); // tripped_decoy is structurally a bot
    expect(summary.journeys[0].path).toEqual(["/_ff/x", "/admin"]);

    // Each journey carries a granular agent profile for the UI (engine-reused).
    const profile = summary.journeys[0].profile;
    expect(profile.operatorKey).toMatch(/^op_/);
    expect(profile.verdict.confidence).toBe("proven");
    expect(profile.verdict.why).toMatch(/decoy|honeypot|nonce/i);
    expect(profile.processes.some((p) => p.hostile)).toBe(true);
    expect(profile.disclaimer).toMatch(/does not establish a real-world identity/i);

    // Agent provenance by network-origin country, split by how Forcefield handled it.
    // Probe intelligence: /admin (a probed path in the journey) is named with its CWE.
    expect(summary.probeIntel.some((e) => /admin surface/i.test(e.label) && e.cwe === "CWE-200")).toBe(true);

    // Payload attacks aggregated by kind (from the edge detector).
    expect(summary.payloadIntel).toEqual([
      { attack: "sql_injection", count: 3 },
      { attack: "xss", count: 1 },
    ]);

    expect(summary.agentOrigins).toEqual([
      { country: "US", total: 12, welcomed: 2, welcomedVerified: 1, flagged: 6, hostile: 4 },
      { country: "DE", total: 3, welcomed: 0, welcomedVerified: 0, flagged: 3, hostile: 0 },
    ]);
  });

  it("clamps the range to a sane window", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const summary = await getSiteAnalyticsSummary(99999);
    expect(summary.rangeDays).toBe(365);
    // The clamped value is passed to SQL as a string param.
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["365"]);
  });
});

describe("getSiteAnalyticsSummary - per-site (surface) filter", () => {
  it("adds a bound surface predicate to the event queries when a surface is selected", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await getSiteAnalyticsSummary(30, undefined, "instinct");
    // every event query is filtered to the surface via a BOUND param (never interpolated)
    const eventCalls = mockSafeQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM site_analytics_events") && String(sql).includes("coalesce(props->>'site'"),
    );
    expect(eventCalls.length).toBeGreaterThan(0);
    for (const [sql, params] of eventCalls) {
      // the surfaces-LIST query intentionally does NOT filter by surface (it lists all)
      if (String(sql).includes("SELECT DISTINCT coalesce(props->>'site'")) continue;
      // the lifetime page-view EXISTS check is surface-only (no since window), so
      // it binds the surface as $1 with no days param - a deliberate exception.
      if (String(sql).includes("EXISTS(")) {
        expect(String(sql)).toMatch(/= \$1/);
        expect(params).toEqual(["instinct"]);
        continue;
      }
      expect(String(sql)).toMatch(/= \$2/);
      expect(params).toEqual(["30", "instinct"]);
    }
  });

  it("reports collectsPageViews=false for an agent-monitored property with no page-view events", async () => {
    // Every query empty EXCEPT: totals report 0 page views, and the lifetime
    // EXISTS check returns has_pv:false -> the property forwards agent events
    // only, so page views are n/a rather than a measured 0.
    mockSafeQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("EXISTS(")) return Promise.resolve({ rows: [{ has_pv: false }] });
      if (String(sql).includes("count(*) AS total")) return Promise.resolve({ rows: [{ page_views: "0", total: "17" }] });
      return Promise.resolve({ rows: [] });
    });
    const summary = await getSiteAnalyticsSummary(30, undefined, "instinct");
    expect(summary.collectsPageViews).toBe(false);
    expect(summary.totalPageViews).toBe(0);
    // It IS reporting - it just reports agent events, not page views.
    expect(summary.totalEvents).toBe(17);
  });

  it("adds NO surface predicate for the cross-site 'all' view (default)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await getSiteAnalyticsSummary(30, undefined, "all");
    const filtered = mockSafeQuery.mock.calls.filter(([sql]) => /= \$2/.test(String(sql)));
    expect(filtered).toHaveLength(0); // nothing is surface-scoped
  });
});

describe("verdict false-positive counter (regression: always read 0)", () => {
  it("reads instinct_events by its real time column `timestamp`, never created_at", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ n: "4" }] });
    expect(await countVerdictFalsePositives("ws-1", 30)).toBe(4);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/FROM instinct_events/);
    expect(sql).toMatch(/\btimestamp\s*>/);
    expect(sql).not.toMatch(/created_at/);
    // workspace scope is read from metadata.workspace_id, exactly as the
    // verdict-feedback route writes it.
    expect(sql).toMatch(/metadata->>'workspace_id' = \$1/);
    expect(params).toEqual(["ws-1", 30]);
  });

  it("is surfaced on the summary for a workspace", async () => {
    mockSafeQuery.mockImplementation((sql: string) =>
      Promise.resolve(String(sql).includes("forcefield.verdict_false_positive") ? { rows: [{ n: "2" }] } : { rows: [] }),
    );
    const summary = await getSiteAnalyticsSummary(30, "ws-1");
    expect(summary.verdictFeedback.falsePositives).toBe(2);
  });

  it("is not queried without a workspace (nothing to scope to)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const summary = await getSiteAnalyticsSummary(30);
    expect(summary.verdictFeedback.falsePositives).toBe(0);
    expect(mockSafeQuery.mock.calls.some(([sql]) => String(sql).includes("instinct_events"))).toBe(false);
  });
});

describe("hostile counts share one definition", () => {
  it("every hostile type is a real site event type, and payload attacks count as hostile on the origin map too", async () => {
    for (const t of HOSTILE_EVENT_TYPES) expect(SITE_EVENT_TYPES).toContain(t);
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await getSiteAnalyticsSummary(30);
    const origin = mockSafeQuery.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("welcomed_verified"))!;
    expect(origin).toContain("'site.agent_payload_attack'");
    expect(origin).toContain("props->>'impersonating' IS NOT NULL");
    // the verified welcome reads the engine's agent_verification label too
    expect(origin).toContain("props->>'agent_verification' = 'verified'");
  });
});

describe("enforcement-era props reach the board", () => {
  function route(map: Record<string, unknown[]>) {
    mockSafeQuery.mockImplementation((sql: string) => {
      for (const [needle, rows] of Object.entries(map)) if (String(sql).includes(needle)) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [] });
    });
  }

  it("shapes blocks vs withheld blocks, bursts, identity, probes and networks", async () => {
    route({
      "props->>'reason_kind'": [{ reason: "payload", blocked: "3", would_block: "1" }, { reason: "decoy", blocked: "0", would_block: "2" }],
      "event_type = 'site.agent_high_rate'": [{ bursts: "5", operators: "2", peak: "88", window_s: "10", from_ingest: "3" }],
      "props->>'signed_agent' = 'true') AS signed": [
        { agent: "GPTBot", verified: "4", impersonation: "2", unverifiable: "0", signed: "0" },
        { agent: "Claude-User", verified: "0", impersonation: "0", unverifiable: "1", signed: "1" },
      ],
      "props->>'probe' AS probe": [{ probe: "next_server_action", count: "7" }],
      "props->>'asn' AS asn": [{ asn: "16509", org: "AMAZON-02", count: "9", hostile: "4" }],
    });
    const { defense } = await getSiteAnalyticsSummary(30);
    expect(defense.enforcement).toEqual({ blocked: 3, wouldBlock: 3, byReason: [{ reason: "payload", blocked: 3, wouldBlock: 1 }, { reason: "decoy", blocked: 0, wouldBlock: 2 }] });
    expect(defense.highRate).toEqual({ bursts: 5, operators: 2, peakRate: 88, windowSeconds: 10, fromIngest: 3 });
    expect(defense.identity).toMatchObject({ verified: 4, impersonation: 2, unverifiable: 1, signed: 1 });
    expect(defense.identity.byAgent[0]).toEqual({ agent: "GPTBot", verified: 4, impersonation: 2, unverifiable: 0, signed: 0 });
    expect(defense.probes).toEqual([{ probe: "next_server_action", count: 7 }]);
    expect(defense.networks).toEqual([{ asn: "16509", org: "AMAZON-02", count: 9, hostile: 4 }]);
  });

  it("an empty window is an honest empty, not an error", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const { defense } = await getSiteAnalyticsSummary(30);
    expect(defense.enforcement.blocked).toBe(0);
    expect(defense.highRate.windowSeconds).toBeNull();
    expect(defense.identity.byAgent).toEqual([]);
    expect(defense.networks).toEqual([]);
  });

  it("never casts a props value in SQL (one bad row must not zero a panel)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await getSiteAnalyticsSummary(30);
    for (const [sql] of mockSafeQuery.mock.calls) {
      // a guarded numeric CASE is the only allowed props cast
      const unguarded = String(sql).replace(/CASE WHEN props->>'[a-z_]+' ~ [^]*? END/g, "");
      expect(unguarded).not.toMatch(/\(props->>'[a-z_]+'\)::/);
    }
  });

  it("carries blocked / would_block / impersonation / probe / rate through to journeys and steps", async () => {
    route({
      "ROW_NUMBER()": [
        { event_type: "site.agent_welcomed", path: "/", created_at: "2026-10-20T10:00:00Z", sig: "s1", nonce: null, agent: "GPTBot", impersonating: "GPTBot", agent_verification: "impersonation", blocked: null, would_block: null },
        { event_type: "site.agent_payload_attack", path: "/api/x", created_at: "2026-10-20T10:00:01Z", sig: "s1", nonce: null, attack: "nextjs_middleware_bypass", blocked: "true", would_block: null },
        { event_type: "site.agent_probed_sensitive", path: "/_next/action", created_at: "2026-10-20T10:00:02Z", sig: "s1", nonce: null, probe: "next_server_action", blocked: null, would_block: "true" },
        { event_type: "site.agent_high_rate", path: "/", created_at: "2026-10-20T10:00:03Z", sig: "s1", nonce: null, rate: "52" },
      ],
    });
    const { journeys } = await getSiteAnalyticsSummary(30);
    expect(journeys).toHaveLength(1);
    const j = journeys[0];
    const imp = j.insights.find((i) => i.kind === "impersonation");
    expect(imp && "claimedAgent" in imp ? imp.claimedAgent : null).toBe("GPTBot");
    const byPath = (p: string) => j.steps.find((st) => st.path === p)!;
    expect(byPath("/api/x")).toMatchObject({ attack: "nextjs_middleware_bypass", blocked: true });
    expect(byPath("/_next/action")).toMatchObject({ probe: "next_server_action", wouldBlock: true });
    expect(byPath("/_next/action").blocked).toBeUndefined();
    expect(j.steps.find((st) => st.signal === "high_rate")?.rate).toBe(52);
  });

  it("the principal verdict the query selects reaches the journey (it used to be dropped)", async () => {
    route({
      "ROW_NUMBER()": [
        { event_type: "site.agent_welcomed", path: "/reports", created_at: "2026-10-20T10:00:00Z", sig: "s2", nonce: null, principal_status: "verified", principal: "alice", principal_issuer: "acme", principal_scopes: JSON.stringify(["/reports"]) },
        { event_type: "site.agent_probed_sensitive", path: "/admin", created_at: "2026-10-20T10:00:01Z", sig: "s2", nonce: null },
      ],
    });
    const summary = await getSiteAnalyticsSummary(30);
    expect(summary.journeys[0].principal?.status).toBe("verified");
    expect(summary.journeys[0].insights.some((i) => i.kind === "mandate_exceeded")).toBe(true);
  });
});
