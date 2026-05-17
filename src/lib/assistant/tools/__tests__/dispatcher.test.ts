/**
 * Tests for the tool dispatcher (Phase 1 foundation).
 *
 * Covers:
 *   - Intent match cascade (first-match-wins, regex thrower doesn't poison)
 *   - Parameter validation via zod
 *   - Capability gating (role hierarchy)
 *   - Action-tool needs_confirmation refusal
 *   - Handler exception capture
 *   - Analytics emission on every dispatch + per-result
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { z } from "zod";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import {
  registerTool,
  __resetRegistryForTests,
} from "@/lib/assistant/tools/registry";
import type { ToolDef } from "@/lib/assistant/tools/types";

const okHandler = jest.fn(async () => ({
  ok: true as const,
  data: { value: 42 },
  answer: "the answer is 42",
}));

function mkTool(opts: Partial<ToolDef<{ q: string }, { value: number }>> = {}): ToolDef<{ q: string }, { value: number }> {
  return {
    name: opts.name ?? "test_tool",
    description: opts.description ?? "test",
    paramSchema: opts.paramSchema ?? z.object({ q: z.string().min(1) }),
    capability: opts.capability ?? "*",
    requiresConfirmation: opts.requiresConfirmation,
    matchIntent: opts.matchIntent ?? ((m: string) => (m.startsWith("test:") ? { q: m.slice(5) } : null)),
    handler: opts.handler ?? okHandler,
  };
}

const ctx = { userId: "u1", userRole: "dev" };

beforeEach(() => {
  __resetRegistryForTests();
  mockTrack.mockClear();
  okHandler.mockClear();
});

describe("tryDispatchTool — no match", () => {
  test("returns null when registry is empty", async () => {
    const r = await tryDispatchTool("anything", ctx);
    expect(r).toBeNull();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  test("returns null when no tool's intent matches", async () => {
    registerTool(mkTool({ name: "t1" }));
    const r = await tryDispatchTool("unrelated question", ctx);
    expect(r).toBeNull();
  });

  test("ignores empty / whitespace messages", async () => {
    registerTool(mkTool({ name: "t1" }));
    expect(await tryDispatchTool("", ctx)).toBeNull();
    expect(await tryDispatchTool("   ", ctx)).toBeNull();
  });
});

describe("tryDispatchTool — happy path", () => {
  test("dispatches first matching tool + emits analytics", async () => {
    registerTool(mkTool({ name: "first" }));
    const r = await tryDispatchTool("test:hello", ctx);
    expect(r?.tool).toBe("first");
    expect(r?.result.ok).toBe(true);
    if (r?.result.ok) {
      expect(r.result.answer).toBe("the answer is 42");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.tool_invoked",
      "u1",
      "dev",
      expect.objectContaining({ tool: "first", success: true, code: "ok" }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.tool_succeeded",
      "u1",
      "dev",
      expect.objectContaining({ tool: "first" }),
    );
  });

  test("first-match-wins when multiple tools claim the same intent", async () => {
    const handlerA = jest.fn(async () => ({ ok: true as const, data: {value: 1}, answer: "A" }));
    const handlerB = jest.fn(async () => ({ ok: true as const, data: {value: 2}, answer: "B" }));
    registerTool(mkTool({ name: "A", handler: handlerA }));
    registerTool(mkTool({ name: "B", handler: handlerB }));
    const r = await tryDispatchTool("test:both", ctx);
    expect(r?.tool).toBe("A");
    expect(handlerA).toHaveBeenCalled();
    expect(handlerB).not.toHaveBeenCalled();
  });

  test("a tool's matchIntent throwing does NOT silence later tools", async () => {
    const throwing = mkTool({
      name: "throws",
      matchIntent: () => { throw new Error("boom"); },
    });
    const ok = mkTool({ name: "ok" });
    registerTool(throwing);
    registerTool(ok);
    const r = await tryDispatchTool("test:after-thrower", ctx);
    expect(r?.tool).toBe("ok");
  });
});

describe("tryDispatchTool — validation", () => {
  test("validation failure produces ToolFailure code=validation", async () => {
    registerTool(mkTool({
      name: "strict",
      paramSchema: z.object({ q: z.string().min(99) }), // requires very long
    }));
    const r = await tryDispatchTool("test:short", ctx);
    expect(r?.result.ok).toBe(false);
    if (r && !r.result.ok) {
      expect(r.result.code).toBe("validation");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.tool_failed",
      "u1",
      "dev",
      expect.objectContaining({ tool: "strict", code: "validation" }),
    );
  });
});

describe("tryDispatchTool — capability", () => {
  test("returns failure when user role is below required", async () => {
    registerTool(mkTool({ name: "ceo_only", capability: "ceo" }));
    const r = await tryDispatchTool("test:x", { userId: "u1", userRole: "dev" });
    expect(r?.result.ok).toBe(false);
    if (r && !r.result.ok) {
      expect(r.result.code).toBe("capability");
    }
  });

  test("'*' capability accepts any authenticated role", async () => {
    registerTool(mkTool({ name: "open" }));
    const r = await tryDispatchTool("test:x", { userId: "u1", userRole: "viewer" });
    expect(r?.result.ok).toBe(true);
  });

  test("equal-or-higher role passes the gate", async () => {
    registerTool(mkTool({ name: "manager_only", capability: "manager" }));
    const r = await tryDispatchTool("test:x", { userId: "u1", userRole: "cto" });
    expect(r?.result.ok).toBe(true);
  });
});

describe("tryDispatchTool — action confirmation", () => {
  test("action tool with requiresConfirmation refuses on first turn", async () => {
    const handler = jest.fn();
    registerTool(mkTool({
      name: "create_meeting",
      requiresConfirmation: true,
      handler: handler as any,
    }));
    const r = await tryDispatchTool("test:create", ctx);
    expect(r?.result.ok).toBe(false);
    if (r && !r.result.ok) {
      expect(r.result.code).toBe("needs_confirmation");
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("tryDispatchTool — handler exception", () => {
  test("handler throwing → ToolFailure code=internal (never bubbles)", async () => {
    registerTool(mkTool({
      name: "broken",
      handler: async () => { throw new Error("upstream 500"); },
    }));
    const r = await tryDispatchTool("test:x", ctx);
    expect(r?.result.ok).toBe(false);
    if (r && !r.result.ok) {
      expect(r.result.code).toBe("internal");
      expect(r.result.message).toContain("upstream 500");
    }
  });
});

/* ---------------------------------------------------------------------
 * Workflow correlation — ctx.workflowId threads through into every
 * dispatch-side analytics event so the admin dashboard can rebuild
 * funnels (intent → tool → widget render → widget click) from the
 * event stream.
 * --------------------------------------------------------------- */
describe("tryDispatchTool — workflow_id propagation", () => {
  test("includes workflow_id in tool_invoked + tool_succeeded when ctx carries one", async () => {
    registerTool(mkTool({ name: "ok_tool" }));
    await tryDispatchTool("test:x", { ...ctx, workflowId: "wf-abc" });
    const invoked = mockTrack.mock.calls.find((c) => c[0] === "assistant.tool_invoked");
    expect(invoked?.[3]).toMatchObject({ workflow_id: "wf-abc" });
    const succeeded = mockTrack.mock.calls.find((c) => c[0] === "assistant.tool_succeeded");
    expect(succeeded?.[3]).toMatchObject({ workflow_id: "wf-abc" });
  });

  test("omits workflow_id when ctx doesn't carry one (back-compat)", async () => {
    registerTool(mkTool({ name: "ok_tool" }));
    await tryDispatchTool("test:x", ctx);
    const invoked = mockTrack.mock.calls.find((c) => c[0] === "assistant.tool_invoked");
    expect(invoked?.[3]).not.toHaveProperty("workflow_id");
  });

  test("threads workflow_id into tool_failed on validation error", async () => {
    registerTool(mkTool({
      name: "validator",
      paramSchema: z.object({ q: z.string().min(99) }),
    }));
    await tryDispatchTool("test:short", { ...ctx, workflowId: "wf-fail" });
    const failed = mockTrack.mock.calls.find((c) => c[0] === "assistant.tool_failed");
    expect(failed?.[3]).toMatchObject({ workflow_id: "wf-fail" });
  });
});
