/**
 * Run the Microsoft sync workers that were written and never called.
 *
 * The dispatcher and its five workers have existed and been correct since they
 * were written, and nothing invoked them. Every canonical table held zero rows
 * and eleven learning extractors read them, so the learning layer produced
 * nothing while the product called Graph live on every request and kept none
 * of it.
 *
 * Per user, with that person's own delegated token, so nobody sees anything
 * their Microsoft permissions do not already allow. Which entities are kept is
 * configuration rather than a default: see sync/selection.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { syncAllEntities } from "@/lib/ms-graph/sync";
import { selectedEntities, notSelected } from "@/lib/ms-graph/sync/selection";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/* Same shape as the other crons: Vercel presents the shared secret, and an
   unset secret means nothing is authorised rather than everything. */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const only = selectedEntities();
  if (only.length === 0) {
    /* Reported, never silent. A deployment that decided to keep nothing looks
       identical to one where the cron is broken unless it says which it is. */
    return NextResponse.json({
      ok: true,
      synced: 0,
      entities: [],
      note: "MS_SYNC_ENTITIES is none, so nothing is being kept. This is a setting, not a failure.",
    });
  }

  /* Everybody who has connected Microsoft. A user whose token cannot be
     refreshed is handled inside the workers, which return an error field
     rather than throwing, so one stale account cannot stop the rest. */
  const { rows } = await safeQuery<{ user_email: string }>(
    `SELECT DISTINCT user_email FROM instinct_ms_tokens ORDER BY user_email`,
  );

  const results = [];
  for (const r of rows) {
    const res = await syncAllEntities(r.user_email, { only }).catch(() => null);
    if (res) results.push(res);
  }

  const created = results.reduce((s, r) => s + r.totalCreated, 0);
  const updated = results.reduce((s, r) => s + r.totalUpdated, 0);
  const failed = [...new Set(results.flatMap((r) => r.failedEntityTypes))];

  trackEvent("ms_sync.user_synced", "system", "system", {
    users: results.length,
    entities: only.join(","),
    created,
    updated,
    failed: failed.join(",") || "none",
  });

  return NextResponse.json({
    ok: true,
    users: results.length,
    entities: only,
    notKept: notSelected(only),
    created,
    updated,
    failedEntityTypes: failed,
  });
}
