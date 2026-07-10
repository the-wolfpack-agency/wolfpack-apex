/**
 * POST /api/tools/screenshot  { url }
 *
 * Captures a screenshot of a URL and stores it, returning a workspace-internal
 * URL that serves the PNG (GET /api/tools/screenshot/[id]). This is what lets
 * an agent (via the capture_screenshot operation) hand back visual proof of a
 * change. The URL is SSRF-guarded before any browser runs, so an agent can
 * never be steered into screenshotting an internal service.
 *
 * Capability: settings.manage_team (same gate as the agent/team admin surface).
 * Node runtime + a longer maxDuration because a real browser capture takes a
 * few seconds.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { captureScreenshot } from "@/lib/tools/screenshot";
import { storeScreenshot, MAX_SCREENSHOT_BYTES } from "@/lib/tools/screenshot/store";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const result = await captureScreenshot({ url, fullPage: true });
  if (!result.ok) {
    // ssrf -> 400 (caller error); not_configured -> 503; else 502 (upstream browser).
    const status =
      result.code === "ssrf_blocked" ? 400 : result.code === "not_configured" ? 503 : 502;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }
  if (result.png.length > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json(
      { error: `screenshot too large (${result.png.length} bytes)`, code: "too_large" },
      { status: 413 },
    );
  }

  const { id, byteSize } = await storeScreenshot({
    workspaceId: auth.user.workspaceId ?? "default",
    createdBy: auth.user.id,
    sourceUrl: url,
    png: result.png,
  });

  // Capturing a (possibly client-owned) page is security-relevant, so it is
  // hash-chained. Best-effort: an audit failure must not fail the request.
  try {
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "tools.screenshot_captured",
      resourceType: "agent_screenshot",
      resourceId: id,
      afterState: { source_url: url, byte_size: byteSize },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[tools/screenshot audit]", (err as Error).message);
  }

  const imageUrl = `/api/tools/screenshot/${id}`;
  // `fullRedirectUrl` mirrors the operation-result convention the agent executor
  // reads, so the screenshot URL also surfaces in the task step text; `imageUrl`
  // is what the step thumbnail renders.
  return NextResponse.json(
    { id, imageUrl, fullRedirectUrl: imageUrl, byteSize },
    { status: 201 },
  );
}
