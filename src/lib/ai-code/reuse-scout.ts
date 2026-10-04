/**
 * Reuse scout - the "semantic / whole-repo retrieval" step that buildRepoContext
 * (path-only) explicitly deferred.
 *
 * buildRepoContext only surfaces files the prompt NAMES by path. So a task phrased
 * by INTENT ("add a cost counter") gives the author zero reuse candidates, and it
 * writes a duplicate of code that already exists - the functional-duplication
 * failure that name-based no-duplicate-export cannot see (a new name, same purpose).
 *
 * This scores the repo's file tree (the one fetchRepoTree already returns) against
 * the prompt's intent keywords and surfaces the existing files that most likely
 * already implement it, as a "REUSE THESE" block prepended to the author prompt.
 *
 * Deterministic + best-effort: pure scoring, never throws, returns "" when nothing
 * scores. Precision over noise - only paths that actually match several keywords.
 */
import type { GithubClient } from "@/lib/github-client";
import { fetchRepoTree } from "@/lib/github-client";

/** Only source files are reuse candidates (not lockfiles, assets, snapshots). */
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|sql|py|rb|go|rs|java|php)$/i;
/** A test/snapshot/generated file is not a reuse target. */
const NOT_REUSABLE = /(?:^|\/)(__tests__|__mocks__|node_modules|\.next|dist|build)\//i;

/** Common words that carry no intent signal. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "add", "new", "create",
  "make", "build", "update", "change", "should", "must", "when", "then", "else", "also",
  "return", "returns", "function", "export", "exports", "file", "code", "test", "tests",
  "value", "values", "number", "string", "boolean", "pure", "include", "including",
  "src", "lib", "app", "api", "route", "page", "component", "handler", "endpoint",
  // Generic repo / DB structural terms that match a huge fraction of files, so two
  // of them coinciding falsely scored a brand-new build as a duplicate of an
  // unrelated file. "instinct" is the repo's own prefix; "table"/"migration" are on
  // every migration; "check" is a bare verb. A real duplicate matches on a
  // distinctive CONCEPT (e.g. "cost-summary", "status-pill"), never on these.
  // Found by the live client-build dogfood: a /ping route flagged as
  // check-credentials.ts, a feedback-table migration as 014_instinct_table_aliases.sql.
  "instinct", "table", "tables", "check", "checks", "migration", "migrations",
]);

/**
 * A small, curated synonym map for the domains that duplicate most often (money,
 * auth, time). Extensible: one line per concept. Keeps the scout from missing a
 * reuse because the prompt said "price" and the file said "cost".
 */
const SYNONYMS: Record<string, string[]> = {
  cost: ["price", "spend", "spending", "billing", "charge", "chargeback"],
  price: ["cost", "spend", "billing"],
  spend: ["cost", "price", "usage"],
  counter: ["total", "tally", "metric", "sum", "aggregate"],
  auth: ["login", "session", "token", "credential"],
  login: ["auth", "signin", "session"],
  duration: ["time", "elapsed", "ms"],
};

/** Significant, lowercased intent tokens from a prompt (stopwords + short dropped). */
export function extractIntentKeywords(prompt: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9]+/)) {
    const w = raw.replace(/s$/, ""); // crude singularize so "counters" matches "counter"
    if (w.length < 4) continue;
    if (/^\d+$/.test(w)) continue;
    if (STOPWORDS.has(raw) || STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** Expand keywords with their curated synonyms (deduped). */
function withSynonyms(keywords: readonly string[]): Set<string> {
  const set = new Set<string>(keywords);
  for (const k of keywords) for (const s of SYNONYMS[k] ?? []) set.add(s);
  return set;
}

const tokenize = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase -> words
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .map((t) => t.replace(/s$/, ""));

/**
 * Tokens of a path in three tiers of specificity. The filename is the strongest
 * signal; the parent directory matters because Next.js route/page files are all
 * named the same (the concept lives in the dir, e.g. `insights/ai-cost/route.ts`);
 * ancestors are weak context.
 */
function pathTokens(path: string): { filename: Set<string>; parent: Set<string>; ancestor: Set<string> } {
  const segs = path.replace(CODE_FILE, "").split("/");
  const last = segs.length - 1;
  return {
    filename: new Set(tokenize(segs[last] ?? "")),
    parent: new Set(last >= 1 ? tokenize(segs[last - 1] ?? "") : []),
    ancestor: new Set(segs.slice(0, Math.max(0, last - 1)).flatMap(tokenize)),
  };
}

export interface ReuseCandidate {
  path: string;
  score: number;
}

/**
 * Rank repo paths by how strongly their name matches the prompt's intent. A match
 * in the FILENAME is worth more than one in a parent directory. Paths the prompt
 * already named are excluded (buildRepoContext covers those). Only paths matching
 * at least two distinct keyword concepts survive, so the block stays high-signal.
 */
export function scoreReuseCandidates(
  keywords: readonly string[],
  treePaths: readonly string[],
  excludePaths: readonly string[] = [],
  topN = 8,
): ReuseCandidate[] {
  if (keywords.length === 0) return [];
  const terms = withSynonyms(keywords);
  const excluded = new Set(excludePaths);
  const scored: ReuseCandidate[] = [];
  for (const path of treePaths) {
    if (excluded.has(path)) continue;
    if (!CODE_FILE.test(path) || NOT_REUSABLE.test(path)) continue;
    const { filename, parent, ancestor } = pathTokens(path);
    let score = 0;
    for (const term of terms) {
      // Count each concept at its strongest tier only (no double counting).
      if (filename.has(term)) score += 4;
      else if (parent.has(term)) score += 3;
      else if (ancestor.has(term)) score += 1;
    }
    // A single strong (filename or parent-dir) concept match qualifies; weak
    // ancestor-only hits do not, so a deeply-nested coincidence can't flood the list.
    if (score >= 3) scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, topN);
}

/** The author-prompt block. Empty string when there is nothing to reuse. */
export function buildReuseBlock(candidates: readonly ReuseCandidate[]): string {
  if (candidates.length === 0) return "";
  const lines = candidates.map((c) => `- ${c.path}`);
  return [
    "REUSE CHECK - existing files whose names strongly match this task. Before writing",
    "NEW code, read these and REUSE or EXTEND them; do not re-implement what already exists:",
    ...lines,
    "If none of them actually cover the task, proceed - but say which you ruled out and why.",
  ].join("\n");
}

/**
 * Find reuse candidates for a prompt against a repo. Best-effort: fetches the tree
 * (one API call, run in parallel with grounding) and scores it. Never throws.
 */
export async function findReuseCandidates(args: {
  client: GithubClient;
  repo: string;
  prompt: string;
  ref?: string;
  excludePaths?: readonly string[];
  /** When present (+ semantic reuse on), the PERSISTED corpus index is searched
   *  first; without it the scout uses the in-memory per-run widening only. */
  workspaceId?: string;
}): Promise<{ block: string; candidates: ReuseCandidate[]; semantic: boolean }> {
  try {
    const tree = await fetchRepoTree(args.client, args.repo, args.ref);
    const keywords = extractIntentKeywords(args.prompt);
    const candidates = scoreReuseCandidates(keywords, tree, args.excludePaths ?? []);

    // Optional, flag-gated semantic widening: surface synonym/intent matches the
    // curated keyword map misses. Falls back to keyword-only on any failure.
    const semantic = await maybeWidenSemantically({
      prompt: args.prompt,
      keywords,
      treePaths: tree,
      keywordCandidates: candidates,
      excludePaths: args.excludePaths ?? [],
      repo: args.repo,
      workspaceId: args.workspaceId,
    });

    const finalCandidates = semantic ?? candidates;
    return { block: buildReuseBlock(finalCandidates), candidates: finalCandidates, semantic: semantic !== null };
  } catch {
    return { block: "", candidates: [], semantic: false };
  }
}

/**
 * Resolve the Azure embedder (never throwing) and widen the keyword candidates.
 * Returns null when semantic reuse is off or no embedder is available, so the
 * caller keeps the keyword candidates verbatim. Kept here so reuse-scout.ts has no
 * hard dependency on the rag-provider wiring until the flag is on.
 */
async function maybeWidenSemantically(args: {
  prompt: string;
  keywords: readonly string[];
  treePaths: readonly string[];
  keywordCandidates: readonly ReuseCandidate[];
  excludePaths: readonly string[];
  repo: string;
  workspaceId?: string;
}): Promise<ReuseCandidate[] | null> {
  try {
    const { semanticReuseEnabled, widenReuseWithSemantics, mergeReuseCandidates } = await import("@/lib/ai-code/reuse-scout-semantic");
    if (!semanticReuseEnabled()) return null;

    // WARM PATH: search the PERSISTED corpus index (factory brain). One query
    // embed, no per-run candidate embedding, and it carries cross-run memory.
    // Only when we know the workspace (the index is workspace+repo scoped).
    if (args.workspaceId) {
      try {
        const { searchReuseCorpus } = await import("@/lib/ai-code/factory-reuse-index");
        const excluded = new Set(args.excludePaths);
        const hits = await searchReuseCorpus({ workspaceId: args.workspaceId, repo: args.repo, query: args.prompt });
        const fresh = hits.filter((h) => !excluded.has(h.path)).map((h) => ({ path: h.path, score: h.score }));
        if (fresh.length > 0) return mergeReuseCandidates(args.keywordCandidates, fresh);
      } catch {
        // fall through to the in-memory cold-start path
      }
    }

    // COLD PATH: corpus empty/unavailable -> in-memory widening over the tree.
    const { getEmbeddingProvider } = await import("@/lib/rag-providers/factory");
    let provider;
    try {
      provider = getEmbeddingProvider(); // throws when not configured
    } catch {
      return null;
    }
    return await widenReuseWithSemantics({
      embed: (texts) => provider.embed(texts),
      prompt: args.prompt,
      keywords: args.keywords,
      treePaths: args.treePaths,
      keywordCandidates: args.keywordCandidates,
      excludePaths: args.excludePaths,
    });
  } catch {
    return null;
  }
}
