/**
 * GET /api/cron/ai-code-reuse-index - the factory brain's INDEXER.
 *
 * The producer (a factory run) writes repo paths into the reuse corpus (Postgres
 * source of truth) with embedded=false. Embedding is costly, so it runs here on a
 * schedule rather than on the run's hot path: this cron embeds the un-embedded
 * corpus rows for every enabled watched repo and upserts their vectors to Qdrant,
 * marking each row embedded only after the vector lands.
 *
 * Auth mirrors the other crons: Authorization: Bearer ${CRON_SECRET}, with a
 * manage-team capability fallback for a manual run. Never throws: a per-repo
 * failure is recorded in the response and skipped. Degrades to indexed:0 when the
 * embedder or Qdrant is unavailable (the corpus still fills; indexing retries).
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { listAllEnabledWatched } from "@/lib/ai-code/watched-repos";
import { indexReuseCorpus, defaultReuseIndexDeps } from "@/lib/ai-code/factory-reuse-index";
import { indexFailureMemory, defaultFailureIndexDeps } from "@/lib/ai-code/factory-failure-index";

/** Per-repo cap per cron tick, so one invocation can't run an unbounded embed job. */
const PER_REPO_LIMIT = 500;

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && isAuthorizedBearer(req.headers.get("authorization"), secret);
}

async function run(): Promise<NextResponse> {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: true, indexed: 0, repos: 0, note: "no database" });
  }
  // Resolve the embedder + Qdrant once; share across repos. Null => nothing to do
  // (no embedder configured) - the corpus still accumulates for a later tick.
  const deps = await defaultReuseIndexDeps();
  if (!deps || !deps.qdrant) {
    return NextResponse.json({ ok: true, indexed: 0, repos: 0, note: "indexer not configured (embedder/Qdrant)" });
  }

  // The failure memory shares the same embedder + Qdrant; index it in the same
  // sweep (own deps so the loaders/collection differ). Null => no embedder (same
  // degrade as above), so only run it when available.
  const failureDeps = await defaultFailureIndexDeps();

  const targets = await listAllEnabledWatched().catch(() => []);
  let total = 0;
  let failuresTotal = 0;
  const detail: Array<{ workspaceId: string; repo: string; indexed: number; failures: number }> = [];
  for (const t of targets) {
    let indexed = 0;
    let failures = 0;
    try {
      ({ indexed } = await indexReuseCorpus({ workspaceId: t.workspaceId, repo: t.repo, limit: PER_REPO_LIMIT, deps }));
    } catch { /* never let one repo abort the sweep */ }
    try {
      if (failureDeps) ({ indexed: failures } = await indexFailureMemory({ workspaceId: t.workspaceId, repo: t.repo, limit: PER_REPO_LIMIT, deps: failureDeps }));
    } catch { /* same */ }
    total += indexed;
    failuresTotal += failures;
    if (indexed > 0 || failures > 0) detail.push({ workspaceId: t.workspaceId, repo: t.repo, indexed, failures });
  }
  return NextResponse.json({ ok: true, repos: targets.length, indexed: total, failuresIndexed: failuresTotal, detail });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
  }
  return run();
}
