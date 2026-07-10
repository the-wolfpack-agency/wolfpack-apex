/**
 * execute_agent_widget tool: intent matching, manager gating, and the returned
 * control-plane widget spec (roster sorted active-first, name preselection).
 */

const mockListAgents = jest.fn();
jest.mock("@/lib/agents/store", () => ({ listAgents: (...a: any[]) => mockListAgents(...a) }));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: any[]) => mockTrackEvent(...a) }));

const mockCanInvokeTool = jest.fn();
jest.mock("@/lib/assistant/tools/gate", () => ({
  canInvokeTool: (...a: any[]) => mockCanInvokeTool(...a),
}));

jest.mock("@/lib/assistant/tools/registry", () => ({ registerTool: jest.fn() }));

import {
  executeAgentWidgetTool,
  matchExecuteAgentIntent,
} from "@/lib/assistant/tools/execute-agent-widget-tool";

const ctx: any = { userId: "u1", userRole: "admin", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockCanInvokeTool.mockReturnValue(true);
  mockListAgents.mockResolvedValue([
    { id: "a1", name: "Aria", state: "paused" },
    { id: "a2", name: "Bob", state: "active" },
  ]);
});

describe("matchExecuteAgentIntent", () => {
  it("claims the open-the-panel phrasings", () => {
    expect(matchExecuteAgentIntent("run an agent")).toEqual({});
    expect(matchExecuteAgentIntent("execute an agent")).toEqual({});
    expect(matchExecuteAgentIntent("launch agent Aria")).toEqual({ agentName: "Aria" });
    expect(matchExecuteAgentIntent("agent control panel")).toEqual({});
    expect(matchExecuteAgentIntent("run agent named Bob")).toEqual({ agentName: "Bob" });
  });

  it("drops a trailing task clause, keeping only the name hint", () => {
    expect(matchExecuteAgentIntent("run agent Aria to draft the brief")).toEqual({
      agentName: "Aria",
    });
    expect(matchExecuteAgentIntent("execute an agent to do the thing")).toEqual({});
  });

  it("does NOT claim delegate's 'Agent1 <instruction>' or unrelated prompts", () => {
    // "Agent1 add a task" starts with the name, not a run/execute lead.
    expect(matchExecuteAgentIntent("Agent1 add a task titled X")).toBeNull();
    expect(matchExecuteAgentIntent("run the monthly report")).toBeNull();
    expect(matchExecuteAgentIntent("what is an agent")).toBeNull();
  });
});

describe("executeAgentWidgetTool.handler", () => {
  it("returns the control-plane widget with the roster sorted active-first", async () => {
    const res = await executeAgentWidgetTool.handler({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget?.kind).toBe("execute_agent");
    const spec = res.widget as any;
    expect(spec.agents.map((a: any) => a.id)).toEqual(["a2", "a1"]); // active first
    expect(spec.submitUrlTemplate).toBe("/api/admin/agents/{id}/tasks");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "admin",
      expect.objectContaining({ widget_kind: "execute_agent", agent_count: 2 }),
    );
  });

  it("preselects an agent when the intent named one", async () => {
    const res = await executeAgentWidgetTool.handler({ agentName: "aria" }, ctx);
    if (!res.ok) throw new Error("expected ok");
    expect((res.widget as any).preselectedAgentId).toBe("a1");
  });

  it("refuses a non-manager", async () => {
    mockCanInvokeTool.mockReturnValue(false);
    const res = await executeAgentWidgetTool.handler({}, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("capability");
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it("handles an empty roster", async () => {
    mockListAgents.mockResolvedValue([]);
    const res = await executeAgentWidgetTool.handler({}, ctx);
    if (!res.ok) throw new Error("expected ok");
    expect((res.widget as any).agents).toEqual([]);
    expect(res.answer).toMatch(/No agents are onboarded/);
  });
});
