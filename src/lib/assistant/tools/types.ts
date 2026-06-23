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
import type { FormSpec } from "@/lib/assistant/forms/types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

/**
 * IP-geolocation snapshot resolved from Vercel's edge headers
 * (x-vercel-ip-city, x-vercel-ip-country, x-vercel-ip-latitude,
 * x-vercel-ip-longitude). Populated by the route handler on every
 * authenticated turn; tools read it when the user's prompt didn't
 * carry an explicit location (e.g. bare "weather"). Skip the geo
 * round-trip and answer for the user's actual city. Absent on local
 * dev / non-Vercel deployments — tools must treat geo as best-effort
 * and degrade gracefully when it's missing.
 */
export interface VercelGeo {
  city?: string;
  country?: string;
  /** Decimal degrees, e.g. 40.7128. */
  latitude?: number;
  /** Decimal degrees, e.g. -74.006. */
  longitude?: number;
}

export interface ToolContext {
  /** Authenticated user firing the question. */
  userId: string;
  /** User's role (cto, ceo, evp, dev, sales, ops, hr, ...). */
  userRole: string;
  /**
   * Set when this dispatch is being driven by an AGENT principal rather than a
   * human. When present, the OGIAM gate runs in enforce mode and attributes the
   * decision to the agent's identity, so the agent's actions are governed and
   * traceable under its own principal. Absent for normal human assistant turns.
   */
  agentPrincipal?: {
    agentId: string;
    role: string;
    workspaceId: string;
    ownerUserId: string;
  };
  /** User's email (optional — present when the auth layer surfaced it). */
  userEmail?: string;
  /**
   * Workspace the user is acting on behalf of. Drives per-tenant
   * connector credential lookup. Defaults to "default" when the
   * deployment is single-workspace. Multi-tenant deployments
   * resolve this from the session.
   */
  workspaceId?: string;
  /**
   * Stable identifier for this assistant turn (one user message →
   * its tool call(s) → its widget renders → its form submit).
   * Lets the analytics layer correlate events into funnels:
   *   intent_unmatched → tool_invoked → widget_offered → widget_rendered
   *   → widget_interaction → form_submitted
   * all sharing the same workflow_id.
   * UUID v4; generated at the top of chat() and threaded through.
   */
  workflowId?: string;
  /**
   * Best-effort IP geolocation of the requester, sourced from Vercel
   * edge headers in the route handler. Tools use it as the location
   * fallback when the prompt didn't carry an explicit city — fixes
   * the bug where a NYC user typing "weather" got Houston because
   * the tool's default location was hard-coded. Always optional;
   * tools that need a city when geo is missing must surface a
   * friendly "tell me a city" message rather than guessing.
   */
  geo?: VercelGeo;
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
  /** When set, the chat surface renders an inline form below `answer`.
   *  Used by the "create email / message / calendar event / task"
   *  tools — the answer is a one-line intro ("Fill in the details
   *  below…") and the form captures the structured input. */
  form?: FormSpec;
  /** When set, the chat surface renders an interactive widget below
   *  `answer`. Used by calendar / email-thread / task-list / etc.
   *  tools so the user can act inside the chat (click a day, click
   *  out to a detail page) instead of leaving for another app. */
  widget?: WidgetSpec;
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
   * Human-only tools (e.g. delegate_to_agent) must never be invoked BY an
   * agent principal. When set, the dispatcher skips this tool for an agent
   * caller so the instruction falls through to a real work tool. This also
   * prevents agent-to-agent delegation chains, a privilege-escalation path.
   */
  humanOnly?: boolean;
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
