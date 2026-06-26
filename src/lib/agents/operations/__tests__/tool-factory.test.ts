/**
 * Operation tool factory. Proves a declarative AgentOperation becomes a real,
 * agent-only assistant tool with NO per-function handler code:
 *   - op_create_qr_code matches the QR phrasing and extracts the field values;
 *   - its success result carries the `operation` descriptor the executor needs;
 *   - it is agentOnly, so the dispatcher fires it for an agent and SKIPS it for
 *     a human (who uses the real QR UI).
 */

const mockRecordDecision = jest.fn((..._args: unknown[]) => Promise.resolve({ id: "d_test", seq: 1, entryHash: "h" }));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import {
  getToolByName,
  __resetRegistryForTests,
} from "@/lib/assistant/tools/registry";
import { registerOperationTools, buildValues } from "@/lib/agents/operations/tool-factory";
import { AGENT_OPERATIONS } from "@/lib/agents/operations/registry";
import type { ToolContext, ToolSuccess } from "@/lib/assistant/tools/types";

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
  registerOperationTools();
});

const QR_INSTRUCTION = "Create a QR code titled AGENT1 that is linked to ogiam.com";

describe("buildValues", () => {
  it("extracts the operation's declared fields from the instruction", () => {
    const op = AGENT_OPERATIONS.find((o) => o.id === "create_qr_code")!;
    expect(buildValues(QR_INSTRUCTION, op)).toEqual({
      label: "AGENT1",
      targetUrl: "https://ogiam.com",
    });
  });
});

describe("registerOperationTools", () => {
  it("registers an agent-only op_<id> tool for every operation", () => {
    for (const op of AGENT_OPERATIONS) {
      const tool = getToolByName(`op_${op.id}`);
      expect(tool).not.toBeNull();
      expect(tool?.agentOnly).toBe(true);
      expect(tool?.requiresConfirmation).toBe(false);
      expect(tool?.capability).toBe(op.capability);
    }
  });

  it("op_create_qr_code matches the QR phrasing and yields the extracted values", () => {
    const tool = getToolByName("op_create_qr_code")!;
    const params = tool.matchIntent(QR_INSTRUCTION);
    expect(params).toEqual({ label: "AGENT1", targetUrl: "https://ogiam.com" });
  });

  it("does not match unrelated phrasing", () => {
    const tool = getToolByName("op_create_qr_code")!;
    expect(tool.matchIntent("send an email to the team")).toBeNull();
  });
});

const SCAN_INSTRUCTION =
  "scan the internet for the latest news on auto SAAS companies";

describe("op_web_search", () => {
  it("is registered as an agent-only tool", () => {
    const tool = getToolByName("op_web_search");
    expect(tool).not.toBeNull();
    expect(tool?.agentOnly).toBe(true);
    expect(tool?.capability).toBe("*");
  });

  it("matches the 'scan the internet for X' example and extracts the query", () => {
    const tool = getToolByName("op_web_search")!;
    const params = tool.matchIntent(SCAN_INSTRUCTION);
    expect(params).toEqual({
      query: "the latest news on auto SAAS companies",
    });
  });

  it("matches 'search the web for X'", () => {
    const tool = getToolByName("op_web_search")!;
    expect(tool.matchIntent("search the web for Tesla earnings")).toEqual({
      query: "Tesla earnings",
    });
  });

  it("matches 'look X up online'", () => {
    const tool = getToolByName("op_web_search")!;
    const params = tool.matchIntent("look up the GDP of France online");
    expect(params).toEqual({ query: "the GDP of France" });
  });

  it("does NOT swallow a bare 'create a task' instruction", () => {
    const tool = getToolByName("op_web_search")!;
    expect(tool.matchIntent("create a task to follow up with the client")).toBeNull();
  });

  it("carries the /api/web-search operation descriptor on success", async () => {
    const res = await tryDispatchTool(SCAN_INSTRUCTION, agentCtx);
    expect(res?.tool).toBe("op_web_search");
    expect(res?.result.ok).toBe(true);
    const success = res!.result as ToolSuccess<unknown>;
    expect(success.operation).toEqual({
      id: "web_search",
      method: "POST",
      path: "/api/web-search",
      values: { query: "the latest news on auto SAAS companies" },
      required: ["query"],
    });
  });
});

describe("dispatch routing", () => {
  it("an AGENT dispatch routes to op_create_qr_code and returns the operation descriptor", async () => {
    const res = await tryDispatchTool(QR_INSTRUCTION, agentCtx);
    expect(res?.tool).toBe("op_create_qr_code");
    expect(res?.result.ok).toBe(true);
    const success = res!.result as ToolSuccess<unknown>;
    expect(success.operation).toEqual({
      id: "create_qr_code",
      method: "POST",
      path: "/api/qr",
      values: { label: "AGENT1", targetUrl: "https://ogiam.com" },
      required: ["targetUrl"],
    });
  });

  it("a HUMAN dispatch SKIPS the agent-only op tool (falls through to no match here)", async () => {
    // With only the operation tools registered, a human's QR instruction matches
    // nothing (the op tool is skipped), so the dispatcher returns null and the
    // human flow would reach the real product UI / LLM instead.
    const res = await tryDispatchTool(QR_INSTRUCTION, humanCtx);
    expect(res).toBeNull();
  });
});
