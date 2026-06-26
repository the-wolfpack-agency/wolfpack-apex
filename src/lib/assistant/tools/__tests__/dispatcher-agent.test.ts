/**
 * Dispatcher running as an agent principal. Proves the two things Phase B adds:
 *   1. Attribution: an agent's tool dispatch is authorized under the agent's own
 *      identity (principal.agent === agentId), not the shared assistant id.
 *   2. Enforcement: for an agent the OGIAM gate runs in ENFORCE mode, so a
 *      high-risk action is actually refused, while the same action on the human
 *      path runs in monitor mode and is not OGIAM-blocked.
 */

// Capture every OGIAM decision without a database. Keep the real hash helpers.
const mockRecordDecision = jest.fn(
  (..._args: unknown[]): Promise<{ id: string; seq: number; entryHash: string } | null> =>
    Promise.resolve({ id: "d_test", seq: 1, entryHash: "h" }),
);
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const mockNotify = jest.fn(
  (..._a: unknown[]): Promise<{ id: string } | { deduped: true }> => Promise.resolve({ id: "n-1" }),
);
jest.mock("@/lib/notifications/in-app", () => ({ notify: (...a: unknown[]) => mockNotify(...a) }));

import { z } from "zod";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";
import { trackEvent } from "@/lib/analytics";

function tool(name: string, opts: { capability?: string; mutation?: boolean; match: string }) {
  registerTool({
    name,
    description: name,
    capability: opts.capability ?? "*",
    requiresConfirmation: Boolean(opts.mutation),
    paramSchema: z.object({}).passthrough(),
    matchIntent: (m: string) => (m.includes(opts.match) ? {} : null),
    handler: async () => ({ ok: true as const, data: { ran: name }, answer: "done", sources: [] }),
  });
}

const agentCtx: ToolContext = {
  userId: "agent-1",
  userRole: "ops",
  workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};
const humanCtx: ToolContext = { userId: "u1", userRole: "cto", workspaceId: "ws-1" };

beforeEach(() => {
  __resetRegistryForTests();
  mockRecordDecision.mockClear();
  mockNotify.mockClear();
  mockNotify.mockResolvedValue({ id: "n-1" });
  tool("read_status", { match: "status" });
  tool("delete_everything", { mutation: true, match: "delete" });
});

describe("agent dispatch attribution", () => {
  it("authorizes a benign read under the agent's own identity and lets it run", async () => {
    const res = await tryDispatchTool("show status", agentCtx);
    expect(res?.result.ok).toBe(true);
    expect(mockRecordDecision).toHaveBeenCalled();
    const arg = mockRecordDecision.mock.calls[0][0] as {
      principal: { agent: string; ownerUserId?: string };
      decision: { mode: string; intendedOutcome: string };
    };
    expect(arg.principal.agent).toBe("agent-1");
    expect(arg.principal.ownerUserId).toBe("owner-1");
    expect(arg.decision.mode).toBe("enforce");
    expect(arg.decision.intendedOutcome).toBe("allow");
  });
});

describe("agent enforcement", () => {
  it("refuses a high-risk mutation by an agent (OGIAM enforce block)", async () => {
    const res = await tryDispatchTool("delete the records", agentCtx);
    expect(res?.result.ok).toBe(false);
    if (res && !res.result.ok) {
      expect(res.result.code).toBe("capability");
      expect(res.result.message).toMatch(/OGIAM/);
    }
  });

  it("HUMAN ALERTING: an enforce-mode agent block notifies the agent's owner, high priority, naming the agent + tool", async () => {
    const res = await tryDispatchTool("delete the records", agentCtx);
    expect(res?.result.ok).toBe(false);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        priority: "high",
        category: "security",
        source: "agent_action_blocked",
        title: expect.stringMatching(/blocked/i),
        body: expect.stringContaining("delete_everything"),
        metadata: expect.objectContaining({ agent_id: "agent-1", tool: "delete_everything" }),
      }),
    );
  });

  it("HUMAN ALERTING: a MONITOR-mode (human) block does NOT notify — a human in monitor mode is never spammed", async () => {
    const res = await tryDispatchTool("delete the records", humanCtx);
    // The human path runs OGIAM in monitor (no block); the mutation is instead
    // bounced by the legacy confirmation gate, a different code than the agent
    // enforce block. This proves the two paths differ exactly as intended.
    expect(res?.result.ok).toBe(false);
    if (res && !res.result.ok) {
      expect(res.result.code).toBe("needs_confirmation");
    }
    const arg = mockRecordDecision.mock.calls[0][0] as { decision: { mode: string } };
    expect(arg.decision.mode).toBe("monitor");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("HUMAN ALERTING: a notify throw does not break the agent block (best effort)", async () => {
    mockNotify.mockRejectedValue(new Error("notifications down"));
    const res = await tryDispatchTool("delete the records", agentCtx);
    // The block still stands with the same code despite the notify failure.
    expect(res?.result.ok).toBe(false);
    if (res && !res.result.ok) {
      expect(res.result.code).toBe("capability");
      expect(res.result.message).toMatch(/OGIAM/);
    }
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});

describe("human-only tools are never invoked by an agent", () => {
  beforeEach(() => {
    // A human-only tool (like delegate_to_agent) that also matches "handle",
    // registered BEFORE a real work tool that matches the same phrase.
    registerTool({
      name: "delegate_like",
      description: "human-only delegation",
      capability: "*",
      requiresConfirmation: false,
      humanOnly: true,
      paramSchema: z.object({}).passthrough(),
      matchIntent: (m: string) => (m.includes("handle") ? {} : null),
      handler: async () => ({ ok: false as const, code: "internal" as const, message: "should not run for an agent" }),
    });
    tool("do_handle_work", { match: "handle" });
  });

  it("skips the human-only tool for an agent and falls through to the work tool", async () => {
    const res = await tryDispatchTool("handle this", agentCtx);
    expect(res?.tool).toBe("do_handle_work");
    expect(res?.result.ok).toBe(true);
  });

  it("still lets a human invoke the human-only tool", async () => {
    const res = await tryDispatchTool("handle this", humanCtx);
    expect(res?.tool).toBe("delegate_like");
  });
});

describe("fail closed when a decision cannot be audited (enforce)", () => {
  it("blocks the agent action, never runs the tool, and records the block when the ledger write fails", async () => {
    mockRecordDecision.mockResolvedValue(null); // ledger unavailable -> unauditable in enforce
    const res = await tryDispatchTool("show status", agentCtx);
    expect(res?.result.ok).toBe(false);
    if (res && !res.result.ok) {
      expect(res.result.code).toBe("internal");
      expect(res.result.message).toMatch(/could not be audited/i);
    }
    // The block is captured off-ledger (best effort) so the data is not lost.
    expect(trackEvent).toHaveBeenCalledWith(
      "ogiam.action_blocked_unauditable",
      "agent-1",
      "ops",
      expect.objectContaining({ tool: "read_status" }),
    );
    // HUMAN ALERTING: the owner is also notified of the fail-closed block.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-1",
        priority: "high",
        source: "agent_action_blocked",
        metadata: expect.objectContaining({ agent_id: "agent-1", tool: "read_status" }),
      }),
    );
  });

  it("the human (monitor) path still runs when the ledger write fails (untouched)", async () => {
    mockRecordDecision.mockResolvedValue(null);
    const res = await tryDispatchTool("show status", humanCtx);
    expect(res?.result.ok).toBe(true);
  });
});
