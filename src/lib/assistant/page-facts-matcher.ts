/**
 * Page-facts matcher — zero-token pattern recognition for "what is X",
 * "how do I X", and bare page-name questions.
 *
 * Pure string work; no LLM, no DB. Reuses the DOMAIN_MAP keyword lists
 * from related-pages.ts so we never duplicate the source of truth.
 *
 * Design:
 *   - Single-token confidence depends on the phrasing envelope:
 *       "what is calendar"        → 0.95 (intent verb + bare name)
 *       "how do I track goals"    → 0.9  (action verb + keyword)
 *       "use the calendar page"   → 0.8
 *       "Calendar"                → 0.7  (bare keyword, still confident)
 *   - Multi-match tie-break: the match with more keyword hits wins; on
 *     a true tie, alphabetical-first domain wins. Deterministic.
 *   - Short-circuits null for empty / no-match so the caller falls
 *     through to the normal KB → RAG → AI chain.
 */

import { PAGE_FACTS, type PageFact } from "./page-facts";
import { getDomainKeywords } from "./related-pages";

export interface PageFactsMatch {
  page: PageFact;
  confidence: number;
  /** Number of keyword hits that contributed to this match. Exposed
   *  for tests + analytics metadata, not used by the UI. */
  hits: number;
}

// Confidence floors by intent class. Used as the base score before
// multi-keyword bumps and ambiguity penalties.
const CONF_WHAT_IS = 0.95;
const CONF_HOW_DO = 0.9;
const CONF_WHERE = 0.9;
const CONF_USE_SHOW = 0.8;
const CONF_BARE = 0.7;

const WHAT_IS_RE = /\b(what\s+is|what\s+does|what's|tell\s+me\s+about|explain)\b/;
const HOW_DO_RE = /\b(how\s+do\s+i|how\s+can\s+i|how\s+to|how\s+do\s+you)\b/;
const WHERE_RE = /\b(where\s+is|where\s+do\s+i|where\s+can\s+i|where\s+are)\b/;
const USE_RE = /\b(use\s+the|using\s+the|open\s+the|go\s+to|navigate\s+to)\b/;
const SHOW_RE = /\b(show\s+me(?:\s+my)?|view\s+my|see\s+my)\b/;

/**
 * True when `keyword` appears as a whole-token fragment inside `text`.
 * Mirrors the semantics of related-pages.ts `matchesKeyword` — kept
 * local so this module doesn't have to import a private helper.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  if (keyword.includes(" ")) {
    return text.includes(keyword);
  }
  const idx = text.indexOf(keyword);
  if (idx === -1) return false;
  const left = idx === 0 ? " " : text[idx - 1];
  const rightIdx = idx + keyword.length;
  const right = rightIdx >= text.length ? " " : text[rightIdx];
  const isWordChar = (c: string) => /[a-z0-9]/.test(c);
  return !isWordChar(left) && !isWordChar(right);
}

/**
 * Score every domain against the question. Returns an array of
 * candidates sorted by (confidence desc, hits desc, domain asc).
 */
function scoreAllDomains(lower: string): PageFactsMatch[] {
  const keywords = getDomainKeywords();
  const hasWhatIs = WHAT_IS_RE.test(lower);
  const hasHowDo = HOW_DO_RE.test(lower);
  const hasWhere = WHERE_RE.test(lower);
  const hasUse = USE_RE.test(lower);
  const hasShow = SHOW_RE.test(lower);

  const candidates: PageFactsMatch[] = [];

  for (const domain of Object.keys(PAGE_FACTS)) {
    const fact = PAGE_FACTS[domain];
    /* Page-facts matching is broader than related-pages chip matching.
       Chips need strict phrasing (related-pages intentionally drops
       bare "directory" so a Dependabot PR title doesn't surface a
       Team Directory chip). The page-facts matcher should still
       resolve bare "Directory" / "what is the directory" to the
       Team Directory page-fact — intent disambiguates here.
       So: start with the related-pages keywords, then ADD the bare
       domain key as an alias. We intentionally do NOT add the
       page-fact title's first word — generic English first words
       like "My" (from "My Time") would over-fire on "my tax return"
       and similar. */
    const baseKws = keywords[domain] || [];
    const aliasSet = new Set<string>([...baseKws, domain]);
    const kws = Array.from(aliasSet);

    let hits = 0;
    for (const kw of kws) {
      if (matchesKeyword(lower, kw)) hits++;
    }
    if (hits === 0) continue;

    // Base confidence from the phrasing envelope.
    let conf = 0;
    if (hasWhatIs) conf = Math.max(conf, CONF_WHAT_IS);
    if (hasHowDo) conf = Math.max(conf, CONF_HOW_DO);
    if (hasWhere) conf = Math.max(conf, CONF_WHERE);
    if (hasUse) conf = Math.max(conf, CONF_USE_SHOW);
    if (hasShow) conf = Math.max(conf, CONF_USE_SHOW);

    if (conf === 0) {
      // Bare keyword / no intent envelope — still a signal, but lower.
      // Require either a single-word question OR a very short question
      // so "Calendar" fires but "my calendar fell off the wall" doesn't
      // over-fire. We gate on token count: ≤4 tokens passes bare.
      const tokenCount = lower.trim().split(/\s+/).filter(Boolean).length;
      if (tokenCount <= 4) {
        conf = CONF_BARE;
      } else {
        // Long sentence with a keyword but no explicit intent envelope
        // — mark it lower so the main chain gets a shot first.
        conf = 0.5;
      }
    }

    // Multi-hit bump: more keyword matches = more signal. Cap at 1.0.
    if (hits > 1) {
      conf = Math.min(1.0, conf + 0.02 * (hits - 1));
    }

    candidates.push({ page: fact, confidence: conf, hits });
  }

  // Sort: confidence desc, hits desc, domain asc (for determinism).
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.page.domain.localeCompare(b.page.domain);
  });

  return candidates;
}

/**
 * Return the best page-facts match for `question`, or null if no
 * candidate scores high enough to be useful. The caller should use
 * the 0.6 confidence floor below; this function returns matches at or
 * above 0.5 so tests can inspect sub-threshold behavior.
 */
/**
 * A question about a RULE is not a question about a page.
 *
 * "What is our policy on time off" scored the Time page, because the words
 * time and off are in it, and answered with a tour of the time-logging screen:
 * how to add an entry, how to edit one, where the totals are. The person asked
 * how many days they get. "What is our expense policy" did the same to
 * Financials.
 *
 * These are exactly the questions a document library exists to answer, and
 * exactly what a client will ask first: leave, expenses, travel, conduct. A
 * product tour is the one answer guaranteed to be wrong, and it arrives at
 * full confidence because the page name genuinely does appear in the sentence.
 *
 * So page facts decline them and let retrieval have them. If nothing in the
 * library answers, the honest "I could not find that" beats a confident tour
 * of the wrong screen.
 *
 * Narrow on purpose: it asks whether the sentence is ABOUT a rule, not whether
 * it mentions one. "How do I log time" and "my time" are untouched.
 */
const ASKS_ABOUT_A_RULE =
  /\b(polic(?:y|ies)|entitlement|allowance|guidelines?|handbook|rules?\s+(?:on|about|for)|am\s+i\s+(?:entitled|allowed)|how\s+(?:many|much)\s+(?:days?|hours?|weeks?)\s+(?:of|do|can)|eligib(?:le|ility))\b/;

/**
 * A question about STATE is not a question about a page.
 *
 * Found by sweeping the prompts a person actually types, 2026-08-26:
 *
 *   "what's blocking the pilot" -> a tour of the Phase One dashboard, because
 *   the page's domain is "pilot". The person asked what is going wrong; they
 *   were told what a screen contains.
 *
 * Same defect as ASKS_ABOUT_A_RULE above, in a different dress. The page name
 * genuinely is in the sentence, so the match arrives at full confidence, and a
 * confident tour of the wrong screen is the one answer guaranteed to be
 * useless. Worse here than for rules, because "pilot" is the word this
 * business uses for its most important engagement.
 *
 * Narrow on purpose: it asks whether the sentence is ABOUT an obstacle or a
 * status, not whether one is mentioned. "Open the pilot dashboard" is
 * untouched.
 */
const ASKS_ABOUT_STATE =
  /\b(?:blocking|blocked|blockers?|at\s+risk|stuck\s+on|holding\s+(?:it|us)\s+up|going\s+wrong|behind\s+schedule|slipping)\b/;

/**
 * A question about PEOPLE is not a question about a page.
 *
 * "who reports to me" answered with the Reports page: how to generate a weekly
 * report, how to export it as PDF. The person asked who is in their team.
 *
 * The tell is "who" leading a question about a relationship. Reports, People,
 * Clients and Directory all carry names that are also ordinary verbs and
 * nouns, so this collision is not rare.
 */
const ASKS_ABOUT_PEOPLE =
  /^\s*who\b(?!\s+(?:is\s+)?(?:the\s+)?(?:page|screen|tab)\b)/;

export function matchPageFacts(
  question: string,
): { page: PageFact; confidence: number } | null {
  if (!question || !question.trim()) return null;
  const lower = question.toLowerCase();
  if (ASKS_ABOUT_A_RULE.test(lower)) return null;
  /* Both decline and let retrieval have the question. An honest "I could not
     find that" beats a confident tour of the wrong screen. */
  if (ASKS_ABOUT_STATE.test(lower)) return null;
  if (ASKS_ABOUT_PEOPLE.test(lower)) return null;

  const candidates = scoreAllDomains(lower);
  if (candidates.length === 0) return null;

  const best = candidates[0];
  // Floor at 0.5 so the caller can still inspect sub-threshold matches
  // in tests. The chat() integration only acts on >= 0.6.
  if (best.confidence < 0.5) return null;

  return { page: best.page, confidence: best.confidence };
}

/** Exposed for tests only — returns the full candidate list. */
export function _debugScoreAll(question: string): PageFactsMatch[] {
  if (!question || !question.trim()) return [];
  return scoreAllDomains(question.toLowerCase());
}
