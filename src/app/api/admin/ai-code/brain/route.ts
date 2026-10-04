/**
 * /api/admin/ai-code/brain - observe + warm the factory's reuse brain.
 *
 *   GET            -> 200 { reuseCorpus: { total } }   (how warm is the brain)
 *   POST { repo }  -> 200 { written, indexed, total }  (BACKFILL: persist this
 *                     repo's code paths into the corpus + index them NOW, instead
 *                     of waiting for runs to fill it)
 *
 * The backfill is how we seed the brain from repos that already have run history:
 * it fetches the live tree, writes the corpus (producer), and embeds it (indexer).
 * Both are the merged, flag-independent building blocks; this just drives them on
 * demand so the corpus is observable and seedable from the UI.
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. The backfill writes
 * DERIVED/rebuildable corpus data, but it IS a deliberate admin mutation, so it is
 * audited (recordAuditNonFatal) + emits ai_code.brain_backfilled. Never 500s a
 * completed backfill on a transient audit hiccup.
 *
 * Returns: 200 | 400 (bad repo) | 401/403 (auth/entitlement)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { trackEvent } from "@/lib/analytics";
import { recordAuditNonFatal, extractRequestMetadata } from "@/lib/audit-log";
import { workspaceGithubClient, fetchRepoTree } from "@/lib/github-client";
import { isValidRepo } from "@/lib/ai-code/watched-repos";
import { countReuseCorpus } from "@/lib/ai-code/factory-reuse-store";
import { rememberRepoTree } from "@/lib/ai-code/factory-reuse-producer";
import { indexReuseCorpus } from "@/lib/ai-code/factory-reuse-index";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;
  const workspaceId = resolveWorkspace(auth.user.workspaceId);
  const total = await countReuseCorpus(workspaceId);
  return NextResponse.json({ reuseCorpus: { total } }, { status: 200 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof (body as { repo?: unknown })?.repo === "string" ? (body as { repo: string }).repo.trim() : "";
  if (!isValidRepo(repo)) return NextResponse.json({ error: "repo must be owner/name" }, { status: 400 });

  const workspaceId = resolveWorkspace(auth.user.workspaceId);

  // Fetch the live tree + warm the corpus. Best-effort + never throws from the
  // building blocks; a GitHub failure yields written:0 rather than a 500.
  let written = 0;
  let indexed = 0;
  try {
    const client = await workspaceGithubClient(workspaceId);
    if (client.token) {
      const tree = await fetchRepoTree(client, repo).catch(() => [] as string[]);
      ({ written } = await rememberRepoTree({ workspaceId, repo, treePaths: tree }));
      ({ indexed } = await indexReuseCorpus({ workspaceId, repo }));
    }
  } catch {
    // leave written/indexed at 0; the response reports the honest result
  }

  const total = await countReuseCorpus(workspaceId);

  const meta = extractRequestMetadata(req);
  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.brain.backfilled",
    resourceType: "reuse_corpus",
    resourceId: `${workspaceId}:${repo}`,
    afterState: { workspace_id: workspaceId, repo, written, indexed, total },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  });
  trackEvent("ai_code.brain_backfilled", auth.user.id, auth.user.role, {
    workspace_id: workspaceId,
    repo,
    written,
    indexed,
  });

  return NextResponse.json({ written, indexed, total }, { status: 200 });
}
