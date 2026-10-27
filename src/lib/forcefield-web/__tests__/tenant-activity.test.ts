/** @jest-environment node */
/**
 * "Who visited" for one tenant: every query is tenant-scoped and excludes
 * synthetic monitor traffic; each agent's handling is the most decisive thing
 * Forcefield did (blocked > slowed > welcomed > caught > watched); counts cover
 * every agent while the list is capped; a failure degrades to empty.
 */
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn(async () => ({ rows: [] })) }));

import { ACTIVITY_SQL, agentFromRow, getTenantActivity, type ActivityRow } from "@/lib/forcefield-web/tenant-activity";

const row = (over: Partial<ActivityRow>): ActivityRow => ({
  who: "Googlebot", client_type: "known_crawler", requests: 3, last_seen: "2026-10-26 10:00:00+00",
  blocked: false, would_block: false, slowed: false, welcomed: false, trapped: false, payload: false, probed: false, high_rate: false,
  attack: null, probe: null, ...over,
});

describe("ACTIVITY_SQL", () => {
  it("is scoped to one tenant and drops synthetic monitor traffic, in both the agent and the tarpit reads", () => {
    expect(ACTIVITY_SQL.match(/forcefield_tenant_id = \$1/g)).toHaveLength(2);
    expect(ACTIVITY_SQL.match(/COALESCE\(props->>'synthetic', ''\) <> 'true'/g)).toHaveLength(2);
    expect(ACTIVITY_SQL).toContain("event_type LIKE 'site.agent_%'");
    expect(ACTIVITY_SQL).toContain("props->>'intent_action' = 'tarpit'");
    expect(ACTIVITY_SQL).not.toMatch(/\bip\b/i);
  });
});

describe("agentFromRow", () => {
  it("names and handles each kind of visitor", () => {
    expect(agentFromRow(row({ welcomed: true }))).toMatchObject({ name: "Googlebot", did: "Read your public pages", handled: "welcomed", requests: 3 });
    expect(agentFromRow(row({ who: "sqlmap", payload: true, attack: "sql_injection", blocked: true }))).toMatchObject({ did: "Sent an attack payload (sql injection)", handled: "blocked" });
    expect(agentFromRow(row({ who: "python-requests", probed: true, probe: "env_file", slowed: true }))).toMatchObject({ did: "Probed a sensitive path (env file)", handled: "slowed" });
    expect(agentFromRow(row({ who: "curl", payload: true, would_block: true }))).toMatchObject({ handled: "caught" });
    expect(agentFromRow(row({ who: "x", trapped: true }))).toMatchObject({ did: "Tripped a hidden decoy only a scanner would find", handled: "caught" });
    expect(agentFromRow(row({ who: "y", high_rate: true }))).toMatchObject({ did: "Made requests faster than a person can", handled: "watched" });
  });

  it("an impostor that was welcomed once but proven hostile is not 'welcomed'", () => {
    expect(agentFromRow(row({ welcomed: true, probed: true })).handled).toBe("caught");
  });

  it("an unnamed agent is labeled by its kind and a short fingerprint", () => {
    expect(agentFromRow(row({ who: "unnamed:abcdef0123", client_type: "headless" })).name).toBe("Unnamed headless browser (abcdef)");
  });
});

describe("getTenantActivity", () => {
  it("counts every agent and caps the list", async () => {
    const rows = [
      row({ who: "a", welcomed: true }), row({ who: "b", blocked: true }), row({ who: "c", slowed: true }),
      row({ who: "d", would_block: true }), row({ who: "e" }),
    ];
    const q = jest.fn(async () => rows);
    const r = await getTenantActivity("t1", "2026-10-26T00:00:00.000Z", { q: q as never, limit: 2 });
    expect(q).toHaveBeenCalledWith(ACTIVITY_SQL, ["t1", "2026-10-26T00:00:00.000Z"]);
    expect(r.counts).toEqual({ agentsSeen: 5, welcomed: 1, slowed: 1, blocked: 1, caught: 1 });
    expect(r.agents.map((a) => a.name)).toEqual(["a", "b"]);
  });

  it("degrades to empty on a query error or a missing tenant", async () => {
    const r = await getTenantActivity("t1", "x", { q: (async () => { throw new Error("down"); }) as never });
    expect(r).toEqual({ sinceIso: "x", counts: { agentsSeen: 0, welcomed: 0, slowed: 0, blocked: 0, caught: 0 }, agents: [] });
    const q = jest.fn();
    expect((await getTenantActivity("", "x", { q: q as never })).agents).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });
});
