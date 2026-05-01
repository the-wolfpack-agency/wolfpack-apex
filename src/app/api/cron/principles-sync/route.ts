/**
 * GET /api/cron/principles-sync
 *
 * Vercel cron target. Pulls Hoxsie's operating-principles SharePoint
 * doc, parses it, change-detects against the last stored hash, syncs
 * principles to the DB if changed, and emits analytics for the
 * inserted/unchanged/retired delta.
 *
 * Auth model:
 *   - Vercel cron sends a request with `Authorization: Bearer <CRON_SECRET>`.
 *   - We require CRON_SECRET in env and reject anything else with 401.
 *   - The fetch itself uses a per-user M365 token (the configured
 *     PRINCIPLES_DOC_OWNER_USER_ID env var) — keeps the security
 *     surface aligned with the rest of the M365 integration.
 *
 * Env:
 *   CRON_SECRET                   — Vercel cron auth token (already set).
 *   PRINCIPLES_DOC_URL            — full SharePoint sharing URL of the doc.
 *   PRINCIPLES_DOC_OWNER_USER_ID  — Instinct user id whose M365 token
 *                                   reads the doc on behalf of the org.
 *
 * Returns:
 *   200 { ok: true, ... }   — sync ran (with optional `unchanged: true`
 *                             if hash matched the stored version).
 *   200 { ok: false, code } — non-fatal failure (not_connected, etc.).
 *   401                     — missing or wrong CRON_SECRET.
 *   500                     — DB write or unexpected lib failure.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import { fetchSharePointDocx } from "@/lib/principles/sharepoint-fetch";
import { parseDocxBuffer } from "@/lib/principles/parser";
import {
  syncPrinciplesFromParsed,
  recordDocVersion,
  getLatestDocVersion,
} from "@/lib/principles/store";
import { resolvePrinciplesConfig } from "@/lib/principles/config";

function requireCron(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export async function GET(req: NextRequest) {
  if (!requireCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /* Self-service config: DB row first, env vars second. Auto-picks
     a leadership user's M365 token when no explicit owner is set. */
  const cfg = await resolvePrinciplesConfig();
  if (!cfg) {
    return NextResponse.json({
      ok: false,
      code: "not_configured",
      message:
        "Open /principles → Connect SharePoint doc to set up. (Or set PRINCIPLES_DOC_URL env for env-driven deploys.)",
    });
  }
  const sourceUrl = cfg.docUrl!;
  const ownerUserId = cfg.ownerUserId!;

  /* Step 1 — fetch the .docx bytes. */
  const fetchResult = await fetchSharePointDocx(ownerUserId, sourceUrl);
  if (!fetchResult.ok) {
    trackEvent("principle.sync_failed", ownerUserId, "system", {
      stage: "fetch",
      code: fetchResult.code,
    });
    return NextResponse.json({
      ok: false,
      code: fetchResult.code,
      message: fetchResult.message,
    });
  }

  /* Step 2 — parse. */
  const parsed = await parseDocxBuffer(fetchResult.bytes);

  /* Step 3 — change-detect. */
  const last = await getLatestDocVersion(sourceUrl);
  if (last && last.docHash === parsed.sourceHash) {
    trackEvent("principle.sync_unchanged", ownerUserId, "system", {
      hash: parsed.sourceHash,
      principle_count: parsed.principles.length,
    });
    return NextResponse.json({
      ok: true,
      unchanged: true,
      principleCount: parsed.principles.length,
      hash: parsed.sourceHash,
    });
  }

  /* Step 4 — record the new doc-version row (always insert when hash
     changes, even if the parsed list is empty, so we can audit a
     parse-warning storm). */
  await recordDocVersion({
    sourceUrl,
    docHash: parsed.sourceHash,
    parsedPrincipleCount: parsed.principles.length,
    parseWarnings: parsed.warnings,
    triggeredBy: "cron",
  });

  /* Step 5 — sync principles + signals. */
  let outcome;
  try {
    outcome = await syncPrinciplesFromParsed({
      parsed: parsed.principles,
      sourceUrl,
      sourceDocHash: parsed.sourceHash,
    });
  } catch (err) {
    console.error("[cron/principles-sync]", (err as Error).message);
    trackEvent("principle.sync_failed", ownerUserId, "system", {
      stage: "sync",
      message: (err as Error).message,
    });
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }

  trackEvent("principle.sync_completed", ownerUserId, "system", {
    inserted: outcome.inserted.length,
    unchanged: outcome.unchanged.length,
    retired: outcome.retired.length,
    warnings: parsed.warnings.length,
  });

  return NextResponse.json({
    ok: true,
    unchanged: false,
    hash: parsed.sourceHash,
    inserted: outcome.inserted.map((p) => p.slug),
    unchanged_slugs: outcome.unchanged.map((p) => p.slug),
    retired: outcome.retired.map((p) => p.slug),
    warnings: parsed.warnings,
  });
}
