/**
 * Semantic reuse widening - the layer that catches "new name, same purpose".
 *
 * The keyword reuse-scout (reuse-scout.ts) matches a prompt's intent tokens
 * against repo PATHS, widened by a hand-curated SYNONYMS map. That map is
 * necessarily incomplete: a prompt that says "spending tracker" will miss an
 * existing `src/lib/cost-summary.ts` unless someone added spend<->cost by hand.
 * Every missed reuse is a functional duplicate the author then writes - the exact
 * failure the scout exists to prevent.
 *
 * This module adds an embedding pass that surfaces candidates the keyword gate
 * REJECTED but that are semantically near the prompt, then merges them with the
 * keyword candidates (keyword always wins a tie - it is the higher-precision
 * signal). It reuses the existing Azure embedder via an injected `embed` fn, so
 * there is no new provider and no new secret.
 *
 * Posture (non-negotiable, matches the rest of ai-code):
 *   - OFF by default. Only runs when AI_CODE_SEMANTIC_REUSE is on AND an embedder
 *     is actually available. Flag off / embedder absent / embedder returns nothing
 *     -> the keyword candidates pass through UNCHANGED (zero behavior change).
 *   - NEVER throws. Any failure degrades to keyword-only.
 *   - Cost-bounded: at most MAX_EMBED_DOCS paths are embedded, chosen by a cheap
 *     lexical prescore, in ONE batched call. It never embeds a whole monorepo.
 *   - Path-level semantics only (the path, humanized), NOT file contents. Content
 *     embedding is a deliberate future increment gated on a per-run cost budget.
 */
import type { ReuseCandidate } from "@/lib/ai-code/reuse-scout";

/** Enable only when this env flag is truthy. Dark until explicitly flipped. */
export function semanticReuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AI_CODE_SEMANTIC_REUSE ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

/** Code files only, mirroring the keyword scout's candidate filter. */
const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|sql|py|rb|go|rs|java|php)$/i;
const NOT_REUSABLE = /(?:^|\/)(__tests__|__mocks__|node_modules|\.next|dist|build)\//i;

/** A path worth keeping as a reuse candidate: a source file, not a test/build
 *  artifact. Single source of truth for both the scout and the corpus producer. */
export function isReusableCodePath(path: string): boolean {
  return CODE_FILE.test(path) && !NOT_REUSABLE.test(path);
}

/** Hard ceiling on how many paths we embed in a run (cost + latency bound). */
export const MAX_EMBED_DOCS = 400;
/** Minimum cosine similarity for a semantic-only candidate to be surfaced. */
export const SEMANTIC_MIN_COSINE = 0.34;
/** Most semantic-only candidates to add on top of the keyword ones. */
export const SEMANTIC_TOP_K = 6;

/**
 * Turn a path into a bag of human words: split on separators and camelCase,
 * drop the extension, lowercase. `src/lib/cost-summary.ts` -> "src lib cost summary".
 * Pure.
 */
export function humanizePath(path: string): string {
  const noExt = path.replace(/\.[a-z0-9]+$/i, "");
  return noExt
    .split(/[\/._-]+/)
    .flatMap((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

/** Cosine similarity of two equal-length vectors. Returns 0 on any degeneracy. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cheap lexical prescore so we only embed the most promising paths when a tree is
 * large: count how many prompt keywords appear as whole words in the humanized
 * path. Keeps the embed batch bounded and on-topic. Pure.
 */
export function prescorePaths(
  keywords: readonly string[],
  treePaths: readonly string[],
  excludePaths: readonly string[] = [],
  limit = MAX_EMBED_DOCS,
): string[] {
  const excluded = new Set(excludePaths);
  const kw = keywords.map((k) => k.toLowerCase());
  const scored: { path: string; score: number }[] = [];
  for (const path of treePaths) {
    if (excluded.has(path)) continue;
    if (!isReusableCodePath(path)) continue;
    const words = new Set(humanizePath(path).split(" "));
    let score = 0;
    for (const k of kw) if (words.has(k)) score += 1;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((s) => s.path);
}

/**
 * Rank candidate paths by cosine against the prompt vector; keep those at/above
 * the threshold, highest first. `docVecs[i]` corresponds to `paths[i]`. Pure. The
 * returned score is the cosine (0..1), distinct in scale from the keyword scores.
 */
export function rankBySemantic(
  promptVec: readonly number[],
  paths: readonly string[],
  docVecs: readonly (readonly number[])[],
  threshold = SEMANTIC_MIN_COSINE,
  topK = SEMANTIC_TOP_K,
): ReuseCandidate[] {
  const out: ReuseCandidate[] = [];
  for (let i = 0; i < paths.length; i++) {
    const vec = docVecs[i];
    if (!vec || vec.length === 0) continue;
    const sim = cosine(promptVec, vec);
    if (sim >= threshold) out.push({ path: paths[i], score: sim });
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, topK);
}

/**
 * Merge keyword and semantic candidates. Keyword candidates come first and win on
 * path collision (higher-precision signal, and their integer scores are not
 * comparable to cosine floats). Semantic-only paths are appended in their own
 * order. Capped to `topN`. Pure.
 */
export function mergeReuseCandidates(
  keyword: readonly ReuseCandidate[],
  semantic: readonly ReuseCandidate[],
  topN = 8,
): ReuseCandidate[] {
  const seen = new Set(keyword.map((c) => c.path));
  const merged = [...keyword];
  for (const s of semantic) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    merged.push(s);
  }
  return merged.slice(0, topN);
}

/** Injected embedder: batched, order-preserving, never-throwing (returns [] on fail). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * Widen keyword reuse candidates with semantically-near paths the keyword gate
 * missed. Best-effort and non-throwing: returns the keyword candidates unchanged
 * whenever the embedder is unavailable, returns too few vectors, or anything
 * fails. One batched embed of [prompt, ...prescoredPaths].
 */
export async function widenReuseWithSemantics(args: {
  embed: EmbedFn;
  prompt: string;
  keywords: readonly string[];
  treePaths: readonly string[];
  keywordCandidates: readonly ReuseCandidate[];
  excludePaths?: readonly string[];
  topN?: number;
}): Promise<ReuseCandidate[]> {
  const { embed, prompt, keywords, treePaths, keywordCandidates } = args;
  const topN = args.topN ?? 8;
  try {
    const promptText = humanizePath(prompt) || prompt.trim().toLowerCase();
    if (!promptText) return [...keywordCandidates];
    // Exclude the prompt-named paths AND the keyword candidates (already surfaced).
    const exclude = [...(args.excludePaths ?? []), ...keywordCandidates.map((c) => c.path)];
    const paths = prescorePaths(keywords, treePaths, exclude);
    if (paths.length === 0) return [...keywordCandidates];

    const docs = paths.map(humanizePath);
    const vectors = await embed([promptText, ...docs]);
    // Need the prompt vector + at least one doc vector or there is nothing to rank.
    if (!Array.isArray(vectors) || vectors.length < 2) return [...keywordCandidates];
    const [promptVec, ...docVecs] = vectors;
    if (!promptVec || promptVec.length === 0) return [...keywordCandidates];

    const semantic = rankBySemantic(promptVec, paths, docVecs);
    return mergeReuseCandidates(keywordCandidates, semantic, topN);
  } catch {
    return [...keywordCandidates];
  }
}
