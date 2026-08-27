/**
 * Two sentences a client says early, and neither reached the right tool.
 *
 * TELLING THE ASSISTANT SOMETHING. "remember that Jorge owns the Porsche
 * account" reached filter_external_records, which read it as a CRM query and
 * answered confidently about the wrong thing while the fact went unsaved. A
 * wrong tool answering with confidence is rated worse here than no tool at
 * all, and this is that.
 *
 * The cause was ordinary: save_team_fact's patterns all require a copula
 * ("Jorge IS the owner"), and nobody speaks that way. They say Jorge owns it,
 * Ashley runs the evals, Sam reports to Jorge. Meanwhile "owns" is a genuine
 * CRM filter signal, so the query tool claimed the sentence.
 *
 * HANDING WORK TO AN AGENT. delegate_to_agent needs a named agent, which is
 * right once somebody knows which agents exist. Nobody knows that the first
 * time, so they say "delegate this to an agent" and reached NO tool at all.
 * The agent capability is the one a client asks about by name.
 */

import "@/lib/assistant/tools";
import { getTools } from "@/lib/assistant/tools/registry";

function claimants(message: string): string[] {
  return (getTools() as unknown as Array<{ name: string; agentOnly?: boolean; matchIntent?: (m: string) => unknown }>)
    .filter((t) => !t.agentOnly && typeof t.matchIntent === "function" && t.matchIntent(message) != null)
    .map((t) => t.name);
}

describe("teaching the assistant a fact", () => {
  it.each([
    "remember that Jorge owns the Porsche account",
    "remember that Ashley runs the evals",
    "remember that Sam reports to Jorge",
    "remember that Priya manages the dealer relationship",
    "note that Chris handles PCNA",
  ])("%s reaches save_team_fact and nothing else", (prompt) => {
    expect(claimants(prompt)).toEqual(["save_team_fact"]);
  });

  it("stores the verb as the relationship rather than flattening it", async () => {
    /* "owns" is the fact. Recording it as a copula would lose the thing the
       speaker actually said. */
    const { saveTeamFactTool } = await import("@/lib/assistant/tools/save-team-fact-tool");
    expect(saveTeamFactTool.matchIntent!("remember that Jorge owns the Porsche account")).toMatchObject({
      subject: "Jorge",
      attribute: "owns",
      value: "Porsche account",
    });
  });

  it.each([
    "deals owned by Jorge",
    "deals over $50k closing this month",
    "opportunities owned by Ashley this quarter",
  ])("%s is still a CRM query", (prompt) => {
    /* THE OTHER HALF. "owns" has to stay a filter signal, or fixing the
       teaching sentence would break every ownership query. */
    expect(claimants(prompt)).toContain("filter_external_records");
  });

  it("does not claim a question that merely mentions remembering", () => {
    expect(claimants("what do we know about Porsche")).not.toContain("save_team_fact");
  });
});

describe("handing work to an agent without naming one", () => {
  it.each([
    "delegate this to an agent",
    "can an agent do this",
    "have an agent do this",
    "get an agent to handle this",
    "hand this off to an agent",
  ])("%s opens the agent picker", (prompt) => {
    expect(claimants(prompt)).toContain("execute_agent_widget");
  });

  it("does not guess which agent was meant", async () => {
    /* Routing an unnamed handover to delegate_to_agent would have to invent an
       agent. The picker shows the ones that exist and lets the next sentence
       name one, which is the honest answer to an unnamed ask. */
    const params = (await import("@/lib/assistant/tools/execute-agent-widget-tool")).matchExecuteAgentIntent(
      "delegate this to an agent",
    );
    expect(params).toEqual({});
  });

  it("leaves a NAMED delegation with delegate_to_agent", () => {
    /* The specific tool keeps the specific sentence. */
    expect(claimants("tell Agent1 to draft the brief")).toContain("delegate_to_agent");
  });

  it.each(["what can you do", "run my day", "how is the pilot going"])(
    "%s is not swallowed by the agent picker",
    (prompt) => {
      expect(claimants(prompt)).not.toContain("execute_agent_widget");
    },
  );
});
