/**
 * save_team_fact action tool — Phase 3's first action tool.
 *
 * Lets a user TEACH the Assistant a structured fact:
 *   "Remember that Acme's primary contact is Jorge"
 *   "Save that the Q3 launch date is August 12"
 *   "Note: the Wolfpack Weekly meets every Tuesday at 2pm"
 *
 * Writes to instinct_org_facts via the same path the learning-loop
 * uses for correction capture. Why this is the right FIRST action
 * tool:
 *
 *   - Zero external dependencies (no MS Graph, no vendor SDK, no
 *     IRC/email side-effects). Proves the confirmation flow without
 *     side-effects that complicate rollback.
 *   - The write path (instinct_org_facts) is already RLS-isolated and
 *     hardened against poisoning (see learning.ts: ALLOWED_FACT_ROLES,
 *     sanitizeFactValue, isAllowedFactValue, isUnderRateLimit).
 *   - Genuinely useful: the user gets immediate value teaching the
 *     Assistant.
 */

import { z } from "zod";
import { safeQuery } from "@/lib/db";
import { sanitizeFactValue, isAllowedFactValue } from "@/lib/assistant/learning";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  subject: z.string().min(2).max(120),
  attribute: z.string().min(2).max(60),
  value: z.string().min(1).max(500),
});
type Params = z.infer<typeof ParamSchema>;

interface SavedFactData {
  subject: string;
  attribute: string;
  value: string;
  /** Echoed back when the action runs in confirmation mode. */
  description: string;
}

/* Intent patterns:
   - "remember that <subject> <verb> <value>"  (the most common)
   - "save that <subject>'s <attribute> is <value>"
   - "note: <subject> <attribute>: <value>"
   - "i want to record / save / store / note <something>" — fallback */
const PATTERNS: Array<{ re: RegExp; build(m: RegExpExecArray): Params | null }> = [
  {
    /* "remember/save/note that <subject>'s <attribute> is <value>" */
    re: /^(?:remember|save|store|note|please\s+(?:remember|save|note))(?:\s+that)?\s+(.{2,80}?)(?:'s|\bis|\bare|\bwas|\bwere|\bhas|\bhave|\b—|\b-|\bnow|\bnext)\s+(?:the\s+)?(.{2,60}?)\s+(?:is|are|was|were|=|to be)\s+(.{1,300}?)\.?$/i,
    build: (m) => ({
      subject: m[1].trim(),
      attribute: m[2].trim(),
      value: m[3].trim(),
    }),
  },
  {
    /* "remember that <subject> <verb> <object>".
     *
     * THE WAY PEOPLE STATE AN ORG FACT. The two patterns around this one both
     * require a copula: "Jorge IS the owner", "his role IS x". Nobody says
     * that. They say "Jorge owns the Porsche account", "Ashley runs the
     * evals", "Sam handles PCNA". Measured 2026-08-27, that sentence reached
     * filter_external_records, which read it as a CRM query and answered
     * confidently about the wrong thing.
     *
     * The verb becomes the attribute, so "owns" is stored as the relationship
     * rather than flattened into a copula the speaker never used. */
    re: /^(?:remember|save|store|note|please\s+(?:remember|save|note))(?:\s+that)?\s+(.{2,80}?)\s+(owns|manages|runs|leads|handles|oversees|reports\s+to|works\s+on|is\s+responsible\s+for)\s+(?:the\s+)?(.{2,200}?)\.?$/i,
    build: (m) => ({
      subject: m[1].trim(),
      attribute: m[2].trim().toLowerCase(),
      value: m[3].trim(),
    }),
  },
  {
    /* "remember/save that <subject> <attribute>: <value>" (colon form) */
    re: /^(?:remember|save|store|note)(?:\s+that)?\s+(.{2,80}?)\s+(.{2,60}?):\s+(.{1,300}?)\.?$/i,
    build: (m) => ({
      subject: m[1].trim(),
      attribute: m[2].trim(),
      value: m[3].trim(),
    }),
  },
];

function matchSaveFactIntent(message: string): Params | null {
  const trimmed = message.trim();
  for (const { re, build } of PATTERNS) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const built = build(m);
    if (!built) continue;
    /* Normalize the attribute to snake_case-ish so future lookups
       match consistently. */
    built.attribute = built.attribute
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 60);
    if (built.attribute.length < 2) continue;
    return built;
  }
  return null;
}

/**
 * Direct DB write (used when the user CONFIRMS). Bypasses
 * captureFactFromCorrection because that path requires a "correction"
 * shape (prior assistant content, user message that LOOKS like a
 * correction). Here the user explicitly asked to save the fact.
 *
 * Reuses the same sanitizers + value-allowlist + table schema so
 * downstream rendering and the learning-loop pipeline see no
 * difference between action-tool writes and correction writes.
 */
export async function persistTeamFact(args: {
  userId: string;
  userRole: string;
  subject: string;
  attribute: string;
  value: string;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: "shadow_mode" };
  }
  const cleanSubject = sanitizeFactValue(args.subject);
  const cleanValue = sanitizeFactValue(args.value);
  if (!cleanSubject) return { ok: false, reason: "empty_subject" };
  if (!isAllowedFactValue(cleanValue)) return { ok: false, reason: "blocked_value" };
  const subjectNormalized = cleanSubject.toLowerCase().replace(/\s+/g, " ").trim();
  try {
    const r = await safeQuery<{ id: string }>(
      `INSERT INTO instinct_org_facts
         (subject, subject_normalized, attribute, value,
          source_message_id, source_user_id, source_user_role)
       VALUES ($1, $2, $3, $4, NULL, $5, $6)
       RETURNING id`,
      [
        cleanSubject,
        subjectNormalized,
        args.attribute,
        cleanValue,
        args.userId,
        args.userRole,
      ],
    );
    /* Supersede any prior fact for the same (subject, attribute). */
    if (r.rows[0]) {
      await safeQuery(
        `UPDATE instinct_org_facts
            SET superseded_by = $1
          WHERE subject_normalized = $2
            AND attribute = $3
            AND id <> $1
            AND superseded_by IS NULL`,
        [r.rows[0].id, subjectNormalized, args.attribute],
      );
    }
    return { ok: true, id: r.rows[0]?.id ?? "" };
  } catch (err) {
    return {
      ok: false,
      reason: `db_error: ${(err as Error)?.message ?? "unknown"}`,
    };
  }
}

export const saveTeamFactTool: ToolDef<Params, SavedFactData> = {
  name: "save_team_fact",
  description:
    "Save a verified team fact (subject → attribute: value) to the org-wide knowledge.",
  paramSchema: ParamSchema,
  capability: "*",
  requiresConfirmation: true, // Phase-3 action gate
  matchIntent: matchSaveFactIntent,
  async handler(params, _ctx): Promise<ToolResult<SavedFactData>> {
    /* Handler should never actually run on first dispatch — the
       dispatcher's requiresConfirmation gate returns
       needs_confirmation BEFORE this body executes. When chat()
       re-invokes after a user confirmation, it calls
       persistTeamFact() directly. We still return a well-formed
       result here in case a future path bypasses the gate. */
    return {
      ok: true,
      data: {
        subject: params.subject,
        attribute: params.attribute,
        value: params.value,
        description: describeAction(params),
      },
      answer: `Will save: **${params.subject}** → **${params.attribute}**: ${params.value}`,
    };
  },
};

export function describeAction(p: Params): string {
  return `save the fact "${p.subject} → ${p.attribute}: ${p.value}"`;
}

registerTool(saveTeamFactTool);
