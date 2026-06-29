/**
 * POST /api/admin/ai-surfaces/scan — run shadow-AI discovery over source.
 *
 * Body: { target: string, files: [{ path, content }] }. Detects every LLM SDK
 * call, hardcoded provider endpoint, and AI key, persists them to the workspace
 * inventory (a re-scan upserts), and returns the discovered set + summary. The
 * source is supplied by the caller (a repo connector / upload), so this route is
 * source-agnostic.
 *
 * Capability: settings.manage_team. Records a read-derived inventory (no domain
 * mutation) and fires ai_inventory.scan_completed - it is audit-allowlisted with
 * that reason, mirroring the agent-baseline precedent.
 *
 * Returns: 200 { result } | 400 (bad body) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { runDiscovery } from "@/lib/ai-surface/inventory";

/** Bound the request so a scan body can't be used to exhaust memory. */
const MAX_FILES = 2000;
const MAX_CONTENT = 500_000; // chars per file

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { target?: unknown; files?: unknown };
  const target = typeof b.target === "string" ? b.target.trim() : "";
  if (!target) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }
  if (!Array.isArray(b.files) || b.files.length === 0) {
    return NextResponse.json({ error: "files must be a non-empty array" }, { status: 400 });
  }
  if (b.files.length > MAX_FILES) {
    return NextResponse.json({ error: `too many files (max ${MAX_FILES})` }, { status: 400 });
  }
  const files = b.files
    .filter(
      (f): f is { path: string; content: string } =>
        !!f && typeof (f as { path?: unknown }).path === "string" && typeof (f as { content?: unknown }).content === "string",
    )
    .map((f) => ({ path: f.path, content: f.content.slice(0, MAX_CONTENT) }));
  if (files.length === 0) {
    return NextResponse.json({ error: "files must each have string path + content" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const result = await runDiscovery({ workspaceId, target, files });

  trackEvent("ai_inventory.scan_completed", auth.user.id, auth.user.role, {
    target,
    surfaces: result.surfaces.length,
    ungoverned: result.summary.ungoverned,
    written: result.written,
  });

  return NextResponse.json({ result });
}
