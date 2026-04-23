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
    // Prefer the canonical keyword set from related-pages.ts when the
    // domain has an entry there; fall back to the domain key itself
    // for aliases like `mailbox` that point at /emails.
    const kws = keywords[domain] || [domain];

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
export function matchPageFacts(
  question: string,
): { page: PageFact; confidence: number } | null {
  if (!question || !question.trim()) return null;
  const lower = question.toLowerCase();

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
