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
  filter:
    | "confidence"
    | "entities"
    | "citations"
    | "stale"
    | "org_facts"
    | "ungrounded_internal"
    | "meta_commentary";
  reason: string;
  severity: "warn" | "block";
}

export interface QualityCheckInput {
  /** The candidate answer string. */
  answer: string;
  /** What was asked. Needed to tell a question about the world from a
   *  question about us, which a model cannot answer without a source. */
  question?: string;
  /** Top retrieval score. undefined when no retrieval.
   *
   *  NOT A SINGLE SCALE, which is the whole reason topScoreIsSemantic exists
   *  next to it. See gateConfidence. */
  topScore?: number;
  /**
   * Whether the hit that produced topScore came from the semantic index.
   *
   * Keyword and semantic scores are different measurements and are not
   * comparable to one another, so a threshold means nothing without knowing
   * which one produced the number.
   */
  topScoreIsSemantic?: boolean;
  /**
   * The floor the semantic index itself already enforced.
   *
   * Passed in rather than imported: this module is reachable from analytics.ts,
   * which client components import, and pulling the retrieval stack in behind
   * it is how server-only code ends up in a browser bundle.
   */
  semanticFloor?: number;
  /** Number of retrieved hits. */
  hitCount?: number;
  /** Lowercase names of people / orgs known to the team. */
  knownNames?: string[];
  /**
   * The retrieved material this answer was written from.
   *
   * A capitalised phrase that appears in the text we just quoted is not
   * invented, by definition: the model read it here. Without this, the check
   * has only the team roster to compare against, so every proper noun in a
   * client's own documents reads as a fabrication.
   *
   * Reported repeatedly: a correct answer about training venues carried "4
   * unfamiliar name(s): Ritz Carlton, Intercontinental, Hilton Hotel" - real
   * places, in Porsche's own survey exports, which this product had ingested
   * itself. Warning that a right answer is invented is worse than not warning
   * at all, because it teaches people to distrust the answers that are good.
   */
  groundingText?: string;
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

/**
 * Fallback floor, used only when the caller does not say which index produced
 * the score.
 *
 * Kept because an unaware caller must not be silently ungated. It is NOT the
 * threshold for semantic retrieval: that floor is measured, lives with the
 * index that enforces it, and is passed in. See gateConfidence.
 */
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
  topScoreIsSemantic?: boolean,
  semanticFloor?: number,
): QualityFlag | null {
  if (typeof topScore !== "number") return null;
  /* Only fire when grounding was retrieved but is too weak. With zero
     hits the answer is free-floating general-knowledge from the LLM
     (e.g. "what is Nurburgring?") — there's nothing to gate against
     because we never claimed to ground it. Citation gate (A3) handles
     the "claims to cite a source but didn't" case separately.

     Prior behavior: tryBrain returned emptyContext with topScore: 0
     when no hits existed, which made this gate fire `block` and the
     answer was swapped for the canned reject message, killing every
     general-knowledge response (regression reported 2026-05-14). */
  const hits = hitCount ?? 0;
  if (hits === 0) return null;

  /* ONE CONSTANT WAS BEING APPLIED TO TWO DIFFERENT MEASUREMENTS.
   *
   * topScore is max() over every hit, and hits arrive from two indexes whose
   * scores mean unrelated things. Semantic scores are cosine similarity, where
   * the populations were measured and separate at 0.36: things we hold sit
   * above it, things we do not sit at 0.23 to 0.34. Keyword scores are
   * ts_rank_cd, where a real question about time-off policy scored 0.0404 and
   * the word "yes" scored 0.5000, because the number tracks how short the
   * query is rather than how relevant the chunk is.
   *
   * Both were compared against 0.55, a constant with no derivation behind it
   * that predates semantic retrieval being switched on at all.
   *
   * WHAT THAT COST, measured on production 2026-08-27: of 55 recorded Brain
   * retrievals, 52 scored between 0.36 and 0.54. Every one of them found a
   * real document, paid for a model call to write an answer from it, and then
   * had that answer replaced with "I don't have a confident answer for that."
   * Three ever cleared 0.55. The confidence block fired 22 times, and it was
   * firing hardest on exactly the questions retrieval was getting right.
   *
   * So each scale is now judged against its own floor:
   *
   *   semantic  The floor the index itself enforced. Qdrant already refused
   *             everything below it, so this is belt and braces rather than a
   *             second opinion, and that is the correct amount of gate for a
   *             number that has already been thresholded once.
   *
   *   keyword   No numeric gate here, because no number on this scale means
   *             what a cosine threshold would mean. Keyword relevance is held
   *             by the subject-word test upstream, which refuses a query that
   *             carries nothing to quote, and by judgeRelevance, which reads
   *             the material and says whether it answers the question.
   *
   * When the caller does not say which index produced the score, the old
   * conservative threshold still applies: an unaware caller must not be
   * silently ungated. */
  if (topScoreIsSemantic === true) {
    const floor = semanticFloor;
    if (typeof floor !== "number") return null;
    if (topScore >= floor) return null;
    return {
      filter: "confidence",
      reason: `top semantic score ${topScore.toFixed(2)} < ${floor} (hits=${hits})`,
      severity: "block",
    };
  }

  if (topScoreIsSemantic === false) return null;

  if (topScore >= MIN_CONFIDENCE_SCORE) return null;
  return {
    filter: "confidence",
    reason: `top retrieval score ${topScore.toFixed(2)} < ${MIN_CONFIDENCE_SCORE} (hits=${hits})`,
    severity: "block",
  };
}

/* ------------------------------------------------------------------ */
/* A1b — ungrounded claims about US                                    */
/* ------------------------------------------------------------------ */

/**
 * Asking about THIS organization, not about the world.
 *
 * "our Q4 initiative", "we", "the company's process" and our own product names
 * are all claims only our own records can settle. A model has no way to know
 * them and every incentive to sound like it does.
 */
const ASKS_ABOUT_US =
  /\b(?:our|we|us|the\s+(?:company|team|agency|firm)(?:'|\u2019)?s?|wolfpack\w*|instinct)\b/i;

/**
 * A confident answer about us, built from nothing.
 *
 * THE FAILURE THIS CATCHES. gateConfidence returns null at zero hits on
 * purpose: with no retrieval the answer is general knowledge, and gating it
 * killed "what is Nurburgring" when it was tried in May. That reasoning is
 * right about the world and wrong about us.
 *
 * Measured 2026-08-26 by typing invented terms at the deployed assistant:
 *
 *   "WolfpackxPCNA"  -> "the integration between the Wolfpack platform and
 *                        Porsche Cars North America... inventory management,
 *                        pricing, incentives and lead handling"
 *   "our Q4 Falcon initiative" -> "enhancing the Falcon lead distribution
 *                        engine... optimizing lead routing algorithms"
 *
 * WolfpackxPCNA is a SharePoint folder. Falcon does not exist. Both answers
 * were fluent, specific, and delivered at full confidence with a page link.
 *
 * This is the worst failure the product has, worse than a wrong retrieval,
 * because there is nothing to check it against: a wrong document can be
 * opened and disagreed with, and an invented process cannot. In front of a
 * dealer asking about a warranty procedure it is indefensible.
 *
 * The world is untouched. "What is Nurburgring" mentions nobody's company and
 * still answers.
 */
export function gateUngroundedClaimAboutUs(
  question: string,
  hitCount: number | undefined,
  answer = "",
): QualityFlag | null {
  if ((hitCount ?? 0) > 0) return null;
  /* THE ANSWER COUNTS TOO, and this is the half that was missing.
   *
   * The question is not always where the tell is. "How do I register a demo
   * vehicle" names nobody, so the gate stayed quiet - and the reply was a
   * six-step walkthrough of screens in wolfpack-auto that do not exist:
   * Navigate to Inventory Management, click Add Vehicle, set Vehicle Status
   * to Demo. Fluent, numbered, and invented.
   *
   * An answer that describes OUR product with nothing retrieved behind it is
   * fabricating whether or not the question mentioned us, and a dealer
   * following those steps is the concrete harm. Suppressing the noisy hedge on
   * this answer without closing this would have made it read as MORE
   * authoritative, not less. */
  const tells = `${question} ${answer}`;
  if (!tells.trim()) return null;
  if (!ASKS_ABOUT_US.test(tells)) return null;
  return {
    filter: "ungrounded_internal",
    reason: "asked about this organization with no retrieved source to answer from",
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

/** Common English verbs/nouns that often appear capitalized as
 *  sentence starters, list-item headers, or section labels. None of
 *  these are proper names regardless of position. Adding a token
 *  here is the safest way to silence a recurring false positive. */
const COMMON_NON_NAMES = new Set([
  // Action verbs commonly used to lead a bullet or sentence
  "includes", "covers", "features", "focuses", "emphasizes", "adds",
  "updates", "provides", "delivers", "supports", "enables", "creates",
  "describes", "shows", "explains", "details", "outlines", "summarizes",
  "lists", "highlights", "introduces", "presents", "demonstrates",
  // Common section / list-item labels
  "source", "sources", "type", "size", "watch", "note", "summary",
  "training", "module", "modules", "section", "sections", "day", "days",
  "topic", "topics", "overview", "introduction", "conclusion",
  // Common labels in product/training content
  "video", "videos", "audio", "image", "document", "documents",
  "file", "files", "folder", "folders", "page", "pages",
]);

/** Words that are capitalized ONLY because a sentence starts with them.
 *
 *  WHY THIS IS A LIST AND NOT A GUESS
 *
 *  A capital letter carries information mid-sentence and none at all at the
 *  start of one. `SENTENCE_STARTERS` above already knew that, but held only
 *  prepositions and conjunctions, so "However." was read as somebody's name and
 *  the reader was told the answer "mentions 1 unfamiliar name(s): However."
 *
 *  Adding "however" alone would have left "Therefore", "Additionally",
 *  "Unfortunately" and every other discourse marker to be reported one bug at a
 *  time. This is the closed class instead: conjunctive adverbs, pronouns,
 *  determiners, modals and auxiliaries. It is a fixed set in English, so unlike
 *  the open-ended lists above it does not need topping up as content changes.
 *
 *  Applied ONLY at a sentence boundary. "However" mid-sentence would still be
 *  flagged, which is correct — that capital was a choice. */
const SENTENCE_INITIAL_COMMON_WORDS = new Set([
  // conjunctive adverbs / discourse markers — the reported bug
  "however", "therefore", "moreover", "furthermore", "additionally",
  "meanwhile", "nevertheless", "nonetheless", "otherwise", "consequently",
  "similarly", "likewise", "instead", "overall", "finally", "then", "thus",
  "hence", "also", "still", "yet", "besides", "accordingly", "regardless",
  "unfortunately", "fortunately", "importantly", "notably", "specifically",
  "generally", "typically", "usually", "often", "sometimes", "currently",
  "recently", "originally", "essentially", "basically", "ideally", "briefly",
  // ordinals used to sequence a list
  "first", "second", "third", "fourth", "fifth", "next", "lastly",
  // pronouns and determiners
  "this", "that", "these", "those", "there", "here", "it", "its", "they",
  "their", "them", "we", "our", "us", "you", "your", "he", "him", "his",
  "she", "hers", "who", "whom", "whose", "which", "what", "each", "every",
  "either", "neither", "both", "all", "any", "some", "most", "many", "few",
  "several", "another", "other", "such", "no", "none", "nothing", "something",
  // modals and auxiliaries
  "can", "could", "may", "might", "must", "shall", "should", "will", "would",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "being",
  "has", "have", "had", "am",
  // common openers in generated prose
  "please", "note", "based", "using", "given", "once", "unless", "although",
  "though", "because", "however", "why", "how", "where", "whether", "yes", "no",
  /* Conversational and adjectival openers. "Ready to help with anything you
     need." reported "Ready" as somebody's name on 2026-08-19, the same shape as
     the earlier "However." report. A short reply is mostly sentence starts, so
     these fire disproportionately on exactly the small talk a user tries
     first. */
  "ready", "happy", "glad", "sure", "sorry", "thanks", "thank", "hello", "hi",
  "welcome", "good", "great", "nice", "perfect", "absolutely", "certainly",
  "of", "as", "at", "by", "for", "from", "in", "on", "to", "with", "without",
  "let", "here", "looks", "seems", "sounds", "feel", "hope", "just", "only",
  "new", "old", "more", "less", "best", "better", "worse", "same", "different",
]);

/** Multi-word phrases that look like proper nouns but are actually
 *  job titles, role names, or common business-document headers. */
const COMMON_NON_NAME_PHRASES = new Set([
  "brand ambassador", "brand ambassadors", "account manager",
  "account managers", "program director", "program manager",
  "project manager", "product manager", "operations manager",
  "sales manager", "marketing manager", "creative director",
  "technical director", "executive director", "managing director",
  "chief executive", "chief operating", "chief technical",
  "vice president", "senior vice president",
  "porsche brand ambassador", "porsche brand ambassadors",
]);

export function validateEntities(
  answer: string,
  knownNames: string[],
  groundingText = "",
): QualityFlag | null {
  if (!answer) return null;
  /* CORROBORATED BY THE SOURCE, not by the question.
   *
   * A previous attempt at this required a capitalised word to appear
   * somewhere it did not have to be, which also silenced "Mortimer joined the
   * deal" - and inventing a colleague is the failure this check exists to
   * catch. It was rightly reverted.
   *
   * Grounding is a different test and a safe one. A name the model READ in
   * the material cannot have been invented by it; a name it did not read is
   * still caught, and Mortimer appears in no chunk. */
  const grounding = groundingText.toLowerCase();
  const known = new Set(knownNames.map((n) => n.toLowerCase().trim()));
  /* Also index by first token of each known name so single-word matches
     ("Jorge" → "jorge colon") still pass. */
  const knownFirstTokens = new Set<string>();
  for (const name of known) knownFirstTokens.add(name.split(/\s+/)[0]);
  const unknowns = new Set<string>();
  let m: RegExpExecArray | null;
  PROPER_NAME_RE.lastIndex = 0;
  while ((m = PROPER_NAME_RE.exec(answer))) {
    /* Is this match the first word of a sentence? Look back past whitespace
       for a terminator, a colon, a newline or a list bullet. Start-of-string
       counts too. A capital in that position says nothing about the word. */
    const before = answer.slice(0, m.index);
    const atSentenceStart = /(^|[.!?:;]|\n|^\s*[-*\u2022])\s*$/.test(before);

    /* Strip an English contraction before any lookup. "What's" reached the
       reader as an unfamiliar name because the list holds "what" and the
       apostrophe made it a different string. Every entry in every list above
       would need a possessive twin otherwise. */
    let phrase = m[1].toLowerCase().trim().replace(/[\u2019']\s*(s|re|ll|ve|t|d|m)\b/g, "");

    if (atSentenceStart) {
      const parts = phrase.split(/\s+/);
      if (SENTENCE_INITIAL_COMMON_WORDS.has(parts[0])) {
        /* Drop the positional capital and judge what actually follows.
           "However" disappears entirely; "However Jorge" is still tested as
           "Jorge", so a real name after a discourse marker is not lost. */
        if (parts.length === 1) continue;
        phrase = parts.slice(1).join(" ");
        m[1] = m[1].split(/\s+/).slice(1).join(" ");
      }
    }
    if (ALLOWED_PROPER_NOUNS.has(phrase)) continue;
    if (COMMON_NON_NAMES.has(phrase)) continue;
    if (COMMON_NON_NAME_PHRASES.has(phrase)) continue;
    if (known.has(phrase) || knownFirstTokens.has(phrase)) continue;
    /* IT IS IN THE MATERIAL WE JUST QUOTED. Checked before the heuristics
       below, because none of them can know that a name is real and this
       does. */
    if (grounding && grounding.includes(phrase)) continue;
    const tokens = phrase.split(/\s+/);
    const firstToken = tokens[0];
    if (known.has(firstToken) || knownFirstTokens.has(firstToken)) continue;
    if (ALLOWED_PROPER_NOUNS.has(firstToken)) continue;
    if (COMMON_NON_NAMES.has(firstToken)) continue;
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
  /* A LONG LIST IS EVIDENCE THE CHECK FAILED, NOT THAT THE ANSWER DID.
   *
   * Measured on a real answer about registering a demo vehicle: "16 unfamiliar
   * name(s): Navigate, Inventory Management, Inventory". Those are a verb and
   * two UI labels. A model does not invent sixteen people in one paragraph; a
   * capitalisation heuristic run over a formatted answer finds sixteen
   * capitalised things, which is a different fact entirely.
   *
   * Warning anyway is worse than staying quiet. The hedge is meant to make
   * somebody look twice at a specific claim, and a list of sixteen makes them
   * dismiss the hedge - which then also gets dismissed on the answer that
   * really did invent a colleague. An unreliable warning spends the credibility
   * of the reliable one.
   *
   * The threshold is deliberately generous: a genuine fabrication names one or
   * two people, so anything past a handful is the heuristic misfiring on
   * headings, lists and product nouns. Recorded either way, because how often
   * this trips is the measurement that says whether the roster or the parser
   * needs the work. */
  const IMPLAUSIBLE_NAME_COUNT = 6;
  if (unknowns.size >= IMPLAUSIBLE_NAME_COUNT) {
    return null;
  }

  return {
    filter: "entities",
    reason: `answer mentions ${unknowns.size} unfamiliar name(s): ${[...unknowns].slice(0, 3).join(", ")}`,
    severity: "warn",
  };
}

/* ------------------------------------------------------------------ */
/* A2b — the answer is ABOUT an answer                                 */
/* ------------------------------------------------------------------ */

/**
 * A model that narrates what a good answer would contain, instead of writing
 * one.
 *
 * Found by driving the deployed product as a user, 2026-08-29. Asking for a
 * "coaching calls spreadsheet" returned:
 *
 *   "The question asks for a coaching calls spreadsheet, but the draft does
 *    not address whether one exists, provide any relevant information, or
 *    leave the question unanswered. Since no specifics or data were included,
 *    the answer should be: ..."
 *
 * The reader asked for a file and received a critique of an answer they never
 * saw. Nothing else caught it: it is fluent, on topic, grounded in nothing, and
 * long enough to pass every length and confidence check. The entities filter
 * did fire, but on the word "Corrected", which it took for a person's name, so
 * the note shown above it was both alarming and wrong.
 *
 * BLOCK, NOT WARN. Every other filter hedges an answer that might still help.
 * This one cannot: an answer discussing "the draft" or "the response" has no
 * salvageable content for the person who asked, so hedging it just puts a
 * warning label on something useless. The deterministic fallback, which offers
 * things they CAN ask, is strictly better.
 *
 * Narrow on purpose. It looks for the answer referring to itself or to a draft
 * as an object, not for the mere words "question" or "answer", which appear in
 * plenty of legitimate replies ("the answer is net 30").
 */
const META_COMMENTARY_RE =
  /\b(?:the draft(?:\s+answer)?\s+(?:does|did|fails?|should|lacks)|the (?:answer|response)\s+should\s+(?:be|include|address|contain)|the question asks (?:for|about)[^.]{0,80}\bbut\b|this (?:answer|response) (?:does not|doesn't) (?:address|answer))/i;

export function gateMetaCommentary(answer: string): QualityFlag | null {
  if (!answer || !META_COMMENTARY_RE.test(answer)) return null;
  return {
    filter: "meta_commentary",
    /* Names what it is in the words somebody would use to reproduce it, so a
       reader of the analytics row can find the prompt that caused it. */
    reason: "answer describes what an answer should say instead of saying it",
    severity: "block",
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

  const fConfidence = gateConfidence(
    input.topScore,
    input.hitCount,
    input.topScoreIsSemantic,
    input.semanticFloor,
  );
  if (fConfidence) flags.push(fConfidence);

  const fUngrounded = gateUngroundedClaimAboutUs(
    input.question ?? "",
    input.hitCount,
    input.answer,
  );
  if (fUngrounded) flags.push(fUngrounded);

  /* Checked BEFORE the warn-level filters, and unconditionally: it needs no
     roster, no retrieved ids and no source dates, so an answer that is pure
     meta-commentary is caught even on the paths where the others cannot run.
     That matters because those are exactly the thin-context paths where a
     model is most likely to narrate instead of answer. */
  const fMeta = gateMetaCommentary(input.answer);
  if (fMeta) flags.push(fMeta);

  if (input.knownNames) {
    const fEntities = validateEntities(
      input.answer,
      input.knownNames,
      input.groundingText ?? "",
    );
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
        /* WHAT WAS ASKED, AND WHAT RETRIEVAL FOUND.
         *
         * Without these the event says an answer was rejected as "ungrounded"
         * and cannot say which question, or whether anything was retrieved. So
         * the one number that decides that gate is the one number missing.
         *
         * Cost an afternoon on 2026-08-29. Three paraphrases of a question
         * whose answer sits in the corpus were rejected in production.
         * brain_query_log showed 4 and 5 hits for two of them, the gate fires
         * only on zero, and nothing could join the two records, so which
         * rejection belonged to which query stayed a guess through three wrong
         * hypotheses.
         *
         * The question rather than the answer: the question is what somebody
         * needs to reproduce this, and the answer may carry content the reader
         * should not have to store a second copy of. Truncated, because an
         * unbounded field puts arbitrary user text into an analytics row. */
        message_text: (input.question ?? "").slice(0, 200),
        hit_count: input.hitCount ?? 0,
        top_score: input.topScore ?? 0,
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
