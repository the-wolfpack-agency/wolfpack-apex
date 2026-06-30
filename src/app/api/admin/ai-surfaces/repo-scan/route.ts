/**
 * POST /api/admin/ai-surfaces/repo-scan — LIVE scan of a public GitHub repo.
 *
 * Body: { url: string }. Fetches the repo's scannable source (github.com only,
 * SSRF-guarded, file-count + size capped — see src/lib/ai-surface/repo-fetch.ts),
 * runs the existing AI-surface detectors over it, persists the discovered
 * touchpoints to the workspace inventory (a re-scan upserts), and returns the set
 * + summary + deterministic remediation for every ungoverned gap. The single most
 * convincing "Discover" demo moment: paste a real repo, get a real inventory and
 * the path to govern each surface.
 *
 * Capability: settings.manage_team (same gate as the supplied-source scan). This
 * records the SAME read-derived inventory the existing /scan route writes (no
 * domain mutation beyond the surface inventory) and fires
 * ai_inventory.repo_scan_completed + one ai_inventory.remediation_suggested per
 * ungoverned surface. Audit-allowlisted with that reason, mirroring the
 * ai-surfaces/scan precedent.
 *
 * Returns: 200 { result } | 400 (bad/non-github URL) | 401/403 (auth)
 *          | 404 (repo not found) | 429 (rate limited) | 502 (GitHub unreachable)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { runDiscovery } from "@/lib/ai-surface/inventory";
import { fetchRepoFiles, statusForError } from "@/lib/ai-surface/repo-fetch";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const url = typeof (body as { url?: unknown })?.url === "string" ? (body as { url: string }).url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  // Fetch the repo source. Typed errors map to the right HTTP status — the
  // integration never throws, so a 404/403/rate-limit never blanks the UI.
  const fetched = await fetchRepoFiles(url);
  if (!fetched.ok) {
    return NextResponse.json(
      { error: fetched.error.message, kind: fetched.error.kind },
      { status: statusForError(fetched.error.kind) },
    );
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const { target, files, fetchedFileCount, truncated } = fetched.value;
  const result = await runDiscovery({ workspaceId, target, files });

  trackEvent("ai_inventory.repo_scan_completed", auth.user.id, auth.user.role, {
    repo: target,
    files_scanned: fetchedFileCount,
    surfaces: result.surfaces.length,
    ungoverned: result.summary.ungoverned,
  });
  // One remediation_suggested per ungoverned surface so the learning loop sees
  // which AI gaps recur across client repos.
  for (const r of result.remediations) {
    trackEvent("ai_inventory.remediation_suggested", auth.user.id, auth.user.role, {
      kind: r.kind,
      provider: r.provider,
    });
  }

  return NextResponse.json({ result: { ...result, fetchedFileCount, truncated } });
}
