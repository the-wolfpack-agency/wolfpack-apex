/**
 * Recording a canary trip: an event per hit, a hash-chained audit entry, and an
 * alert through the Forcefield alert path. Plus the inbound-request check that
 * the edge observe route and the agent API call. No DB; deps injected. The
 * decoy value must never appear in anything recorded.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/audit-log", () => ({ recordAuditNonFatal: jest.fn(async () => ({ ok: true })) }));

import {
  recordCanaryTrip,
  checkInboundForCanaries,
  listCanariesForMatchingCached,
  _resetCanaryMatchCache,
  type CanaryTripDeps,
} from "../canary-store";
import { inspectAgentAction, type AgentAction, type Canary } from "../tripwire";

const SECRET = "wlpk_live_00112233445566778899aabb";
const CANARIES: Canary[] = [
  { id: "c-token", kind: "token", value: SECRET, seededIn: "JS bundle" },
  { id: "c-route", kind: "route", value: "/internal/export-aabbccddeeff00112233", seededIn: "robots.txt" },
  { id: "c-row", kind: "row", value: "decoy-aabbccddeeff00112233@example.invalid", seededIn: "customers API" },
  { id: "c-tool", kind: "tool", value: "admin_bulk_export_aabbccddeeff0011", seededIn: "tool manifest" },
];

function fakeDeps() {
  const tracked: Record<string, unknown>[] = [];
  const audits: unknown[] = [];
  const alerts: { kind: string; dedupeKey: string; title: string; body: string }[] = [];
  const deps: CanaryTripDeps = {
    track: async (p) => { tracked.push(p); },
    audit: async (e) => { audits.push(e); return { ok: true }; },
    alert: async (a) => { alerts.push(a); return { status: "delivered", inAppRecipients: 1, emailAttempted: 1, emailDelivered: 1, detail: "" }; },
  };
  return { deps, tracked, audits, alerts };
}

const ACTION: AgentAction = { workspaceId: "w1", agentId: "site:ogiam.com", kind: "inbound_request", headers: `authorization=Bearer ${SECRET}` };

describe("recordCanaryTrip", () => {
  it("records an event per hit, one audit entry and one alert", async () => {
    const v = inspectAgentAction({ ...ACTION, url: "/internal/export-aabbccddeeff00112233" }, CANARIES);
    const f = fakeDeps();
    const out = await recordCanaryTrip({ workspaceId: "w1", action: { ...ACTION }, hits: v.hits, site: "ogiam.com" }, f.deps);
    expect(out).toEqual({ tracked: 2, audited: true, alert: expect.objectContaining({ status: "delivered" }) });
    expect(f.tracked.map((t) => t.kind).sort()).toEqual(["route", "token"]);
    expect(f.audits).toHaveLength(1);
    expect((f.audits[0] as { action: string }).action).toBe("forcefield.canary_tripped");
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0].kind).toBe("canary_trip");
    expect(f.alerts[0].title).toMatch(/ogiam\.com/);
  });

  it("NEVER records the decoy value or the payload", async () => {
    const v = inspectAgentAction(ACTION, CANARIES);
    const f = fakeDeps();
    await recordCanaryTrip({ workspaceId: "w1", action: ACTION, hits: v.hits }, f.deps);
    expect(JSON.stringify([f.tracked, f.audits, f.alerts])).not.toContain(SECRET);
  });

  it("an agent trip says the agent was quarantined", async () => {
    const v = inspectAgentAction({ workspaceId: "w1", agentId: "agent-7", kind: "tool_call", tool: "admin_bulk_export_aabbccddeeff0011" }, CANARIES);
    const f = fakeDeps();
    await recordCanaryTrip({ workspaceId: "w1", action: { workspaceId: "w1", agentId: "agent-7", kind: "tool_call" }, hits: v.hits, agentId: "agent-7" }, f.deps);
    expect(f.alerts[0].body).toMatch(/agent agent-7/);
    expect(f.alerts[0].body).toMatch(/quarantined/);
    expect(f.tracked[0].agent_id).toBe("agent-7");
  });

  it("the same decoy + client in one window shares a dedupe key (one alert, not hundreds)", async () => {
    const v = inspectAgentAction(ACTION, CANARIES);
    const f = fakeDeps();
    await recordCanaryTrip({ workspaceId: "w1", action: ACTION, hits: v.hits }, f.deps);
    await recordCanaryTrip({ workspaceId: "w1", action: ACTION, hits: v.hits }, f.deps);
    expect(f.alerts[0].dedupeKey).toBe(f.alerts[1].dedupeKey);
  });

  it("a failing side effect does not stop the others", async () => {
    const v = inspectAgentAction(ACTION, CANARIES);
    const f = fakeDeps();
    f.deps.track = async () => { throw new Error("db"); };
    f.deps.audit = async () => { throw new Error("db"); };
    const out = await recordCanaryTrip({ workspaceId: "w1", action: ACTION, hits: v.hits }, f.deps);
    expect(out.tracked).toBe(0);
    expect(out.audited).toBe(false);
    expect(f.alerts).toHaveLength(1);
  });

  it("no hits -> nothing recorded", async () => {
    const f = fakeDeps();
    expect(await recordCanaryTrip({ workspaceId: "w1", action: ACTION, hits: [] }, f.deps)).toEqual({ tracked: 0, audited: false, alert: null });
  });
});

describe("checkInboundForCanaries", () => {
  const load = async () => CANARIES;

  it.each([
    ["token", { url: `/x?key=${SECRET}` }],
    ["route", { url: "/internal/export-aabbccddeeff00112233" }],
    ["row", { url: `/s?q=${encodeURIComponent("decoy-aabbccddeeff00112233@example.invalid")}` }],
    ["tool", { url: "/api/tools/admin_bulk_export_aabbccddeeff0011" }],
  ])("a %s canary in an inbound request trips and is recorded", async (kind, req) => {
    const record = jest.fn(async () => ({ tracked: 1, audited: true, alert: null }));
    const v = await checkInboundForCanaries({ workspaceId: "w1", clientLabel: "site:s", site: "s", ...req }, { load, record });
    expect(v.tripped).toBe(true);
    expect(v.hits[0].kind).toBe(kind);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("ordinary traffic passes and records nothing", async () => {
    const record = jest.fn();
    const v = await checkInboundForCanaries({ workspaceId: "w1", clientLabel: "site:s", url: "/pricing" }, { load, record });
    expect(v.tripped).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("never throws (a failing decoy read is a pass)", async () => {
    const v = await checkInboundForCanaries({ workspaceId: "w1", clientLabel: "c", url: "/x" }, { load: async () => { throw new Error("db"); } });
    expect(v.tripped).toBe(false);
  });
});

describe("listCanariesForMatchingCached", () => {
  beforeEach(() => { _resetCanaryMatchCache(); mockSafeQuery.mockReset(); });

  it("reads once per minute per workspace", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ id: "1", kind: "token", value: SECRET, seeded_in: "x" }] });
    await listCanariesForMatchingCached("w1", 0);
    await listCanariesForMatchingCached("w1", 30_000);
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    await listCanariesForMatchingCached("w1", 61_000);
    expect(mockSafeQuery).toHaveBeenCalledTimes(2);
  });
});
