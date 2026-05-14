/**
 * Answer-quality filters for the Wolfpack Assistant.
 *
 * Each filter is a pure function that inspects a candidate answer + its
 * grounding context and returns a verdict. Filters cascade: if any
 * returns `reject`, the assistant either refuses to answer OR returns a
 * deterministic low-confidence message instead of letting the LLM speak.
 *
 * Why this lives in its own module:
 *   1. `assistant.ts` is already 1.5k+ lines; concentrating quality
 *      logic here keeps the answer pipeline readable.
 *   2. Every filter is straightforwardly testable in isolation — no
 *      Postgres, no Microsoft Graph, no LLM mocks.
 *   3. The same module is reused by saveAnswer (cache-write veto) and
 *      by the live answer path (response-time veto). Two clients, one
 *      truth.
 *
 * Filters live here:
 *   A1 gateConfidence       — retrieval-score threshold gate
 *   A2 validateEntities     — flag named entities not in the team roster
 *   A3 requireCitations     — every factual sentence must cite a source
 *   A4 detectStaleClaim     — present-tense answer cites a stale doc
 *   A5 boostOrgFacts        — convenience wrapper that ranks org-facts
 *                              ahead of RAG hits (defers to learning.ts)
 *
 * Every trigger emits a typed analytics event so the learning loop has
 * full visibility into which filter fires when. No data lost.
 */

import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

/* ------------------------------------------------------------------ */
/* Team-roster lookup                                                  */
/* ------------------------------------------------------------------ */

/**
 * Pull the lowercase names of every active team member. Used by the
 * entity-validation filter. Caches in-process — the roster changes
 * infrequently and the assistant fires on every chat turn.
 */
let _rosterCache: { names: string[]; ts: number } | null = null;
const ROSTER_CACHE_MS = 5 * 60 * 1000;

export async function getKnownTeamNames(): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  if (_rosterCache && Date.now() - _rosterCache.ts < ROSTER_CACHE_MS) {
    return _rosterCache.names;
  }
  try {
    const r = await safeQuery<{ name: string | null; email: string | null }>(
      `SELECT name, email FROM instinct_team_members WHERE is_active = true`,
    );
    const out: string[] = [];
    for (const row of r.rows) {
      if (row.name) out.push(row.name.toLowerCase().trim());
      /* Email local-part is often a first name — useful as a fallback. */
      if (row.email) {
        const local = row.email.split("@")[0].replace(/[._-]/g, " ").toLowerCase().trim();
        if (local) out.push(local);
      }
    }
    _rosterCache = { names: out, ts: Date.now() };
    return out;
  } catch {
    return [];
  }
}

/** Test seam — clear the in-process roster cache. */
export function __resetRosterCacheForTests(): void {
  _rosterCache = null;
}

/* ------------------------------------------------------------------ */
/* Per-workspace strictness                                            */
/* ------------------------------------------------------------------ */

export type AssistantStrictness = "permissive" | "strict";

let _strictnessCache: { value: AssistantStrictness; ts: number } | null = null;
const STRICTNESS_CACHE_MS = 60 * 1000;

/**
 * Read the workspace's assistant_strictness setting (migration 133).
 * Cached in-process for 60s — strictness rarely changes. Defaults to
 * "permissive" if the workspace row is missing, the column is absent
 * (pre-migration), or we're in shadow mode.
 */
export async function getAssistantStrictness(): Promise<AssistantStrictness> {
  if (!process.env.DATABASE_URL) return "permissive";
  if (
    _strictnessCache &&
    Date.now() - _strictnessCache.ts < STRICTNESS_CACHE_MS
  ) {
    return _strictnessCache.value;
  }
  try {
    const r = await safeQuery<{ assistant_strictness: string | null }>(
      `SELECT assistant_strictness FROM instinct_workspace WHERE id = 'default' LIMIT 1`,
    );
    const raw = r.rows[0]?.assistant_strictness;
    const value: AssistantStrictness = raw === "strict" ? "strict" : "permissive";
    _strictnessCache = { value, ts: Date.now() };
    return value;
  } catch {
    return "permissive";
  }
}

/** Test seam — clear the in-process strictness cache. */
export function __resetStrictnessCacheForTests(): void {
  _strictnessCache = null;
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type QualityVerdict = "ok" | "low_confidence" | "reject";

export interface QualityFlag {
  filter: "confidence" | "entities" | "citations" | "stale" | "org_facts";
  reason: string;
  severity: "warn" | "block";
}

export interface QualityCheckInput {
  /** The candidate answer string. */
  answer: string;
  /** Top retrieval score (0..1). undefined when no retrieval. */
  topScore?: number;
  /** Number of retrieved hits. */
  hitCount?: number;
  /** Lowercase names of people / orgs known to the team. */
  knownNames?: string[];
  /** IDs the answer might cite — for the citation check. */
  retrievedIds?: string[];
  /** When the answer's most-cited source was last updated, ISO date. */
  topSourceUpdatedAt?: string | null;
  /** Now (ms) — overridable for tests. */
  now?: number;
}

export interface QualityCheckResult {
  verdict: QualityVerdict;
  flags: QualityFlag[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Below this score, retrieval is treated as "not really relevant." */
export const MIN_CONFIDENCE_SCORE = 0.55;

/** Docs older than this with present-tense claims are flagged. */
export const STALE_DOC_AGE_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

const PRESENT_TENSE_RE =
  /\b(?:is|are|am|currently|today|right now|as of|we use|we have|our \w+ is|the current)\b/i;

const PROPER_NAME_RE = /\b([A-Z][a-z'’-]{1,24}(?:\s+[A-Z][a-z'’-]{1,24}){0,3})\b/g;

const FALLBACK_LOW_CONFIDENCE_MESSAGE =
  "I don't have a confident answer for that. Could you rephrase, or open a support ticket so a human can look at it?";

/* ------------------------------------------------------------------ */
/* A1 — confidence gate                                                */
/* ------------------------------------------------------------------ */

export function gateConfidence(
  topScore: number | undefined,
  hitCount: number | undefined,
): QualityFlag | null {
  if (typeof topScore !== "number") return null;
  if (topScore >= MIN_CONFIDENCE_SCORE && (hitCount ?? 0) > 0) return null;
  return {
    filter: "confidence",
    reason: `top retrieval score ${topScore.toFixed(2)} < ${MIN_CONFIDENCE_SCORE} (hits=${hitCount ?? 0})`,
    severity: "block",
  };
}

/* ------------------------------------------------------------------ */
/* A2 — named-entity validation                                        */
/* ------------------------------------------------------------------ */

/**
 * Returns the set of capitalized multi-word phrases in the answer that
 * look like person/org names but don't appear in `knownNames`. Common
 * stop-tokens (Wolfpack, Microsoft, etc.) are pre-filtered.
 */
const ALLOWED_PROPER_NOUNS = new Set([
  "wolfpack", "wolfpack auto", "wolfpack apex", "instinct",
  "microsoft", "outlook", "teams", "sharepoint", "onedrive",
  "google", "calendar", "mail", "gmail",
  "anthropic", "claude", "openai", "gpt",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Sentence-starter words that are capitalized only because of position,
 *  not because they're proper nouns. Skip these to avoid "On April" /
 *  "By Tuesday" false positives. */
const SENTENCE_STARTERS = new Set([
  "on", "at", "by", "in", "for", "to", "the", "a", "an",
  "after", "before", "during", "since", "from", "until",
  "and", "but", "or", "if", "when", "while", "as", "with",
]);

export function validateEntities(
  answer: string,
  knownNames: string[],
): QualityFlag | null {
  if (!answer) return null;
  const known = new Set(knownNames.map((n) => n.toLowerCase().trim()));
  /* Also index by first token of each known name so single-word matches
     ("Jorge" → "jorge colon") still pass. */
  const knownFirstTokens = new Set<string>();
  for (const name of known) knownFirstTokens.add(name.split(/\s+/)[0]);
  const unknowns = new Set<string>();
  let m: RegExpExecArray | null;
  PROPER_NAME_RE.lastIndex = 0;
  while ((m = PROPER_NAME_RE.exec(answer))) {
    const phrase = m[1].toLowerCase().trim();
    if (ALLOWED_PROPER_NOUNS.has(phrase)) continue;
    if (known.has(phrase) || knownFirstTokens.has(phrase)) continue;
    const tokens = phrase.split(/\s+/);
    const firstToken = tokens[0];
    if (known.has(firstToken) || knownFirstTokens.has(firstToken)) continue;
    if (ALLOWED_PROPER_NOUNS.has(firstToken)) continue;
    /* If ANY token in the phrase is a sentence-starter or month/day,
       drop the first token and re-test the trailing token. Catches
       "On April" (starter + month) and "And Monday". */
    if (
      SENTENCE_STARTERS.has(firstToken) ||
      (tokens.length > 1 && ALLOWED_PROPER_NOUNS.has(tokens[1]))
    ) {
      continue;
    }
    /* Skip 1-word fragments <= 4 chars (heuristic: common English). */
    if (!phrase.includes(" ") && phrase.length <= 4) continue;
    unknowns.add(m[1]);
  }
  if (unknowns.size === 0) return null;
  return {
    filter: "entities",
    reason: `answer mentions ${unknowns.size} unfamiliar name(s): ${[...unknowns].slice(0, 3).join(", ")}`,
    severity: "warn",
  };
}

/* ------------------------------------------------------------------ */
/* A3 — citation requirement                                           */
/* ------------------------------------------------------------------ */

/**
 * Each factual sentence in the answer should cite at least one of the
 * retrieved IDs via `[ref:<id>]`. If retrievedIds is empty we cannot
 * enforce — return null (handled by A1).
 */
export function requireCitations(
  answer: string,
  retrievedIds: string[],
): QualityFlag | null {
  if (!answer || retrievedIds.length === 0) return null;
  const sentences = answer
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);
  /* A sentence is "factual" if it contains a fact-verb AND doesn't start
     with imperative / closing-prose patterns. Open-ended pleasantries
     ("Let me know...", "Please don't hesitate...") are not factual. */
  const FACT_HINT_RE =
    /\b(?:is|are|was|were|will|has|have|had|did|does|occurred|happened|met|recorded|signed|closed|attended)\b/i;
  const NON_FACT_OPENER_RE =
    /^(?:let me know|please|feel free|if you|happy to|let us know|thanks|thank you|reach out|don't hesitate|do not hesitate|in summary|to summarize|hope this|hope that)/i;
  const factSentences = sentences.filter(
    (s) => FACT_HINT_RE.test(s) && !NON_FACT_OPENER_RE.test(s),
  );
  if (factSentences.length === 0) return null;
  const uncited = factSentences.filter((s) => !/\[ref:[A-Za-z0-9_-]+\]/.test(s));
  if (uncited.length === 0) return null;
  return {
    filter: "citations",
    reason: `${uncited.length}/${factSentences.length} factual sentence(s) lack a [ref:] citation`,
    severity: "warn",
  };
}

/* ------------------------------------------------------------------ */
/* A4 — stale-doc detection                                            */
/* ------------------------------------------------------------------ */

export function detectStaleClaim(
  answer: string,
  topSourceUpdatedAt: string | null | undefined,
  nowMs = Date.now(),
): QualityFlag | null {
  if (!answer || !topSourceUpdatedAt) return null;
  const ms = Date.parse(topSourceUpdatedAt);
  if (Number.isNaN(ms)) return null;
  const ageMs = nowMs - ms;
  if (ageMs < STALE_DOC_AGE_MS) return null;
  if (!PRESENT_TENSE_RE.test(answer)) return null;
  const ageMonths = Math.round(ageMs / (30 * 24 * 60 * 60 * 1000));
  return {
    filter: "stale",
    reason: `present-tense claim cites a source last updated ${ageMonths} months ago`,
    severity: "warn",
  };
}

/* ------------------------------------------------------------------ */
/* Aggregate runner                                                    */
/* ------------------------------------------------------------------ */

export interface RunQualityChecksOpts {
  /** User firing the question — for analytics attribution. */
  userId: string;
  userRole: string;
  /**
   * Per-workspace strictness mode. In "strict" mode every warn-level
   * flag is upgraded to block — the verdict becomes "reject" and the
   * caller swaps in the deterministic low-confidence message. Enterprise
   * tenants run strict; self-serve / dev run permissive.
   *
   * Defaults to "permissive" if omitted.
   */
  strictness?: AssistantStrictness;
}

export function runAnswerQualityChecks(
  input: QualityCheckInput,
  opts: RunQualityChecksOpts,
): QualityCheckResult {
  const flags: QualityFlag[] = [];

  const fConfidence = gateConfidence(input.topScore, input.hitCount);
  if (fConfidence) flags.push(fConfidence);

  if (input.knownNames) {
    const fEntities = validateEntities(input.answer, input.knownNames);
    if (fEntities) flags.push(fEntities);
  }

  if (input.retrievedIds && input.retrievedIds.length > 0) {
    const fCitations = requireCitations(input.answer, input.retrievedIds);
    if (fCitations) flags.push(fCitations);
  }

  const fStale = detectStaleClaim(
    input.answer,
    input.topSourceUpdatedAt,
    input.now,
  );
  if (fStale) flags.push(fStale);

  /* Verdict: any "block" → reject; only "warn"s → low_confidence; none → ok.
     In strict mode, any flag (warn OR block) becomes reject so enterprise
     tenants never see the LLM speak under doubt. */
  const strictness: AssistantStrictness = opts.strictness ?? "permissive";
  let verdict: QualityVerdict = "ok";
  if (flags.some((f) => f.severity === "block")) verdict = "reject";
  else if (flags.length > 0) {
    verdict = strictness === "strict" ? "reject" : "low_confidence";
  }

  for (const flag of flags) {
    trackEvent(
      "assistant.quality_flag_raised",
      opts.userId,
      opts.userRole,
      {
        filter: flag.filter,
        severity: flag.severity,
        reason: flag.reason,
        verdict,
        strictness,
      },
    );
  }

  return { verdict, flags };
}

/* ------------------------------------------------------------------ */
/* Citation validation                                                 */
/* ------------------------------------------------------------------ */

export interface CitationValidationResult {
  /** Answer with invalid [ref:X] tokens removed. */
  cleanAnswer: string;
  /** IDs the LLM cited but that weren't in the retrieved set. */
  droppedRefs: string[];
  /** Distinct valid IDs that survived. */
  keptRefs: string[];
}

/**
 * Strip [ref:<id>] tokens from the answer when <id> is not in the
 * actual retrieved-source set for this turn. Without this check the
 * LLM could invent citations ("[ref:doc-42]") that look authoritative
 * but point at nothing — exactly the kind of confidently-wrong output
 * that breaks an enterprise demo.
 *
 * Cleanup is conservative: we remove the token + the leading space when
 * present, leaving the surrounding prose intact.
 *
 * Per-tenant: the `validSourceIds` set is constructed by the caller
 * from sources the user can actually see (RLS-scoped at the query
 * layer), so a citation that survives this filter is guaranteed to
 * resolve to a doc in the user's tenant — never to a global or
 * cross-tenant id.
 */
export function validateCitations(
  answer: string,
  validSourceIds: string[],
): CitationValidationResult {
  if (!answer) {
    return { cleanAnswer: "", droppedRefs: [], keptRefs: [] };
  }
  const valid = new Set(validSourceIds.map((id) => id.trim()).filter(Boolean));
  const droppedRefs = new Set<string>();
  const keptRefs = new Set<string>();

  const cleanAnswer = answer.replace(
    /\s?\[ref:([A-Za-z0-9_-]+)\]/g,
    (_match, id) => {
      const trimmed = String(id).trim();
      if (valid.has(trimmed)) {
        keptRefs.add(trimmed);
        return ` [ref:${trimmed}]`;
      }
      droppedRefs.add(trimmed);
      return "";
    },
  );

  return {
    cleanAnswer: cleanAnswer.replace(/\s{2,}/g, " ").trim(),
    droppedRefs: [...droppedRefs],
    keptRefs: [...keptRefs],
  };
}

/** Build the deterministic low-confidence reply the assistant returns
 *  when the verdict is "reject". Public so call-sites can compose. */
export function lowConfidenceMessage(): string {
  return FALLBACK_LOW_CONFIDENCE_MESSAGE;
}
