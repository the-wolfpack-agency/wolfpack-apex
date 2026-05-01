/**
 * POST /api/principles/sync-now — leadership-on-demand sync trigger.
 *
 * Same logic as the /api/cron/principles-sync route, but session-
 * authenticated (the /principles team-tab UI calls this directly).
 * Optionally also runs the eval cron afterward when ?evaluate=1 is
 * passed, so leadership can populate the dashboard end-to-end with
 * one click.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { resolvePrinciplesConfig } from "@/lib/principles/config";
import { fetchSharePointDocx } from "@/lib/principles/sharepoint-fetch";
import { parseDocxBuffer } from "@/lib/principles/parser";
import {
  syncPrinciplesFromParsed,
  recordDocVersion,
  getLatestDocVersion,
} from "@/lib/principles/store";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const cfg = await resolvePrinciplesConfig();
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      code: "not_configured",
      message: "Set the SharePoint doc URL first.",
    });
  }

  /* Step 1: fetch the doc bytes via the resolved owner's M365 token. */
  const fetchResult = await fetchSharePointDocx(cfg.ownerUserId!, cfg.docUrl!);
  if (!fetchResult.ok) {
    trackEvent("principle.sync_failed", user.id, user.role, {
      stage: "fetch",
      code: fetchResult.code,
    });
    return NextResponse.json({
      ok: false,
      code: fetchResult.code,
      message: fetchResult.message,
    });
  }

  /* Step 2: parse. */
  const parsed = await parseDocxBuffer(fetchResult.bytes);

  /* Step 3: change-detect. */
  const last = await getLatestDocVersion(cfg.docUrl!);
  if (last && last.docHash === parsed.sourceHash) {
    return NextResponse.json({
      ok: true,
      unchanged: true,
      principleCount: parsed.principles.length,
      hash: parsed.sourceHash,
    });
  }

  /* Step 4: record + sync. */
  await recordDocVersion({
    sourceUrl: cfg.docUrl!,
    docHash: parsed.sourceHash,
    parsedPrincipleCount: parsed.principles.length,
    parseWarnings: parsed.warnings,
    triggeredBy: "manual",
  });
  let outcome;
  try {
    outcome = await syncPrinciplesFromParsed({
      parsed: parsed.principles,
      sourceUrl: cfg.docUrl!,
      sourceDocHash: parsed.sourceHash,
    });
  } catch (err) {
    trackEvent("principle.sync_failed", user.id, user.role, {
      stage: "sync",
      message: (err as Error).message,
    });
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  trackEvent("principle.sync_completed", user.id, user.role, {
    inserted: outcome.inserted.length,
    unchanged: outcome.unchanged.length,
    retired: outcome.retired.length,
    warnings: parsed.warnings.length,
    triggered: "manual",
  });

  return NextResponse.json({
    ok: true,
    unchanged: false,
    inserted: outcome.inserted.map((p) => p.slug),
    retired: outcome.retired.map((p) => p.slug),
    warnings: parsed.warnings,
    ownerAutoDetected: cfg.ownerAutoDetected,
  });
}
