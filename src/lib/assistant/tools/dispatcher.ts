/**
 * Tool dispatcher — runs the intent → params → validation → capability
 * → handler → audit + analytics pipeline.
 *
 * Called by `chat()` as Priority 0 (before knowledge cache / brain /
 * AI). Returns null when no tool's intent matches → chat() falls
 * through to the existing priority chain.
 *
 * Hard rules:
 *   - Tool handlers NEVER throw. The dispatcher catches anything
 *     escaping a handler and converts to a structured ToolFailure.
 *   - Every dispatch attempt (match + execute) emits typed analytics
 *     so the learning loop has full visibility.
 *   - Read-only tools (default) execute directly. Action tools must
 *     have `requiresConfirmation = true` so the dispatcher returns a
 *     `needs_confirmation` failure instead of mutating state on the
 *     first turn. (Phase 3 wires the confirm-then-execute flow.)
 */

import { trackEvent } from "@/lib/analytics";
import { getTools } from "./registry";
import type {
  ToolContext,
  ToolDef,
  ToolDispatchResult,
  ToolFailure,
  ToolResult,
} from "./types";

/**
 * Try to dispatch a tool for the given message. Returns the result of
 * the FIRST tool whose intent matches, or null if no tool matched.
 *
 * The dispatcher always returns a result object when a match is found
 * — even on failure — so the caller can distinguish:
 *   - null            → fall through to next priority
 *   - {result.ok:true}  → render the tool's answer + sources
 *   - {result.ok:false} → surface the failure (validation, capability,
 *                          internal) to the user with a deterministic
 *                          message; never call the LLM in this branch.
 */
export async function tryDispatchTool(
  message: string,
  ctx: ToolContext,
): Promise<ToolDispatchResult | null> {
  if (!message || message.trim().length === 0) return null;

  const tools = getTools();
  for (const tool of tools) {
    const params = safeMatchIntent(tool, message);
    if (params === null) continue;

    const started = Date.now();
    const result = await runOneTool(tool, params, ctx);
    const durationMs = Date.now() - started;

    /* workflow_id correlates this dispatch back to the user message
     * that triggered it — same id is on the intent_unmatched event
     * (when it would have fired) + every widget interaction the
     * resulting render produces. Optional so legacy callers that
     * don't generate one still work. */
    const wid = ctx.workflowId;
    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: tool.name,
      success: result.ok,
      code: result.ok ? "ok" : result.code,
      duration_ms: durationMs,
      ...(wid ? { workflow_id: wid } : {}),
    });
    if (!result.ok) {
      trackEvent("assistant.tool_failed", ctx.userId, ctx.userRole, {
        tool: tool.name,
        code: result.code,
        message: result.message.slice(0, 200),
        ...(wid ? { workflow_id: wid } : {}),
      });
    } else {
      trackEvent("assistant.tool_succeeded", ctx.userId, ctx.userRole, {
        tool: tool.name,
        duration_ms: durationMs,
        ...(wid ? { workflow_id: wid } : {}),
      });
    }

    return { tool: tool.name, result, durationMs };
  }

  return null;
}

/** Bullet-proof matchIntent invocation — a tool that throws in its
 *  intent classifier MUST NOT silence later tools. */
function safeMatchIntent<P>(
  tool: ToolDef<P, unknown>,
  message: string,
): P | null {
  try {
    return tool.matchIntent(message);
  } catch {
    return null;
  }
}

async function runOneTool<P, R>(
  tool: ToolDef<P, R>,
  rawParams: unknown,
  ctx: ToolContext,
): Promise<ToolResult<R>> {
  /* 1. Validate parameters against the zod schema. */
  const parsed = tool.paramSchema.safeParse(rawParams);
  if (!parsed.success) {
    return failure(
      "validation",
      `parameters failed validation for ${tool.name}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  /* 2. Capability gate. "*" = any authenticated user (just need a
        userId, which the chat surface already enforces). */
  if (tool.capability !== "*") {
    /* The capability registry lives in src/lib/auth/require-capability.ts.
       For the Phase-1 read-only tools we keep this simple: role-string
       gating. Phase 3 promotes to full requireCapability when action
       tools land. */
    const ROLE_HIERARCHY: Record<string, number> = {
      ceo: 100, cto: 95, evp: 80, vp: 70,
      lead: 60, manager: 55, dev: 40, sales: 30, ops: 30, hr: 30,
      viewer: 10, member: 10,
    };
    const need = ROLE_HIERARCHY[tool.capability] ?? 0;
    const have = ROLE_HIERARCHY[ctx.userRole.toLowerCase()] ?? 0;
    if (have < need) {
      return failure(
        "capability",
        `tool ${tool.name} requires role ≥ ${tool.capability} (you have ${ctx.userRole})`,
      );
    }
  }

  /* 3. Action-tool confirmation gate. Action tools MUST set
        requiresConfirmation = true so we never silently mutate on
        the first turn. */
  if (tool.requiresConfirmation) {
    return failure(
      "needs_confirmation",
      `tool ${tool.name} mutates state and needs explicit confirmation`,
    );
  }

  /* 4. Execute. Tool handlers should never throw — but we guard. */
  try {
    return await tool.handler(parsed.data, ctx);
  } catch (err) {
    return failure(
      "internal",
      `tool ${tool.name} threw: ${(err as Error)?.message ?? "unknown"}`,
    );
  }
}

function failure(
  code: ToolFailure["code"],
  message: string,
): ToolFailure {
  return { ok: false, code, message };
}
