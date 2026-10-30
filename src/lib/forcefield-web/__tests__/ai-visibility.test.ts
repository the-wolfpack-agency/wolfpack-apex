/** @jest-environment node */
import { AGENT_PURPOSE, foldVisibility, getAiVisibility, visibilitySql, type VisibilityRow } from "@/lib/forcefield-web/ai-visibility";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const SINCE = "2026-10-01T00:00:00.000Z";
const row = (o: Partial<VisibilityRow>): VisibilityRow => ({ agent: "GPTBot", verification: "", flagged: false, path: "/", day: "2026-10-01", n: 1, last_seen: "2026-10-01T10:00:00Z", ...o });

describe("AI visibility: grouped by purpose, with identity, pages and trend", () => {
  it("every agent the engine welcomes has a documented purpose (none silently 'other')", () => {
    for (const a of DEFAULT_RULESET.knownAgents) expect(AGENT_PURPOSE[a.id]).toBeDefined();
  });

  it("sums requests per agent, counts verified ones, lists top pages and a zero-filled daily series", () => {
    const v = foldVisibility([
      row({ agent: "ClaudeBot", path: "/", n: 5 }),
      row({ agent: "ClaudeBot", path: "/pricing", n: 2, day: "2026-10-03" }),
      row({ agent: "ClaudeBot", path: "/", verification: "verified", n: 3, day: "2026-10-03", last_seen: "2026-10-03T09:00:00Z" }),
      row({ agent: "Googlebot", path: "/", n: 4 }),
    ], SINCE, 3);
    const claude = v.agents[0];
    expect(claude).toMatchObject({ agent: "ClaudeBot", vendor: "Anthropic", purpose: "ai_training", requests: 10, verifiedRequests: 3, identity: "verified", pages: 2, lastSeen: "2026-10-03T09:00:00Z" });
    expect(claude.topPages).toEqual([{ path: "/", requests: 8 }, { path: "/pricing", requests: 2 }]);
    expect(claude.daily).toEqual([5, 0, 5]);
    expect(v.byPurpose).toEqual({ ai_training: 10, ai_search: 0, ai_assistant: 0, search_engine: 4, other: 0 });
  });

  it("an impersonation (claimed GPTBot from outside OpenAI's ranges) is counted apart, never as the real agent's reads", () => {
    const v = foldVisibility([row({ agent: "GPTBot", flagged: true, verification: "impersonation", n: 7 })], SINCE, 1);
    expect(v.agents[0]).toMatchObject({ agent: "GPTBot", requests: 0, impersonations: 7, identity: "impersonation", pages: 0 });
    expect(v.byPurpose.ai_training).toBe(0);
  });

  it("a flagged row that is not an impersonation is ignored; an unknown agent is 'other', never guessed", () => {
    const v = foldVisibility([row({ agent: "GPTBot", flagged: true, verification: "", n: 3 }), row({ agent: "NewBot", n: 2 })], SINCE, 1);
    expect(v.agents.map((a) => [a.agent, a.purpose, a.vendor])).toEqual([["NewBot", "other", null]]);
  });

  it("scoped SQL: a tenant by its id, an internal site by its label (never another tenant's rows), synthetic excluded, requests summed", () => {
    expect(visibilitySql({ tenantId: "t" })).toMatch(/WHERE forcefield_tenant_id = \$1/);
    expect(visibilitySql({ site: "s" })).toMatch(/forcefield_tenant_id IS NULL AND props->>'site' = \$1/);
    expect(visibilitySql({ site: "s" })).toMatch(/synthetic', ''\) <> 'true'/);
    expect(visibilitySql({ site: "s" })).toMatch(/sum\(COALESCE\(\(props->>'repeat_count'\)::int, 1\)\)/);
  });

  it("getAiVisibility passes the scope key and window, and degrades to empty on a read error", async () => {
    const q = jest.fn().mockResolvedValue([row({ agent: "Bingbot", day: "2026-10-30" })]);
    const v = await getAiVisibility({ tenantId: "t1" }, { days: 7, q: q as never, nowMs: Date.parse("2026-10-30T12:00:00Z") });
    expect(q.mock.calls[0][1]).toEqual(["t1", "2026-10-24T00:00:00.000Z"]);
    expect(v.agents[0]).toMatchObject({ agent: "Bingbot", purpose: "search_engine", daily: [0, 0, 0, 0, 0, 0, 1] });
    const bad = await getAiVisibility({ site: "s" }, { q: (async () => { throw new Error("db down"); }) as never });
    expect(bad.agents).toEqual([]);
  });
});
