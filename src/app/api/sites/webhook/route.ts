/**
 * /api/sites/webhook — deploy result receiver.
 *
 * The wolfpack-site-template canary workflow POSTs here when a deploy
 * finishes (success or failure). We verify a shared secret in the
 * X-Wolfpack-Webhook-Secret header to keep this endpoint closed to the
 * public internet, then update project state and emit tracked events.
 *
 * Body shape:
 *   { deployId, status: "success"|"failed", previewUrl?, canaryPassed?,
 *     logExcerpt?, findings? }
 *
 * NO authentication via JWT — this is a server-to-server call from GitHub
 * Actions which doesn't have a user. The shared-secret check is the only
 * gate. Set WOLFPACK_SITES_WEBHOOK_SECRET in both Instinct AND the client
 * repo's Actions secrets.
 */

import { NextRequest, NextResponse } from "next/server";
import { recordDeployResult } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import { sanitizeForLog } from "@/lib/log-sanitize";

export async function POST(req: NextRequest) {
  const expected = process.env.WOLFPACK_SITES_WEBHOOK_SECRET;
  const provided = req.headers.get("x-wolfpack-webhook-secret");
  if (!expected || provided !== expected) {
    trackEvent("system.search_performed", "webhook", "system", {
      reason: "sites_webhook_signature_invalid",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    deployId?: string;
    status?: "success" | "failed";
    previewUrl?: string;
    canaryPassed?: boolean;
    logExcerpt?: string;
    findings?: unknown[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.deployId || (body.status !== "success" && body.status !== "failed")) {
    return NextResponse.json({ error: "deployId and status required" }, { status: 400 });
  }

  try {
    await recordDeployResult(body.deployId, {
      status: body.status,
      previewUrl: body.previewUrl,
      canaryPassed: body.canaryPassed,
      logExcerpt: body.logExcerpt,
      findings: body.findings,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[sites/webhook]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
