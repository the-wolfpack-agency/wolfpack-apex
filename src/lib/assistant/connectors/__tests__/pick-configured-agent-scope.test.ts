/**
 * pickConfiguredConnector — agent-aware filtering (least-privilege).
 *
 * The 2-arg form (workspaceId, agentId) must restrict the auto-pick to the
 * agent's bound set; the 1-arg form (human assistant) must behave exactly as
 * before — first configured connector wins, NO binding lookup.
 *
 * We mock the db (the credentials query) and the scope module's
 * agentBoundConnectors (the binding set), so this isolates the filter logic.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

const mockBound = jest.fn();
jest.mock("@/lib/agents/connections/scope", () => ({
  agentBoundConnectors: (...a: unknown[]) => mockBound(...a),
  ASSISTANT_SENTINEL: "instinct.assistant",
}));

import { pickConfiguredConnector } from "@/lib/assistant/connectors/credentials";

const ORIGINAL_DB = process.env.DATABASE_URL;

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockBound.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB;
});

/** The workspace has hubspot + salesforce + rest-default configured. */
function workspaceHasThree() {
  mockSafeQuery.mockResolvedValueOnce({
    rows: [
      { connector_name: "hubspot" },
      { connector_name: "salesforce" },
      { connector_name: "rest-default" },
    ],
  });
}

describe("human path (no agentId) — unchanged", () => {
  it("returns the first configured connector, never consulting bindings", async () => {
    workspaceHasThree();
    const picked = await pickConfiguredConnector("ws-1");
    expect(picked).toBe("hubspot");
    expect(mockBound).not.toHaveBeenCalled();
  });
});

describe("agent path (agentId) — scoped to bound set", () => {
  it("returns the first CONFIGURED connector that is also BOUND", async () => {
    workspaceHasThree();
    mockBound.mockResolvedValue(["salesforce"]); // hubspot configured but NOT bound
    const picked = await pickConfiguredConnector("ws-1", "agent-1");
    expect(picked).toBe("salesforce");
    expect(mockBound).toHaveBeenCalledWith("ws-1", "agent-1");
  });

  it("returns null when the agent is bound to nothing the workspace configures", async () => {
    workspaceHasThree();
    mockBound.mockResolvedValue(["jira"]); // jira not configured here
    const picked = await pickConfiguredConnector("ws-1", "agent-1");
    expect(picked).toBeNull();
  });

  it("returns null when the agent has NO bindings", async () => {
    workspaceHasThree();
    mockBound.mockResolvedValue([]);
    const picked = await pickConfiguredConnector("ws-1", "agent-1");
    expect(picked).toBeNull();
  });

  it("treats the assistant sentinel as the human path (first configured wins)", async () => {
    workspaceHasThree();
    const picked = await pickConfiguredConnector("ws-1", "instinct.assistant");
    expect(picked).toBe("hubspot");
    expect(mockBound).not.toHaveBeenCalled();
  });
});
