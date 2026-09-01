/**
 * Microsoft Graph search keyword extractor.
 *
 * Microsoft's `/search/query` endpoint runs a KQL keyword/phrase model. It
 * does NOT match natural-language questions like
 *   `What's in the TWA Agenda 4.20 doc?`
 * against documents named `TWA_Agenda_4.20.docx`. Filler words ("what's",
 * "in", "the", "doc") collapse the relevance ranking and Graph returns 0
 * hits even when the document plainly exists in the user's index.
 *
 * `buildSearchQueryString(question)` strips that noise and produces a
 * keyword string suitable to send as Graph's `query.queryString`:
 *
 *   1. Pull "file-like tokens" matching
 *      \b[\w\-]+\.(docx?|pdf|xlsx?|pptx?|md|txt|csv)\b and preserve verbatim.
 *   2. Pull explicit quoted phrases ("...") and preserve verbatim.
 *   3. Drop a fixed stopword set (the / a / what's / etc).
 *   4. Keep proper nouns (leading capital, not sentence start), numbers
 *      (4.20), and tokens longer than 2 chars.
 *   5. Always also surface 2 to 5 char ALL CAPS acronyms (TWA / PCNA / SOP).
 *   6. Join with spaces. If extraction yields nothing, fall back to the
 *      trimmed original question so Graph at least sees the verbatim text.
 *
 * Pure function. No IO, no external deps. Easy to unit-test.
 *
 * Used by:
 *   - microsoft-sharepoint.ts -> `searchSharePoint`
 *   - microsoft-mail.ts -> `searchMessages`
 *   - api/assistant/grounding-debug -> so the diagnostic page can show the
 *     EXACT queryString that was sent to Graph.
 */

/** Tokens that match these extensions are treated as filenames. */
/* Filenames can contain internal dots ("TWA_Agenda_4.20.docx") and
   dashes ("client-list.csv"). Match the longest run of word/.- chars
   that ends with a known Office/document extension. */
const FILE_EXT_RE = /\b[\w][\w.\-]*\.(?:docx?|pdf|xlsx?|pptx?|md|txt|csv)\b/gi;

/** Quoted phrases preserved as-is, including the surrounding quotes. */
const QUOTED_PHRASE_RE = /"[^"]+"/g;

/** All caps acronyms 2 to 5 chars long (TWA, PCNA, SOP, KPI). */
const ACRONYM_RE = /\b[A-Z]{2,5}\b/g;

/**
 * Stopwords removed before passing to Graph. Lowercase compared. Includes
 * filler nouns we never want to ground on (doc / document / file) plus
 * common question-frame verbs / prepositions ("summarize", "search for",
 * "pull up") that anchor the user's intent rather than the entity. Smart
 * apostrophes are normalized to ASCII before comparison.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  /* Articles + question wh-words (per spec). */
  "the",
  "a",
  "an",
  "what's",
  "what",
  "in",
  "on",
  "of",
  "is",
  "are",
  "did",
  "do",
  "does",
  "who",
  "why",
  "where",
  "when",
  "how",
  "doc",
  "document",
  "file",
  "please",
  "can",
  "you",
  "tell",
  "me",
  "about",
  "this",
  "that",
  "our",
  "my",
  /* Question-frame verbs and prepositions. These anchor user INTENT, not
     the entity to search for. Dropping them is what lets Graph match the
     extracted keywords to a real document. */
  "summarize",
  "summarize",
  "summary",
  "search",
  "find",
  "look",
  "looking",
  "show",
  "open",
  "read",
  "review",
  "give",
  "fetch",
  "get",
  "pull",
  "grab",
  "list",
  "for",
  "to",
  "from",
  "with",
  "and",
  "or",
  "up",
  "out",
  "any",
  "some",
  "all",
  "attended",
  "attend",
  "attending",
  "going",
  "went",
  "had",
  "have",
  "has",
  "want",
  "need",
  "see",
  "know",
  "i",
  "we",
  "us",
  "they",
  "them",
  "it",
  "its",
  "us",
]);

/**
 * Placeholder token that the tokenizer preserves as a single unit. We pick
 * a marker that survives `split(/[^\w.\-']+/)` (so it contains only word
 * chars) AND is unlikely to appear in real questions. The `__FROZEN_<n>__`
 * form satisfies both since underscores are word chars per JS regex.
 */
const PLACEHOLDER_PREFIX = "__FROZEN_";
const PLACEHOLDER_SUFFIX = "__";

/**
 * Strict placeholder check: must match the exact `__FROZEN_<F|Q><digits>__`
 * shape we generate. We do NOT use simple startsWith/endsWith because the
 * user's question might contain `__FROZEN__` literally; we'd then drop the
 * fake placeholder during restoration and corrupt output.
 */
const PLACEHOLDER_TOKEN_RE = /^__FROZEN_[FQ]\d+__$/;
function isPlaceholder(token: string): boolean {
  return PLACEHOLDER_TOKEN_RE.test(token);
}

/** Normalize curly apostrophes to ASCII so smart quotes don't bypass stopwords. */
function normalizeApostrophes(s: string): string {
  return s.replace(/[‘’ʼ]/g, "'");
}

interface FrozenRun {
  placeholder: string;
  original: string;
}

function freezeRuns(input: string): { masked: string; runs: FrozenRun[] } {
  const runs: FrozenRun[] = [];
  let masked = input;

  let qi = 0;
  masked = masked.replace(QUOTED_PHRASE_RE, (m) => {
    const placeholder = `${PLACEHOLDER_PREFIX}Q${qi++}${PLACEHOLDER_SUFFIX}`;
    runs.push({ placeholder, original: m });
    return placeholder;
  });

  let fi = 0;
  masked = masked.replace(FILE_EXT_RE, (m) => {
    const placeholder = `${PLACEHOLDER_PREFIX}F${fi++}${PLACEHOLDER_SUFFIX}`;
    runs.push({ placeholder, original: m });
    return placeholder;
  });

  return { masked, runs };
}

/** Token starts with capital, not at sentence start (idx > 0). */
function isProperNoun(token: string, idx: number): boolean {
  if (idx === 0) return false;
  if (token.length < 2) return false;
  return /^[A-Z][a-z]+/.test(token);
}

/** Token is a number (3, 3.14, 2026, 4.20). */
function isNumberLike(token: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(token);
}

/**
 * Build a Graph `queryString` from a user question. Always returns a
 * non-empty string when the input has any non-whitespace content: if
 * extraction yields nothing usable, returns the trimmed original question
 * so Graph at least sees the verbatim text rather than an empty body.
 */
export function buildSearchQueryString(question: string): string {
  const raw = String(question ?? "");
  const trimmed = normalizeApostrophes(raw).trim();
  if (!trimmed) return trimmed;

  /* Always-on acronym pass. Collected up front so casing isn't lost when
     the rest of the pipeline lowercases tokens. */
  const acronyms = Array.from(new Set(trimmed.match(ACRONYM_RE) ?? []));

  /* Freeze file tokens + quoted phrases so stopword + lowercase passes
     don't mangle them. */
  const { masked, runs } = freezeRuns(trimmed);

  /* Tokenize on whitespace + most punctuation. Preserve dot-numbers (4.20)
     and frozen placeholders. We split on anything that isn't a word char,
     dot, dash, or apostrophe. */
  const tokens = masked
    .split(/[^\w.\-']+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const kept: string[] = [];
  /* Track the index of the first NON-stopword token. We never treat that
     as "sentence start" for proper-noun detection (because the user often
     starts with a verb like "Search" we'd want to drop). */
  let firstNonFiller = -1;

  tokens.forEach((tok, idx) => {
    if (isPlaceholder(tok)) {
      kept.push(tok);
      return;
    }

    /* Strip dangling punctuation: leading/trailing dashes or apostrophes. */
    const cleaned = tok.replace(/^[-']+|[-']+$/g, "");
    if (!cleaned) return;

    const lower = cleaned.toLowerCase();
    const isStop = STOPWORDS.has(lower);
    if (firstNonFiller === -1 && !isStop) firstNonFiller = idx;
    if (isStop) return;

    if (isNumberLike(cleaned)) {
      kept.push(cleaned);
      return;
    }

    /* Proper noun heuristic. Pretend the first NON-filler token is at
       index 1 so it doesn't get treated as sentence start. */
    const adjustedIdx = idx === firstNonFiller ? 1 : idx;
    if (isProperNoun(cleaned, adjustedIdx)) {
      kept.push(cleaned);
      return;
    }

    /* All caps stays in line. */
    if (/^[A-Z]{2,5}$/.test(cleaned)) {
      kept.push(cleaned);
      return;
    }

    /* Alphanumeric mix (Q1, B2B, A4) is almost always an identifier. Keep
       it regardless of length. */
    if (/[A-Za-z]/.test(cleaned) && /\d/.test(cleaned)) {
      kept.push(cleaned);
      return;
    }

    if (cleaned.length > 2) {
      kept.push(lower);
    }
  });

  /* Restore frozen runs in place. */
  const restored: string[] = kept
    .map((t) => {
      if (!isPlaceholder(t)) return t;
      const run = runs.find((r) => r.placeholder === t);
      return run ? run.original : "";
    })
    .filter((t) => t.length > 0);

  /* Append acronyms not already present (case-sensitive comparison). */
  for (const a of acronyms) {
    if (!restored.includes(a)) restored.push(a);
  }

  /* Dedupe while preserving order. */
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of restored) {
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }

  const joined = deduped.join(" ").trim();
  if (!joined) return trimmed;
  return joined;
}

/** Test-only exports for table-driven coverage. */
export const __internal = {
  STOPWORDS,
  FILE_EXT_RE,
  QUOTED_PHRASE_RE,
  ACRONYM_RE,
  freezeRuns,
  isProperNoun,
  isNumberLike,
  isPlaceholder,
};
