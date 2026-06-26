/**
 * Agent store tests against a mocked db: creation returns a one-time secret and
 * stores only its hash, activation verifies the secret constant-time and refuses
 * a revoked agent, and lifecycle transitions update state.
 */

import { createHash } from "crypto";

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { createAgent, activateWithOnboardingSecret, setAgentState, listAgents } from "@/lib/agents/store";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "agent-1", workspace_id: "ws-1", name: "Scout", role: "ops",
    owner_user_id: "owner-1", state: "invited", identity_provider: "local",
    external_subject: null, scan_status: "pending", description: null,
    created_by: "admin-1", created_at: "t", activated_at: null, last_seen_at: null,
    revoked_at: null, ...over,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockWriteQuery.mockReset();
  mockSafeQuery.mockReset();
  mockTrackEvent.mockReset();
});

describe("createAgent", () => {
  it("returns a one-time secret and stores ONLY its sha256 hash", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [row()] });
    const { agent, onboardingSecret } = await createAgent({
      workspaceId: "ws-1", name: "Scout", role: "ops", ownerUserId: "owner-1",
      createdBy: "admin-1", createdByRole: "cto",
    });
    expect(agent.id).toBe("agent-1");
    expect(onboardingSecret).toMatch(/^[0-9a-f]{64}$/);
    // The INSERT received the HASH of the secret, never the raw secret.
    const params = mockWriteQuery.mock.calls[0][1];
    const storedHash = params[5];
    expect(storedHash).toBe(createHash("sha256").update(onboardingSecret).digest("hex"));
    expect(params).not.toContain(onboardingSecret);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.created", "admin-1", "cto", expect.objectContaining({ agent_id: "agent-1" }),
    );
  });
});

describe("activateWithOnboardingSecret", () => {
  it("activates on the correct secret", async () => {
    const secret = "a".repeat(64);
    const hash = createHash("sha256").update(secret).digest("hex");
    mockQuery.mockResolvedValue({ rows: [row({ onboarding_secret_hash: hash })] });
    mockWriteQuery.mockResolvedValue({ rows: [row({ state: "active", activated_at: "t2" })] });
    const agent = await activateWithOnboardingSecret("agent-1", secret);
    expect(agent?.state).toBe("active");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.activated", "agent-1", "ops", expect.objectContaining({ agent_id: "agent-1" }),
    );
  });

  it("rejects a wrong secret without activating", async () => {
    const hash = createHash("sha256").update("a".repeat(64)).digest("hex");
    mockQuery.mockResolvedValue({ rows: [row({ onboarding_secret_hash: hash })] });
    const agent = await activateWithOnboardingSecret("agent-1", "b".repeat(64));
    expect(agent).toBeNull();
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("refuses a revoked agent even with the right secret", async () => {
    const secret = "a".repeat(64);
    const hash = createHash("sha256").update(secret).digest("hex");
    mockQuery.mockResolvedValue({ rows: [row({ state: "revoked", onboarding_secret_hash: hash })] });
    expect(await activateWithOnboardingSecret("agent-1", secret)).toBeNull();
  });

  it("returns null for an unknown agent", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await activateWithOnboardingSecret("nope", "x")).toBeNull();
  });
});

describe("listAgents", () => {
  it("includes each agent's bound connections via ONE extra grouped query (no N+1)", async () => {
    // First safeQuery: the agents roster. Second safeQuery: the grouped
    // connections-by-agent read that listAgents joins onto the roster.
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [row({ id: "agent-1" }), row({ id: "agent-2" })],
      })
      .mockResolvedValueOnce({
        rows: [
          { agent_id: "agent-1", connector_name: "salesforce" },
          { agent_id: "agent-1", connector_name: "jira" },
        ],
      });
    const agents = await listAgents("ws-1");
    expect(agents.map((a) => a.id)).toEqual(["agent-1", "agent-2"]);
    expect(agents[0].connections).toEqual(["salesforce", "jira"]);
    // agent-2 has no bindings -> empty array, never undefined.
    expect(agents[1].connections).toEqual([]);
    // Exactly two queries total: roster + grouped connections (not N+1).
    expect(mockSafeQuery).toHaveBeenCalledTimes(2);
  });
});

describe("setAgentState", () => {
  it("revokes and stamps revoked_at", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [row({ state: "revoked", revoked_at: "t3" })] });
    const agent = await setAgentState("agent-1", "ws-1", "revoked", { userId: "admin-1", role: "cto" });
    expect(agent?.state).toBe("revoked");
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/revoked_at = NOW\(\)/);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.lifecycle_changed", "admin-1", "cto", { agent_id: "agent-1", state: "revoked" },
    );
  });
});
