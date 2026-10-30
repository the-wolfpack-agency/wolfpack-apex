/** @jest-environment node */
import { AI_TRAINING_AGENTS, getAgentPolicy, setAgentPolicy, siteScope, tenantScope, validateBlockedAgents } from "@/lib/forcefield-web/agent-policy";

jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn() }));

describe("agent policy: AI training crawlers only, default allowed", () => {
  it("the blockable agents are exactly the documented AI training crawlers", () => {
    expect(AI_TRAINING_AGENTS).toEqual(["Bytespider", "ClaudeBot", "GPTBot", "Meta-ExternalAgent"]);
  });

  it("validates a block list: training agents only, de-duplicated and sorted", () => {
    expect(validateBlockedAgents(["GPTBot", "ClaudeBot", "GPTBot"])).toEqual({ ok: true, agents: ["ClaudeBot", "GPTBot"] });
    expect(validateBlockedAgents([])).toEqual({ ok: true, agents: [] });
    expect(validateBlockedAgents(["OAI-SearchBot"])).toEqual({ ok: false, error: "not_a_training_agent" });
    expect(validateBlockedAgents(["Googlebot"])).toEqual({ ok: false, error: "not_a_training_agent" });
    expect(validateBlockedAgents("GPTBot")).toEqual({ ok: false, error: "invalid_request" });
    expect(validateBlockedAgents([1])).toEqual({ ok: false, error: "invalid_request" });
  });

  it("no row, a malformed scope, or a read error all block nothing (fail-open)", async () => {
    expect(await getAgentPolicy(siteScope("s"), async () => ({ rows: [] }))).toEqual({ blockedAgents: [], updatedAt: null });
    expect(await getAgentPolicy("site:BAD SCOPE" as never, async () => ({ rows: [{ blocked_agents: ["GPTBot"] }] }))).toEqual({ blockedAgents: [], updatedAt: null });
    expect(await getAgentPolicy(siteScope("s"), async () => { throw new Error("db down"); })).toEqual({ blockedAgents: [], updatedAt: null });
  });

  it("a stored agent no longer on the training list is never served (a list change cannot widen a block)", async () => {
    const r = await getAgentPolicy(siteScope("s"), async () => ({ rows: [{ blocked_agents: ["GPTBot", "Googlebot"], updated_at: "t" }] }));
    expect(r.blockedAgents).toEqual(["GPTBot"]);
  });

  it("set: upserts the list for the scope and returns the previous list for the audit", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const q = async (text: string, params: unknown[]) => {
      calls.push([text, params]);
      return { rows: text.startsWith("SELECT") ? [{ blocked_agents: ["ClaudeBot"], updated_at: "t" }] : [] };
    };
    const id = "11111111-2222-3333-4444-555555555555";
    expect(await setAgentPolicy(tenantScope(id), ["GPTBot"], "tenant:x", q)).toEqual({ ok: true, previous: ["ClaudeBot"] });
    expect(calls[1][0]).toMatch(/INSERT INTO forcefield_agent_policies[\s\S]*ON CONFLICT \(scope\) DO UPDATE/);
    expect(calls[1][1]).toEqual([`tenant:${id}`, ["GPTBot"], "tenant:x"]);
    expect(await setAgentPolicy(siteScope("s"), [], "u", async () => { throw new Error("x"); })).toEqual({ ok: false });
  });
});
