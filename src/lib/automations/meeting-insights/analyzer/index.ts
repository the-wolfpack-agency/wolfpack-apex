/**
 * meeting-insights / analyzer — turn one parsed message + attachments
 * into a structured `MeetingAnalysis`.
 *
 * Design:
 *   - Pure I/O: callers (ingest hook, regenerate route) pass the
 *     already-parsed strings; this module never reads from DB.
 *   - Idempotent at the call site: callers must guard on
 *     (message_id, analyzer_version) before calling. This module is
 *     intentionally stateless.
 *   - Defensive parsing: any LLM response that doesn't match the schema
 *     drops to status='partial' with raw_llm_response retained so we can
 *     re-run the parser later without another LLM call.
 *
 * Token budget (memory feedback_zero_tokens_first): the structured
 * schema lives in the system prompt + is prompt-cached, so every run
 * after the first reads it for ~10% of base price.
 */

import { callAnthropic } from "./anthropic";
import {
  ANALYZER_MODEL,
  EMPTY_ANALYSIS,
  type MeetingAnalysis,
  type MeetingAnalysisResult,
} from "./types";

/* ------------------------------------------------------------------ */
/* Public input shape                                                  */
/* ------------------------------------------------------------------ */

export interface AnalyzerInput {
  subject: string;
  from_address: string;
  from_name: string | null;
  received_at: string;
  body_text: string;
  attachments: Array<{
    filename: string;
    extracted_text: string | null;
  }>;
}

/* ------------------------------------------------------------------ */
/* System prompt — stable + cached                                     */
/* ------------------------------------------------------------------ */

/**
 * The system prompt encodes the schema. Keep it stable: any byte change
 * invalidates the prompt cache.
 *
 * If you need to change the schema, bump ANALYZER_VERSION (in types.ts)
 * AND update this prompt — the version bump triggers a re-analysis pass
 * for affected feeds.
 */
export const SYSTEM_PROMPT = `You are a meeting-insight extractor for an internal product called Wolfpack Instinct. The user gives you the raw text of one email or transcript from a recurring meeting (subject, sender, body, optional attachment text). Your job is to extract a strict JSON object with the following shape — and ONLY this object, no prose, no markdown, no code fences:

{
  "decisions": [
    { "summary": "string", "rationale": "string?", "owners": ["string"], "source_quote": "string?" }
  ],
  "action_items": [
    { "description": "string", "owner": "string?", "due": "string?", "completed": boolean, "source_quote": "string?" }
  ],
  "topics": ["string"],
  "attendees": [
    { "name": "string?", "email": "string?", "role": "string?" }
  ],
  "blockers": [
    { "description": "string", "severity": "low|medium|high?" }
  ],
  "next_steps": [
    { "description": "string", "when": "string?" }
  ]
}

Rules:
- Output MUST be a single JSON object. No backticks. No commentary before or after.
- All listed keys MUST be present. Use [] for empty lists.
- "topics" is a flat list of lowercase short noun-phrases (e.g. ["pricing", "carrier integration", "q3 hiring"]). Aim for 3-8 topics; fewer is fine.
- Quote source text verbatim in source_quote when extracting. Don't paraphrase.
- "completed" defaults to false if uncertain.
- "severity" is one of low, medium, high — omit if unsure.
- If a section has no signal in the message, return [].
- Never invent attendees / owners that aren't named in the source.
- Be conservative: under-extracting is better than hallucinating.

Return ONLY the JSON object.`;

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Analyze one meeting message. Returns a typed result; never throws.
 *
 * Statuses:
 *   - "success": JSON parsed, schema valid, fields populated.
 *   - "partial": LLM returned text but parsing/validation failed; raw
 *     response kept on the result so the dashboard can show the
 *     diagnostic.
 *   - "error": SDK / credential / rate-limit failure; analysis is
 *     EMPTY_ANALYSIS and error_detail explains why.
 */
export async function analyzeMessage(
  input: AnalyzerInput,
): Promise<MeetingAnalysisResult> {
  const userPrompt = buildUserPrompt(input);

  const result = await callAnthropic({
    system_prompt: SYSTEM_PROMPT,
    user_prompt: userPrompt,
  });

  if (!result.ok) {
    return {
      status: "error",
      analysis: EMPTY_ANALYSIS,
      error_detail: result.error_detail,
      model: ANALYZER_MODEL,
    };
  }

  const parsed = safeParseAnalysis(result.text);
  if (!parsed.ok) {
    return {
      status: "partial",
      analysis: EMPTY_ANALYSIS,
      raw_llm_response: result.text,
      model: result.model,
      tokens_used: result.tokens_used,
      error_detail: parsed.error,
    };
  }

  return {
    status: "success",
    analysis: parsed.analysis,
    raw_llm_response: result.text,
    model: result.model,
    tokens_used: result.tokens_used,
  };
}

/* ------------------------------------------------------------------ */
/* Prompt building                                                     */
/* ------------------------------------------------------------------ */

export function buildUserPrompt(input: AnalyzerInput): string {
  const fromLine = input.from_name
    ? `${input.from_name} <${input.from_address}>`
    : input.from_address;

  const attachmentSection =
    input.attachments.length > 0
      ? input.attachments
          .filter((a) => a.extracted_text && a.extracted_text.trim().length > 0)
          .map((a) => `--- ATTACHMENT: ${a.filename} ---\n${a.extracted_text}`)
          .join("\n\n")
      : "";

  // Cap inputs so we never blow the Haiku context window. Total budget
  // ~150K tokens — body+attachments capped at ~120K chars (~30K tokens)
  // is comfortably within budget AND keeps us cheap.
  const MAX_BODY_CHARS = 60_000;
  const MAX_ATTACHMENT_CHARS = 60_000;

  const bodyText = truncate(input.body_text ?? "", MAX_BODY_CHARS);
  const attachmentsText = truncate(attachmentSection, MAX_ATTACHMENT_CHARS);

  const parts: string[] = [
    `Subject: ${input.subject}`,
    `From: ${fromLine}`,
    `Date: ${input.received_at}`,
    "",
    "[BODY]",
    bodyText || "(empty body)",
  ];

  if (attachmentsText) {
    parts.push("", "[ATTACHMENTS]", attachmentsText);
  }

  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…(truncated)";
}

/* ------------------------------------------------------------------ */
/* Defensive parsing                                                   */
/* ------------------------------------------------------------------ */

interface ParseSuccess {
  ok: true;
  analysis: MeetingAnalysis;
}
interface ParseFailure {
  ok: false;
  error: string;
}

/**
 * Pull the first valid JSON object out of `text` and validate the
 * schema field-by-field. Belt-and-braces because Haiku occasionally
 * wraps output in code fences despite the instruction not to.
 */
export function safeParseAnalysis(text: string): ParseSuccess | ParseFailure {
  const json = extractJsonObject(text);
  if (!json) {
    return { ok: false, error: "no_json_object_found" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      error: `json_parse_failed: ${(err as Error).message}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "top_level_not_object" };
  }
  const obj = parsed as Record<string, unknown>;

  const failedFields: string[] = [];
  const decisions = arrayOf(obj.decisions, parseDecision, failedFields, "decisions");
  const actionItems = arrayOf(
    obj.action_items,
    parseActionItem,
    failedFields,
    "action_items",
  );
  const topics = arrayOf(obj.topics, parseTopic, failedFields, "topics").filter(
    (t): t is string => typeof t === "string",
  );
  const attendees = arrayOf(obj.attendees, parseAttendee, failedFields, "attendees");
  const blockers = arrayOf(obj.blockers, parseBlocker, failedFields, "blockers");
  const nextSteps = arrayOf(obj.next_steps, parseNextStep, failedFields, "next_steps");

  if (failedFields.length === Object.keys({ decisions: 0, action_items: 0, topics: 0, attendees: 0, blockers: 0, next_steps: 0 }).length) {
    return {
      ok: false,
      error: `every_field_failed_validation: ${failedFields.join(",")}`,
    };
  }

  return {
    ok: true,
    analysis: {
      decisions,
      action_items: actionItems,
      topics,
      attendees,
      blockers,
      next_steps: nextSteps,
    },
  };
}

/**
 * Extract the first balanced top-level JSON object from a string. Haiku
 * sometimes wraps responses in ```json fences or adds trailing prose.
 */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  // Fast path.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  // Strip code fences first.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) return inner;
  }
  // Brace-balance scan.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function arrayOf<T>(
  raw: unknown,
  parse: (item: unknown) => T | null,
  failedFields: string[],
  fieldName: string,
): T[] {
  if (!Array.isArray(raw)) {
    failedFields.push(fieldName);
    return [];
  }
  const out: T[] = [];
  for (const item of raw) {
    const v = parse(item);
    if (v !== null) out.push(v);
  }
  return out;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}
function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseDecision(item: unknown): MeetingAnalysis["decisions"][number] | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const summary = strOrEmpty(o.summary).trim();
  if (!summary) return null;
  return {
    summary,
    rationale: strOrUndef(o.rationale),
    owners: Array.isArray(o.owners)
      ? o.owners.filter((x): x is string => typeof x === "string")
      : undefined,
    source_quote: strOrUndef(o.source_quote),
  };
}

function parseActionItem(
  item: unknown,
): MeetingAnalysis["action_items"][number] | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const description = strOrEmpty(o.description).trim();
  if (!description) return null;
  return {
    description,
    owner: strOrUndef(o.owner),
    due: strOrUndef(o.due),
    completed: typeof o.completed === "boolean" ? o.completed : false,
    source_quote: strOrUndef(o.source_quote),
  };
}

function parseTopic(item: unknown): string | null {
  if (typeof item !== "string") return null;
  const t = item.trim().toLowerCase();
  if (!t) return null;
  return t;
}

function parseAttendee(item: unknown): MeetingAnalysis["attendees"][number] | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const a: MeetingAnalysis["attendees"][number] = {};
  const name = strOrUndef(o.name);
  const email = strOrUndef(o.email);
  const role = strOrUndef(o.role);
  if (name) a.name = name;
  if (email) a.email = email;
  if (role) a.role = role;
  if (!a.name && !a.email) return null;
  return a;
}

function parseBlocker(item: unknown): MeetingAnalysis["blockers"][number] | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const description = strOrEmpty(o.description).trim();
  if (!description) return null;
  const sev = o.severity;
  const severity =
    sev === "low" || sev === "medium" || sev === "high" ? sev : undefined;
  return {
    description,
    severity,
  };
}

function parseNextStep(
  item: unknown,
): MeetingAnalysis["next_steps"][number] | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const description = strOrEmpty(o.description).trim();
  if (!description) return null;
  return {
    description,
    when: strOrUndef(o.when),
  };
}
