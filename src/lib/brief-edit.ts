/**
 * Brief Edit — prompt-to-brief editing for Sites.
 *
 * Flow:
 *   1. User types an instruction ("Make the hero headline 'Season One'").
 *   2. generateBriefEdit() sends the current brief + instruction to Claude
 *      with a strict JSON-patch output contract (RFC 6902 subset).
 *   3. We apply the patch in-memory, validate the result with the existing
 *      validateBrief() so we never land invalid state on the real brief,
 *      and check every patch path against a guardrail allow-list so a
 *      mis-prompted edit can't rename client_slug, swap github_repo, etc.
 *   4. The proposed patch is persisted to instinct_site_brief_edits with
 *      accepted=NULL. The UI shows a diff. The user approves or discards,
 *      which triggers recordBriefEditDecision() to flip the row.
 *
 * Closed-loop: every step (request, success, fail, block, decision) emits
 * a trackEvent so the brain learns which instructions work, which fail,
 * and which users need more guidance. Even guardrail-blocked patches are
 * persisted with accepted=false so the training data includes bad attempts.
 *
 * Zero-tokens-first: the LLM call is the ONLY token cost. The JSON patch
 * apply, guardrail check, and validation are all pure TypeScript.
 */

import { randomUUID, createHash } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { validateBrief, type SiteBrief } from "@/lib/sites";

/* ------------------------------ Types --------------------------------- */

export type JsonPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type JsonPatch = JsonPatchOp[];

export interface BriefEditMetrics {
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

export interface BriefEditResult {
  editId: string;
  patch: JsonPatch;
  renderedBrief: SiteBrief;
  explanation: string;
  metrics: BriefEditMetrics;
}

export interface BriefEditInput {
  projectId: string;
  currentBrief: SiteBrief;
  instruction: string;
  userId: string;
  userRole: string;
  ai?: AICaller;
}

/* ------------------------------ Errors -------------------------------- */

export class BriefEditValidationError extends Error {
  constructor(
    message: string,
    public reason: "patch_blocked" | "brief_invalid" | "bad_ai_output",
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BriefEditValidationError";
  }
}

/**
 * Thrown when the AI backend is configured correctly but the call
 * itself failed (network blip, model overloaded, transient). UI should
 * surface a retryable "try again in a moment" banner.
 */
export class BriefEditAIUnavailableError extends Error {
  constructor(message = "AI caller returned no usable response") {
    super(message);
    this.name = "BriefEditAIUnavailableError";
  }
}

/**
 * Thrown when the AI feature is not configured at all — ANTHROPIC_API_KEY
 * is missing from the environment. No amount of retry will fix it; an
 * admin must add the env var. The UI should surface a DIFFERENT banner
 * that names the env var and tells the user who to ask.
 */
export class BriefEditNotConfiguredError extends Error {
  constructor(message = "ANTHROPIC_API_KEY is not set — AI editor disabled") {
    super(message);
    this.name = "BriefEditNotConfiguredError";
  }
}

/* -------------------------- Constants --------------------------------- */

// claude-haiku-4-5 is fast + cheap for structured JSON output, which is
// what the editor needs. Opus is overkill for a single-instruction patch.
export const BRIEF_EDIT_MODEL = "claude-haiku-4-5-20251001";

// Anthropic list price for Haiku 4.5 (2026-04). Update alongside the model
// string — the number flows into instinct_site_brief_edits.cost_usd for FinOps.
// USD per 1M tokens.
const HAIKU_INPUT_USD_PER_MTOK = 1.0;
const HAIKU_OUTPUT_USD_PER_MTOK = 5.0;

export const MAX_INSTRUCTION_LEN = 2000;

// Allowed top-level patch roots. Anything outside these is a guardrail
// violation — e.g. /client_slug (brief identity), /github_repo (infra).
const ALLOWED_ROOTS = new Set(["/pages", "/client", "/product", "/contactForm", "/theme"]);

// Explicitly blocked paths — even if they sit under an allowed root, we
// refuse to let the editor touch them (belt + suspenders). The directive:
// prompt edits cover *content*, not infrastructure or identity.
const ALWAYS_BLOCKED_EXACT = new Set<string>([
  "/client_slug",
  "/github_repo",
  "/github_repo_url",
  "/preview_url",
  "/status",
  "/last_deploy_id",
  "/id",
]);

/* -------------------------- AI caller --------------------------------- */

export interface AICallResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export type AICaller = (
  systemPrompt: string,
  userText: string,
) => Promise<AICallResult | null>;

export const defaultAICaller: AICaller = async (systemPrompt, userText) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Missing env var is a DIFFERENT failure mode from a flaky API call —
  // surface it as a distinct error so the route can give the user an
  // actionable message instead of "try again in a moment".
  if (!apiKey) throw new BriefEditNotConfiguredError();
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: BRIEF_EDIT_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userText }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      content: data.content?.[0]?.text ?? "",
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
      model: (data.model as string) ?? BRIEF_EDIT_MODEL,
    };
  } catch {
    return null;
  }
};

/* ------------------------- JSON Patch (RFC 6902 subset) --------------- */

function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new BriefEditValidationError(
      `json pointer must start with / (got "${path}")`,
      "bad_ai_output",
    );
  }
  return path
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function applyOp(doc: unknown, op: JsonPatchOp): unknown {
  const tokens = parsePointer(op.path);
  if (tokens.length === 0) {
    // Root replace — technically legal per RFC but we don't allow it since
    // callers should be surgical.
    if (op.op === "replace") return clone((op as { value: unknown }).value);
    throw new BriefEditValidationError(
      "patch ops on root path not supported",
      "bad_ai_output",
    );
  }

  const root = clone(doc);
  let parent: unknown = root;
  // Walk to the parent of the target.
  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    if (Array.isArray(parent)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
        throw new BriefEditValidationError(
          `patch path ${op.path} — array index ${tok} out of range`,
          "bad_ai_output",
        );
      }
      parent = parent[idx];
    } else if (isObj(parent)) {
      if (!(tok in parent)) {
        throw new BriefEditValidationError(
          `patch path ${op.path} — missing segment "${tok}"`,
          "bad_ai_output",
        );
      }
      parent = parent[tok];
    } else {
      throw new BriefEditValidationError(
        `patch path ${op.path} — cannot descend into non-container`,
        "bad_ai_output",
      );
    }
  }

  const last = tokens[tokens.length - 1];

  if (Array.isArray(parent)) {
    const isAppend = last === "-";
    const idx = isAppend ? parent.length : Number(last);
    if (!isAppend && (!Number.isInteger(idx) || idx < 0)) {
      throw new BriefEditValidationError(
        `patch path ${op.path} — invalid array index "${last}"`,
        "bad_ai_output",
      );
    }
    if (op.op === "add") {
      if (isAppend || idx === parent.length) parent.push(op.value);
      else if (idx < parent.length) parent.splice(idx, 0, op.value);
      else
        throw new BriefEditValidationError(
          `patch path ${op.path} — add index ${idx} beyond length ${parent.length}`,
          "bad_ai_output",
        );
    } else if (op.op === "replace") {
      if (idx >= parent.length)
        throw new BriefEditValidationError(
          `patch path ${op.path} — replace index ${idx} out of range`,
          "bad_ai_output",
        );
      parent[idx] = op.value;
    } else if (op.op === "remove") {
      if (idx >= parent.length)
        throw new BriefEditValidationError(
          `patch path ${op.path} — remove index ${idx} out of range`,
          "bad_ai_output",
        );
      parent.splice(idx, 1);
    }
  } else if (isObj(parent)) {
    if (op.op === "add" || op.op === "replace") {
      parent[last] = op.value;
    } else if (op.op === "remove") {
      if (!(last in parent))
        throw new BriefEditValidationError(
          `patch path ${op.path} — cannot remove missing key "${last}"`,
          "bad_ai_output",
        );
      delete parent[last];
    }
  } else {
    throw new BriefEditValidationError(
      `patch path ${op.path} — parent is not an object or array`,
      "bad_ai_output",
    );
  }

  return root;
}

/**
 * Pure function: apply a JSON Patch (RFC 6902 subset: add/replace/remove)
 * to a brief. Empty patch is a no-op round-trip. Operates on a deep clone
 * — never mutates the input.
 */
export function applyPatch(brief: SiteBrief, patch: JsonPatch): SiteBrief {
  if (!Array.isArray(patch))
    throw new BriefEditValidationError(
      "patch must be an array",
      "bad_ai_output",
    );
  if (patch.length === 0) return clone(brief);
  let doc: unknown = brief;
  for (const op of patch) {
    if (!op || typeof op !== "object" || typeof op.path !== "string")
      throw new BriefEditValidationError(
        "patch op missing path",
        "bad_ai_output",
      );
    if (op.op !== "add" && op.op !== "replace" && op.op !== "remove")
      throw new BriefEditValidationError(
        `patch op "${(op as { op?: unknown }).op}" not supported (use add/replace/remove)`,
        "bad_ai_output",
      );
    doc = applyOp(doc, op);
  }
  return doc as SiteBrief;
}

/* ---------------------- Path guardrail ------------------------------- */

function rootOf(path: string): string {
  if (!path.startsWith("/")) return "";
  const rest = path.slice(1);
  const slash = rest.indexOf("/");
  return "/" + (slash === -1 ? rest : rest.slice(0, slash));
}

/**
 * Return the list of patch operations whose target paths are blocked.
 * An empty array means the patch is safe to apply. The caller decides
 * whether to reject outright or record+block.
 */
export function validatePatchPaths(patch: JsonPatch): JsonPatchOp[] {
  const blocked: JsonPatchOp[] = [];
  for (const op of patch) {
    if (!op || typeof op.path !== "string") {
      blocked.push(op);
      continue;
    }
    if (ALWAYS_BLOCKED_EXACT.has(op.path)) {
      blocked.push(op);
      continue;
    }
    const root = rootOf(op.path);
    if (!ALLOWED_ROOTS.has(root)) {
      blocked.push(op);
      continue;
    }
  }
  return blocked;
}

/* ------------------------- Hash helper ------------------------------- */

function hashBrief(brief: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(brief))
    .digest("hex");
}

function computeCostUsd(tokensIn: number, tokensOut: number): number {
  const cost =
    (tokensIn / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK +
    (tokensOut / 1_000_000) * HAIKU_OUTPUT_USD_PER_MTOK;
  // round to 6 decimals to match NUMERIC(10,6) column scale.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/* ------------------------- System prompt ----------------------------- */

const SYSTEM_PROMPT = `You edit structured website briefs for the Wolfpack site template. Given the CURRENT brief (JSON) and an INSTRUCTION (plain English), output a minimal JSON-Patch (RFC 6902) that applies the instruction.

The brief conforms to this TypeScript shape:
interface SiteBrief {
  client: string;                     // lowercase slug — DO NOT change
  product: { name: string; tagline?: string; supportEmail?: string; domain?: string };
  theme?: Record<string, string>;
  pages: Array<{
    route: string;                    // starts with /
    title?: string;
    sections: Array<
      | { type: "hero"; heading: string; body?: string; cta?: { label: string; href: string }; backgroundImage?: string }
      | { type: "text"; heading?: string; body: string }
      | { type: "callout"; body: string }
      | { type: "banner"; heading: string; body?: string }
      | { type: "stats"; heading?: string; items: Array<{ label: string; value: number; suffix?: string; prefix?: string }> }
      | { type: "cards"; heading?: string; items: Array<{ title: string; body?: string; badge?: string; accent?: boolean }> }
      | { type: "gallery"; heading?: string; images: Array<{ src: string; alt?: string }> }
      | { type: "quote"; body: string; attribution?: string }
    >;
  }>;
  contactForm?: { fields: string[] };
}

RULES:
- Patch ops: "add" | "replace" | "remove" only (no move/copy/test).
- Paths MUST be JSON Pointers starting at the brief root (e.g. /pages/0/sections/0/heading).
- NEVER emit ops targeting /client, /client_slug, /id, /github_repo, /preview_url, /status — identity + infra are off-limits.
- Keep the patch minimal: only touch what the instruction asks for.
- If the instruction adds a new section, use an "add" op with the full section object as value.
- stats.items[].value MUST be a number (put units in suffix).

OUTPUT FORMAT (strict):
{
  "patch":      [ ... array of json-patch ops ... ],
  "explanation": "one-sentence plain-english summary of the edit"
}

Output ONLY valid JSON. No markdown fences, no commentary.`;

/* ------------------------ Main entry point --------------------------- */

interface ParsedAIResponse {
  patch: JsonPatch;
  explanation: string;
}

function parseAIResponse(raw: string): ParsedAIResponse {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new BriefEditValidationError(
      "AI response was not valid JSON",
      "bad_ai_output",
    );
  }
  if (!isObj(parsed) || !Array.isArray(parsed.patch)) {
    throw new BriefEditValidationError(
      "AI response missing patch[] array",
      "bad_ai_output",
    );
  }
  return {
    patch: parsed.patch as JsonPatch,
    explanation:
      typeof parsed.explanation === "string" ? parsed.explanation : "",
  };
}

async function insertAuditRow(args: {
  editId: string;
  projectId: string;
  userId: string;
  userRole: string;
  instruction: string;
  patch: JsonPatch;
  beforeHash: string;
  afterHash: string;
  accepted: boolean | null;
  rejectionReason: string | null;
  metrics: BriefEditMetrics;
}): Promise<void> {
  await safeQuery(
    `INSERT INTO instinct_site_brief_edits
       (id, project_id, user_id, user_role, instruction, patch,
        brief_before_hash, brief_after_hash, accepted, rejection_reason,
        latency_ms, tokens_in, tokens_out, cost_usd, model, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
             CASE WHEN $9 IS NULL THEN NULL ELSE NOW() END)`,
    [
      args.editId,
      args.projectId,
      args.userId,
      args.userRole,
      args.instruction,
      JSON.stringify(args.patch),
      args.beforeHash,
      args.afterHash,
      args.accepted,
      args.rejectionReason,
      args.metrics.latencyMs,
      args.metrics.tokensIn,
      args.metrics.tokensOut,
      args.metrics.costUsd,
      args.metrics.model,
    ],
  );
}

/**
 * Generate a brief edit from a plain-English instruction.
 *
 * Success path: inserts an audit row with accepted=NULL and returns the
 * patch + renderedBrief + explanation + metrics. The caller (route) then
 * returns the editId to the UI so the eventual accept/reject decision
 * lands on the same row via recordBriefEditDecision().
 *
 * Failure modes (each is tracked and, where applicable, persisted):
 *   - AI unavailable   → throws BriefEditAIUnavailableError
 *   - Patch blocked    → inserts row with accepted=false + reason;
 *                        throws BriefEditValidationError(reason=patch_blocked)
 *   - Invalid brief    → throws BriefEditValidationError(reason=brief_invalid)
 *   - Bad AI JSON      → throws BriefEditValidationError(reason=bad_ai_output)
 */
export async function generateBriefEdit(
  input: BriefEditInput,
): Promise<BriefEditResult> {
  const { projectId, currentBrief, userId, userRole } = input;
  const instruction = (input.instruction ?? "").slice(0, MAX_INSTRUCTION_LEN);
  const ai = input.ai ?? defaultAICaller;
  const editId = `brief_edit_${randomUUID()}`;
  const beforeHash = hashBrief(currentBrief);

  trackEvent("site.brief_edit_requested", userId, userRole, {
    project_id: projectId,
    instruction_length: instruction.length,
    brief_before_hash: beforeHash,
  });

  const t0 = Date.now();
  const userText = `CURRENT_BRIEF:\n${JSON.stringify(currentBrief)}\n\nINSTRUCTION:\n${instruction}`;

  let aiResult: AICallResult | null;
  try {
    aiResult = await ai(SYSTEM_PROMPT, userText);
  } catch (err) {
    // Missing ANTHROPIC_API_KEY is a config failure, not a model
    // failure. Re-throw it so the route surfaces an actionable
    // error (which env var to set, who to ask) instead of the
    // generic "try again in a moment" retry banner.
    if (err instanceof BriefEditNotConfiguredError) {
      trackEvent("site.brief_edit_failed", userId, userRole, {
        project_id: projectId,
        reason: "ai_not_configured",
        latency_ms: Date.now() - t0,
      });
      throw err;
    }
    aiResult = null;
  }
  const latencyMs = Date.now() - t0;

  if (!aiResult) {
    trackEvent("site.brief_edit_failed", userId, userRole, {
      project_id: projectId,
      reason: "ai_unavailable",
      latency_ms: latencyMs,
    });
    throw new BriefEditAIUnavailableError();
  }

  const metrics: BriefEditMetrics = {
    latencyMs,
    tokensIn: aiResult.tokensIn,
    tokensOut: aiResult.tokensOut,
    costUsd: computeCostUsd(aiResult.tokensIn, aiResult.tokensOut),
    model: aiResult.model || BRIEF_EDIT_MODEL,
  };

  let parsed: ParsedAIResponse;
  try {
    parsed = parseAIResponse(aiResult.content);
  } catch (err) {
    trackEvent("site.brief_edit_failed", userId, userRole, {
      project_id: projectId,
      reason: "bad_ai_output",
      latency_ms: latencyMs,
    });
    throw err;
  }

  // Guardrail check — blocked paths get persisted as bad attempts so the
  // brain learns, then we refuse to apply.
  const blocked = validatePatchPaths(parsed.patch);
  if (blocked.length > 0) {
    const blockedPaths = blocked.map((o) => o.path).filter(Boolean) as string[];
    await insertAuditRow({
      editId,
      projectId,
      userId,
      userRole,
      instruction,
      patch: parsed.patch,
      beforeHash,
      afterHash: beforeHash, // patch never applied
      accepted: false,
      rejectionReason: "patch_blocked",
      metrics,
    });
    trackEvent("site.brief_edit_blocked", userId, userRole, {
      project_id: projectId,
      edit_id: editId,
      blocked_paths: blockedPaths.join(","),
    });
    throw new BriefEditValidationError(
      `patch targets blocked paths: ${blockedPaths.join(", ")}`,
      "patch_blocked",
      { blockedPaths, editId },
    );
  }

  // Apply + validate — if either fails the brief never lands in a bad state.
  let rendered: SiteBrief;
  try {
    rendered = applyPatch(currentBrief, parsed.patch);
    validateBrief(rendered);
  } catch (err) {
    trackEvent("site.brief_edit_failed", userId, userRole, {
      project_id: projectId,
      reason: "brief_invalid",
      latency_ms: latencyMs,
    });
    throw new BriefEditValidationError(
      `patch produced an invalid brief: ${(err as Error).message}`,
      "brief_invalid",
      { editId },
    );
  }

  const afterHash = hashBrief(rendered);

  await insertAuditRow({
    editId,
    projectId,
    userId,
    userRole,
    instruction,
    patch: parsed.patch,
    beforeHash,
    afterHash,
    accepted: null,
    rejectionReason: null,
    metrics,
  });

  trackEvent("site.brief_edit_generated", userId, userRole, {
    project_id: projectId,
    edit_id: editId,
    patch_op_count: parsed.patch.length,
    tokens_in: metrics.tokensIn,
    tokens_out: metrics.tokensOut,
    cost_usd: metrics.costUsd,
    latency_ms: metrics.latencyMs,
    model: metrics.model,
  });

  return {
    editId,
    patch: parsed.patch,
    renderedBrief: rendered,
    explanation: parsed.explanation,
    metrics,
  };
}

/* ---------------------- Decision recording --------------------------- */

export interface RecordDecisionResult {
  projectId: string | null;
}

/**
 * Mark a brief edit row as accepted/rejected. Called by the PATCH route
 * when the user approves or discards the proposed edit in the UI. Emits
 * site.brief_edit_decided regardless of outcome so the brain sees the
 * full request → decision lifecycle.
 */
export async function recordBriefEditDecision(
  editId: string,
  accepted: boolean,
  userId: string,
  userRole: string,
  rejectionReason?: string,
): Promise<RecordDecisionResult> {
  const reason = accepted ? null : (rejectionReason ?? "user_rejected");
  const result = await safeQuery<{ project_id: string }>(
    `UPDATE instinct_site_brief_edits
        SET accepted = $2,
            rejection_reason = $3,
            decided_at = NOW()
      WHERE id = $1
      RETURNING project_id`,
    [editId, accepted, reason],
  );
  const projectId = result.rows[0]?.project_id ?? null;

  trackEvent("site.brief_edit_decided", userId, userRole, {
    project_id: projectId ?? "",
    edit_id: editId,
    accepted,
    rejection_reason: reason ?? "",
  });

  return { projectId };
}
