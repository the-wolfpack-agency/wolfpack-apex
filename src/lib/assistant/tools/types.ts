/**
 * Shared types for the Assistant tool-calling registry.
 *
 * A "tool" is a deterministic, zero-AI-token function the Assistant
 * can dispatch in response to a user question. Tools answer
 * parameterized questions (e.g. "what do we know about <subject>",
 * "did <client> pay this month") by reading from a typed data source
 * — RAG over Brain docs, the org-facts table, a CRM, a calendar,
 * etc. — and returning structured results the LLM (or a fixed
 * template) renders for the user.
 *
 * Design principles:
 *   - Zero tokens by default. The LLM is only consulted if NO tool
 *     intent matches (existing chat() fallthrough).
 *   - Every tool declares its parameter schema (zod) so calls are
 *     validated before the handler runs — never trust the LLM's
 *     argument generation.
 *   - Every tool declares the capability needed to invoke it. A
 *     tool that mutates state requires a stronger capability than
 *     a tool that reads. Capability checks happen in the dispatcher,
 *     not the handler.
 *   - Every dispatch emits typed analytics (`assistant.tool_invoked`)
 *     so the learning loop sees which tools fire and how often.
 *   - Action-tools (mutations) MUST set `requiresConfirmation = true`
 *     so the dispatcher knows to render an "are you sure" gate
 *     instead of executing immediately. (Reserved for Phase 3 —
 *     Phase 1 ships read-only tools only.)
 */

import type { ZodSchema } from "zod";
import type { AssistantSourceRef } from "@/lib/assistant";

export interface ToolContext {
  /** Authenticated user firing the question. */
  userId: string;
  /** User's role (cto, ceo, evp, dev, sales, ops, hr, ...). */
  userRole: string;
  /** User's email (optional — present when the auth layer surfaced it). */
  userEmail?: string;
}

/** Successful tool dispatch — the handler ran and produced data. */
export interface ToolSuccess<R> {
  ok: true;
  /** Structured handler output (tool-specific shape). */
  data: R;
  /** A formatted, user-facing answer string (rendered into the chat). */
  answer: string;
  /** Optional source citations for the answer (Knowledge / Brain / etc). */
  sources?: AssistantSourceRef[];
}

/** Failed tool dispatch — explicit failure code so the caller can react. */
export interface ToolFailure {
  ok: false;
  /** Failure category. The dispatcher maps each to a typed analytics event. */
  code:
    | "validation"
    | "capability"
    | "no_match"
    | "needs_confirmation"
    | "internal";
  message: string;
}

export type ToolResult<R> = ToolSuccess<R> | ToolFailure;

/**
 * The full tool definition. Each tool exports one of these + calls
 * `registerTool(...)` at module load time.
 */
export interface ToolDef<P, R> {
  /** Stable identifier, snake_case. Used in analytics + audit. */
  name: string;
  /** One-line description shown to the LLM in the available-tools manifest. */
  description: string;
  /** Zod schema validating the parameter shape before the handler runs. */
  paramSchema: ZodSchema<P>;
  /**
   * Capability required to invoke. "*" = any authenticated user.
   * Anything else maps to an entry in the existing requireCapability
   * registry (auth/require-capability.ts).
   */
  capability: string;
  /**
   * Action tools (mutations) MUST set this true. Phase 1 ships only
   * read-only tools — confirmation flow lands in Phase 3.
   */
  requiresConfirmation?: boolean;
  /**
   * Intent classifier — return parsed params when the message looks
   * like a call to this tool, else null. Regex-based + zero-token.
   * If multiple tools match, the FIRST registered wins (so ordering
   * in registry.ts matters).
   */
  matchIntent(message: string): P | null;
  /** Tool execution. Returns ToolResult. Never throws. */
  handler(params: P, ctx: ToolContext): Promise<ToolResult<R>>;
}

/** What the dispatcher hands back to chat(). */
export interface ToolDispatchResult {
  tool: string;
  result: ToolResult<unknown>;
  /** Wall-clock duration so the learning loop can budget. */
  durationMs: number;
}
