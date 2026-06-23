/**
 * Dispatcher running as an agent principal. Proves the two things Phase B adds:
 *   1. Attribution: an agent's tool dispatch is authorized under the agent's own
 *      identity (principal.agent === agentId), not the shared assistant id.
 *   2. Enforcement: for an agent the OGIAM gate runs in ENFORCE mode, so a
 *      high-risk action is actually refused, while the same action on the human
 *      path runs in monitor mode and is not OGIAM-blocked.
 */

// Capture every OGIAM decision without a database. Keep the real hash helpers.
const mockRecordDecision = jest.fn((..._args: unknown[]) => Promise.resolve(null));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { z } from "zod";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import { registerTool, __resetRegistryForTests } from "@/lib/assistant/tools/registry";
import type { ToolContext } from "@/lib/assistant/tools/types";

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

  it("does NOT OGIAM-block the same mutation on the human path (monitor mode)", async () => {
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
  });
});
