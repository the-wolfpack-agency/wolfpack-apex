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

  /* Step 2: parse. mammoth throws on non-docx bytes (e.g. when
     SharePoint returns an HTML sign-in page because the resolved
     owner token lacks access to the doc). Catch + surface the actual
     reason rather than a generic 500. */
  let parsed;
  try {
    parsed = await parseDocxBuffer(fetchResult.bytes);
  } catch (err) {
    /* Sniff the first ~100 bytes — if it starts with `<!DOCTYPE` or
       `<html`, the fetch returned HTML instead of the .docx. That's
       almost always an auth/permission failure on the doc. */
    const head = fetchResult.bytes.slice(0, 200).toString("utf-8");
    const looksLikeHtml = /^\s*<!doctype|^\s*<html/i.test(head);
    const code = looksLikeHtml ? "doc_access_denied" : "parse_failed";
    const message = looksLikeHtml
      ? "SharePoint returned an HTML page instead of the .docx — the doc owner's M365 token can't open this file. Make sure a CEO/CTO with M365 connected has at least Read access to the SharePoint doc."
      : `Couldn't parse the .docx: ${(err as Error).message}`;
    trackEvent("principle.sync_failed", user.id, user.role, {
      stage: "parse",
      code,
      bytes_head: head.slice(0, 80),
    });
    return NextResponse.json({ ok: false, code, message });
  }

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
    /* Return 200 with ok:false so the UI can show the actual reason
       (a 500 with no body shows "500" and nothing else useful). */
    return NextResponse.json({
      ok: false,
      code: "sync_failed",
      message: `DB write failed: ${(err as Error).message}`,
    });
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
