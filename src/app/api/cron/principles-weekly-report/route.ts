/**
 * GET /api/cron/principles-weekly-report
 *
 * Mondays 8am UTC. Pulls last 7 days of observations + active
 * principles, builds the markdown report, upserts the row keyed by
 * week_start so re-running for the same week replaces.
 *
 * Bearer CRON_SECRET auth.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import {
  listActivePrinciples,
  listAllObservations,
} from "@/lib/principles/store";
import { resolveUserNames } from "@/lib/principles/user-names";
import {
  buildWeeklyReportMarkdown,
  upsertWeeklyReport,
} from "@/lib/principles/weekly-report";
import { resolvePrinciplesConfig } from "@/lib/principles/config";
import { writeWeeklyReportToSharePoint } from "@/lib/principles/sharepoint-write";

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
  const now = new Date();
  const weekEnd = now;
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [principles, observations] = await Promise.all([
    listActivePrinciples(),
    listAllObservations({ sinceISO: weekStart.toISOString(), limit: 5000 }),
  ]);

  const subjectIds = Array.from(
    new Set(
      observations
        .map((o) => o.subjectUserId)
        .filter((u): u is string => !!u),
    ),
  );
  const names = await resolveUserNames(subjectIds);

  const markdown = buildWeeklyReportMarkdown({
    weekStart,
    weekEnd,
    principles,
    observations,
    names,
  });

  let saved;
  try {
    saved = await upsertWeeklyReport({
      weekStart: weekStart.toISOString().slice(0, 10),
      weekEnd: weekEnd.toISOString().slice(0, 10),
      markdownBody: markdown,
      observationCount: observations.length,
      principleCount: principles.length,
    });
  } catch (err) {
    trackEvent("principle.weekly_report_failed", "system", "system", {
      error: (err as Error).message,
    });
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }

  trackEvent("principle.weekly_report_published", "system", "system", {
    week_start: saved.weekStart,
    observation_count: saved.observationCount,
    principle_count: saved.principleCount,
  });

  /* SharePoint write-back leg. Best-effort: persisted markdown row is
     the canonical artifact (the in-app /principles banner reads from
     it). The .docx in SharePoint is the leadership-facing convenience
     copy — failure here MUST NOT roll back the markdown publish, so
     the response below still reports the upsert outcome verbatim and
     the Graph result rides alongside.

     Skipped vs failed analytics events let the learning loop tell the
     two cases apart:
       - skipped: config gap or scope gap (no nag, recoverable in UI)
       - failed:  Graph 5xx / network / docx build error (retry next run) */
  const config = await resolvePrinciplesConfig();
  const sharepoint = await writeWeeklyReportToSharePoint({
    report: saved,
    config: {
      docUrl: config?.docUrl ?? null,
      ownerUserId: config?.ownerUserId ?? null,
    },
  });

  if (sharepoint.ok) {
    trackEvent("principle.weekly_report_uploaded", "system", "system", {
      week_start: saved.weekStart,
      byte_count: sharepoint.byteCount,
      web_url: sharepoint.webUrl ?? "",
      item_id: sharepoint.itemId,
    });
  } else if (sharepoint.status === "skipped") {
    trackEvent("principle.weekly_report_upload_skipped", "system", "system", {
      week_start: saved.weekStart,
      reason: sharepoint.reasonCode,
    });
  } else {
    trackEvent("principle.weekly_report_upload_failed", "system", "system", {
      week_start: saved.weekStart,
      reason: sharepoint.reasonCode,
      error: sharepoint.message,
    });
  }

  return NextResponse.json({
    ok: true,
    weekStart: saved.weekStart,
    weekEnd: saved.weekEnd,
    observationCount: saved.observationCount,
    principleCount: saved.principleCount,
    sharepoint: sharepoint.ok
      ? {
          status: "uploaded",
          webUrl: sharepoint.webUrl,
          byteCount: sharepoint.byteCount,
        }
      : { status: sharepoint.status, reason: sharepoint.reasonCode },
  });
}
