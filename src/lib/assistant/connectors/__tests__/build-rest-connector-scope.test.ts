/**
 * buildRestConnectorForWorkspace — agent-scope BACKSTOP (defense-in-depth).
 *
 * Connector tools pre-check scope via the resolver, but the build helper itself
 * must fail closed if an agent path ever reaches it for an unbound connector:
 *   - agent NOT bound → throws ConnectorScopeError, NEVER loads credentials.
 *   - agent bound → builds normally.
 *   - human (no agentId) / assistant sentinel → builds normally, NO scope check.
 *
 * We mock loadConnectorCredentials (so no DB) and the scope module's
 * assertAgentConnectorScope so the test isolates the gate decision.
 */

const mockLoadCreds = jest.fn();
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (...a: unknown[]) => mockLoadCreds(...a),
}));

const mockAssert = jest.fn();
jest.mock("@/lib/agents/connections/scope", () => {
  class ConnectorScopeError extends Error {
    code = "connector_not_authorized" as const;
    constructor(
      public agentId: string,
      public workspaceId: string,
      public connectorName: string,
    ) {
      super(`unbound ${connectorName}`);
      this.name = "ConnectorScopeError";
    }
  }
  return {
    assertAgentConnectorScope: (...a: unknown[]) => mockAssert(...a),
    ConnectorScopeError,
    ASSISTANT_SENTINEL: "instinct.assistant",
  };
});

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { buildRestConnectorForWorkspace } from "@/lib/assistant/connectors/rest-connector";

beforeEach(() => {
  mockLoadCreds.mockReset();
  mockAssert.mockReset();
  mockLoadCreds.mockResolvedValue(null); // env-default connector
});

it("throws ConnectorScopeError for an unbound agent and never loads credentials", async () => {
  mockAssert.mockResolvedValue({ allowed: false });
  await expect(
    buildRestConnectorForWorkspace("ws-1", "jira", "agent-1"),
  ).rejects.toMatchObject({ code: "connector_not_authorized" });
  expect(mockLoadCreds).not.toHaveBeenCalled();
});

it("builds normally for a bound agent (scope allowed)", async () => {
  mockAssert.mockResolvedValue({ allowed: true });
  const c = await buildRestConnectorForWorkspace("ws-1", "salesforce", "agent-1");
  expect(c.name).toBe("salesforce");
  expect(mockAssert).toHaveBeenCalledWith("agent-1", "ws-1", "salesforce");
  expect(mockLoadCreds).toHaveBeenCalled();
});

it("human path (no agentId) builds without any scope check", async () => {
  const c = await buildRestConnectorForWorkspace("ws-1", "salesforce");
  expect(c.name).toBe("salesforce");
  expect(mockAssert).not.toHaveBeenCalled();
});

it("assistant sentinel builds without a scope check", async () => {
  const c = await buildRestConnectorForWorkspace("ws-1", "salesforce", "instinct.assistant");
  expect(c.name).toBe("salesforce");
  expect(mockAssert).not.toHaveBeenCalled();
});
