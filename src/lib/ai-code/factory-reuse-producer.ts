/**
 * Factory brain: the PRODUCER. Turns a repo's file tree into reuse-corpus docs and
 * persists them (pt1 store), so the corpus fills as runs happen - the source the
 * derived vector index (pt2) is built from.
 *
 * Called best-effort from a factory run (the run already fetched the tree), so it
 * must be cheap and never block or throw: it writes the humanized PATHS only (no
 * embedding here - that is the indexer cron's job, off the hot path).
 */
import { isReusableCodePath, humanizePath } from "./reuse-scout-semantic";
import { rememberReuseCorpus, type ReuseCorpusDoc } from "./factory-reuse-store";

/** Keep a run's corpus write bounded regardless of repo size (the store also caps). */
export const MAX_PRODUCER_DOCS = 2000;

/**
 * Pure: a repo tree -> reuse-corpus docs. Keeps only source files (not tests/build
 * artifacts), humanizes each path into its retrieval text, dedupes, and caps.
 */
export function repoTreeToDocs(treePaths: readonly string[]): ReuseCorpusDoc[] {
  const seen = new Set<string>();
  const docs: ReuseCorpusDoc[] = [];
  for (const path of treePaths) {
    if (typeof path !== "string") continue;
    const p = path.trim();
    if (!p || seen.has(p) || !isReusableCodePath(p)) continue;
    const text = humanizePath(p);
    if (!text) continue;
    seen.add(p);
    docs.push({ path: p, text });
    if (docs.length >= MAX_PRODUCER_DOCS) break;
  }
  return docs;
}

/**
 * Persist a repo's tree into the reuse corpus. Never throws (best-effort from a
 * run). Returns how many docs were written (0 on empty tree or any failure).
 */
export async function rememberRepoTree(args: {
  workspaceId: string;
  repo: string;
  treePaths: readonly string[];
  commitSha?: string;
}): Promise<{ written: number }> {
  try {
    const docs = repoTreeToDocs(args.treePaths);
    if (docs.length === 0) return { written: 0 };
    return await rememberReuseCorpus({
      workspaceId: args.workspaceId,
      repo: args.repo,
      commitSha: args.commitSha,
      docs,
    });
  } catch {
    return { written: 0 };
  }
}
