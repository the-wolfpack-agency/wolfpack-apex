/**
 * Factory brain, part 1: the REUSE CORPUS source of truth (Postgres).
 *
 * The semantic reuse-scout (reuse-scout-semantic.ts) embeds candidate paths
 * in-memory on every run and discards them - no memory, no improvement over time.
 * This is the authoritative, persisted corpus it will search instead: one row per
 * (workspace, repo, path) with the humanized text that gets embedded.
 *
 * Why Postgres is the source of truth (and the vector index is derived): the
 * Qdrant collection is a REBUILDABLE projection of these rows. Wipe Qdrant, re-embed
 * from this table. That is the real value of keeping the authoritative copy here -
 * durability + auditability + a backfill target - not "three copies for their own
 * sake" (we deliberately do NOT write a third Neo4j copy; it buys nothing here).
 *
 * This module is the WRITE/READ layer only. The derived vector index + similarity
 * search live in the follow-up (factory brain part 2); keeping them separate lets
 * the persistence foundation ship and be backfilled first, on its own tests.
 *
 * Never throws on read (safeQuery -> [] / 0). Writes use `query` so a genuine
 * persistence failure surfaces to the caller (a silent corpus write that failed
 * would quietly stop the tool from ever learning).
 */
import { query, safeQuery } from "@/lib/db";

export interface ReuseCorpusDoc {
  path: string;
  /** The text that represents this path for retrieval (humanized path today,
   *  a file-content summary later). Required + non-empty. */
  text: string;
}

export interface ReuseCorpusRow extends ReuseCorpusDoc {
  repo: string;
  commitSha: string;
  embedded: boolean;
  updatedAt: string;
}

/** Hard cap per write so one call can't try to persist an unbounded tree. */
export const MAX_CORPUS_WRITE = 5000;

/** Drop blank/oversized entries; dedupe by path (last wins). Pure. */
export function normalizeDocs(docs: readonly ReuseCorpusDoc[]): ReuseCorpusDoc[] {
  const byPath = new Map<string, ReuseCorpusDoc>();
  for (const d of docs) {
    const path = typeof d?.path === "string" ? d.path.trim() : "";
    const text = typeof d?.text === "string" ? d.text.trim() : "";
    if (!path || !text) continue;
    byPath.set(path, { path, text });
  }
  return [...byPath.values()].slice(0, MAX_CORPUS_WRITE);
}

/**
 * Upsert reuse-corpus rows for a repo. Marks each row embedded=false so the
 * (future) vector indexer knows it still needs a vector. Returns the count
 * written. Workspace-scoped. Idempotent on (workspace, repo, path).
 */
export async function rememberReuseCorpus(args: {
  workspaceId: string;
  repo: string;
  commitSha?: string;
  docs: readonly ReuseCorpusDoc[];
}): Promise<{ written: number }> {
  const docs = normalizeDocs(args.docs);
  if (docs.length === 0) return { written: 0 };
  const sha = args.commitSha ?? "";
  // One multi-row upsert. Parameterized; paths/text never interpolated.
  const values: string[] = [];
  const params: unknown[] = [args.workspaceId, args.repo, sha];
  let p = params.length;
  for (const d of docs) {
    values.push(`($1, $2, $${++p}, $${++p}, $3, false, now())`);
    params.push(d.path, d.text);
  }
  await query(
    `INSERT INTO instinct_factory_reuse_corpus
       (workspace_id, repo, path, text, commit_sha, embedded, updated_at)
     VALUES ${values.join(", ")}
     ON CONFLICT (workspace_id, repo, path) DO UPDATE
       SET text = EXCLUDED.text,
           commit_sha = EXCLUDED.commit_sha,
           embedded = false,
           updated_at = now()`,
    params,
  );
  return { written: docs.length };
}

/** All corpus docs for a repo (read-only; [] on any failure). */
export async function loadReuseCorpus(workspaceId: string, repo: string): Promise<ReuseCorpusRow[]> {
  const { rows } = await safeQuery<{ path: string; text: string; commit_sha: string; embedded: boolean; updated_at: string }>(
    `SELECT path, text, commit_sha, embedded, updated_at
       FROM instinct_factory_reuse_corpus
      WHERE workspace_id = $1 AND repo = $2
      ORDER BY path`,
    [workspaceId, repo],
  );
  return rows.map((r) => ({
    path: r.path,
    text: r.text,
    repo,
    commitSha: r.commit_sha,
    embedded: r.embedded,
    updatedAt: r.updated_at,
  }));
}

/** How many corpus rows a workspace has persisted (0 on failure). Drives the
 *  "is the brain warm yet" readout + the backfill progress. */
export async function countReuseCorpus(workspaceId: string, repo?: string): Promise<number> {
  const { rows } = repo
    ? await safeQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM instinct_factory_reuse_corpus WHERE workspace_id = $1 AND repo = $2`,
        [workspaceId, repo],
      )
    : await safeQuery<{ n: number }>(
        `SELECT count(*)::int AS n FROM instinct_factory_reuse_corpus WHERE workspace_id = $1`,
        [workspaceId],
      );
  return Number(rows[0]?.n ?? 0);
}
