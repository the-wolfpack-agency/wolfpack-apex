/**
 * Meeting Pre-Brief — synthesizer.
 *
 * The ONE LLM call site for the entire prep_for_meeting pipeline. Takes
 * the structured MeetingSources fan-out blob, hands it to the
 * provider-neutral AI client as a JSON-mode user message, and returns
 * the parsed MeetingPrep.
 *
 * Hard contract:
 *   - Exactly one getAIClient().complete() call per invocation.
 *   - Cheap tier (Haiku-class) — this is a structured-summary task, not
 *     creative writing. Same wrapper every other cheap-tier feature uses
 *     so a future provider swap is a routing change, not a feature
 *     rewrite.
 *   - Never throws. JSON parse failure or provider error returns a typed
 *     SynthesisError so the route handler can decide the fallback (today:
 *     return raw sources with a synthesis_unavailable flag).
 */

import { getAIClient } from "@/lib/ai";
import type { AIMessage } from "@/lib/ai";
import type { MeetingSources } from "./meeting-prep-sources";

/* --------------------------- Public shapes ---------------------------- */

export interface SourceRef {
  /** "crm" | "email" | "brain" | "calendar" | "meeting". Free-text on the
   *  wire so the synthesizer can add new ref kinds without a code change;
   *  the widget renders unknowns as plain text. */
  type: string;
  /** Stable identifier the widget can use to deep-link (email message id,
   *  CRM record id, brain doc id, meeting id). */
  id: string;
  /** One-line label shown on the source chip. */
  label: string;
  /** Optional deep-link URL when we have one. */
  url?: string;
}

export interface MeetingPrepTalkingPoint {
  point: string;
  source_refs: SourceRef[];
}

export interface MeetingPrepRiskFlag {
  flag: string;
  severity: "low" | "med" | "high";
  source_refs: SourceRef[];
}

export interface MeetingPrepAttendeeBrief {
  email: string;
  name?: string;
  one_liner: string;
  key_facts: string[];
  links: SourceRef[];
}

export interface MeetingPrep {
  summary: string;
  goal: string;
  talking_points: MeetingPrepTalkingPoint[];
  risk_flags: MeetingPrepRiskFlag[];
  attendee_briefs: MeetingPrepAttendeeBrief[];
  open_questions: string[];
}

export interface SynthesisOk {
  ok: true;
  prep: MeetingPrep;
  /** Wall-clock latency for the single LLM round-trip. */
  latencyMs: number;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SynthesisError {
  ok: false;
  code: "invalid_json" | "provider_error" | "empty_response";
  message: string;
}

export type SynthesisResult = SynthesisOk | SynthesisError;

export interface SynthesizeContext {
  userId: string;
  userRole?: string;
}

/* --------------------------- Prompt ----------------------------------- */

/**
 * System prompt — kept tight on purpose. Every word is intentional:
 *  - JSON-only output (no prose preamble, no trailing commentary).
 *  - Severity scale fixed to {low,med,high} so the widget can color-
 *    code without a free-text guesser.
 *  - source_refs is mandatory on every talking point + risk flag so the
 *    user can click out to the underlying record. Hallucinated refs are
 *    explicitly forbidden; the synthesizer must only cite ids that
 *    appear in the input.
 */
const SYSTEM_PROMPT = `You are a meeting-prep synthesizer. Read the
provided MeetingSources JSON and return a single JSON object matching
this schema:

{
  "summary": "1-2 sentences",
  "goal": "what likely matters in this meeting",
  "talking_points": [{"point":"...","source_refs":[{"type":"crm|email|brain|calendar|meeting","id":"...","label":"...","url":"..."}]}],
  "risk_flags": [{"flag":"...","severity":"low|med|high","source_refs":[...]}],
  "attendee_briefs": [{"email":"...","name":"...","one_liner":"...","key_facts":["..."],"links":[...]}],
  "open_questions": ["..."]
}

Rules:
- Output ONLY the JSON object. No prose, no markdown, no preamble.
- Every talking_points[].source_refs entry MUST cite an id that appears
  in the input. Never invent record ids.
- Use severity="high" only for material issues (stuck deals, unanswered
  escalations); "med" for follow-ups; "low" for nice-to-knows.
- Keep talking_points to <= 5 and risk_flags to <= 3.
- attendee_briefs entries should mirror the perAttendee array order.
- If a section has no signal, return [] (never invent filler).
`;

function buildUserMessage(sources: MeetingSources): string {
  /* The input is already structured JSON; pass it verbatim under a
   * labeled wrapper so the model sees what's data vs. instructions. */
  return JSON.stringify({ MeetingSources: sources });
}

/* --------------------------- JSON parsing ----------------------------- */

function tryParseJson(content: string): MeetingPrep | null {
  if (!content) return null;
  /* Some providers wrap JSON in ```json fences. Strip them defensively
   * before parsing. */
  const stripped = content
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== "object") return null;
    return normalizePrep(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asSourceRef(v: unknown): SourceRef | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const type = asString(r.type);
  const id = asString(r.id);
  const label = asString(r.label);
  if (!type || !id) return null;
  const url = typeof r.url === "string" ? r.url : undefined;
  return { type, id, label, url };
}

function asSourceRefs(v: unknown): SourceRef[] {
  if (!Array.isArray(v)) return [];
  return v.map(asSourceRef).filter((x): x is SourceRef => x !== null);
}

function asSeverity(v: unknown): "low" | "med" | "high" {
  if (v === "low" || v === "med" || v === "high") return v;
  return "low";
}

function normalizePrep(raw: Record<string, unknown>): MeetingPrep {
  const talking_points = Array.isArray(raw.talking_points)
    ? raw.talking_points
        .map((tp): MeetingPrepTalkingPoint | null => {
          if (!tp || typeof tp !== "object") return null;
          const o = tp as Record<string, unknown>;
          const point = asString(o.point);
          if (!point) return null;
          return { point, source_refs: asSourceRefs(o.source_refs) };
        })
        .filter((x): x is MeetingPrepTalkingPoint => x !== null)
        .slice(0, 5)
    : [];

  const risk_flags = Array.isArray(raw.risk_flags)
    ? raw.risk_flags
        .map((rf): MeetingPrepRiskFlag | null => {
          if (!rf || typeof rf !== "object") return null;
          const o = rf as Record<string, unknown>;
          const flag = asString(o.flag);
          if (!flag) return null;
          return {
            flag,
            severity: asSeverity(o.severity),
            source_refs: asSourceRefs(o.source_refs),
          };
        })
        .filter((x): x is MeetingPrepRiskFlag => x !== null)
        .slice(0, 3)
    : [];

  const attendee_briefs = Array.isArray(raw.attendee_briefs)
    ? raw.attendee_briefs
        .map((ab): MeetingPrepAttendeeBrief | null => {
          if (!ab || typeof ab !== "object") return null;
          const o = ab as Record<string, unknown>;
          const email = asString(o.email);
          if (!email) return null;
          return {
            email,
            name: typeof o.name === "string" ? o.name : undefined,
            one_liner: asString(o.one_liner),
            key_facts: asStringArray(o.key_facts).slice(0, 6),
            links: asSourceRefs(o.links),
          };
        })
        .filter((x): x is MeetingPrepAttendeeBrief => x !== null)
    : [];

  return {
    summary: asString(raw.summary),
    goal: asString(raw.goal),
    talking_points,
    risk_flags,
    attendee_briefs,
    open_questions: asStringArray(raw.open_questions).slice(0, 6),
  };
}

/* ------------------------ Single LLM call ----------------------------- */

export async function synthesizePrep(
  sources: MeetingSources,
  ctx: SynthesizeContext,
): Promise<SynthesisResult> {
  const messages: AIMessage[] = [
    { role: "user", content: buildUserMessage(sources) },
  ];

  let response;
  try {
    /* THE single LLM call. No retries on a non-parseable response — the
     * upstream caller falls back to raw sources instead, which keeps us
     * within the "ONE call per cache miss" invariant. */
    response = await getAIClient().complete({
      messages,
      system: SYSTEM_PROMPT,
      max_tokens: 1500,
      temperature: 0,
      model_tier: "cheap",
      sensitivity: "pii",
      latency_target: "real_time",
      metadata: {
        feature: "insights.meeting_prep",
        user_id: ctx.userId,
        user_role: ctx.userRole,
      },
    });
  } catch (err) {
    return {
      ok: false,
      code: "provider_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (!response || !response.content) {
    return { ok: false, code: "empty_response", message: "no content" };
  }

  const parsed = tryParseJson(response.content);
  if (!parsed) {
    return {
      ok: false,
      code: "invalid_json",
      message: `model returned unparseable JSON (len=${response.content.length})`,
    };
  }

  return {
    ok: true,
    prep: parsed,
    latencyMs: response.latency_ms,
    modelUsed: response.model_used,
    inputTokens: response.input_tokens,
    outputTokens: response.output_tokens,
  };
}
