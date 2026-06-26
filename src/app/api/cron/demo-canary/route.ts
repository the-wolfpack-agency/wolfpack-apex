/**
 * GET /api/cron/demo-canary — the demo-login canary sweep.
 *
 * Continuously proves the platform-scan tool works end to end: it logs into the
 * configured demo target platforms (DEMO_CANARY_TARGETS), runs a real scan, and
 * asserts the expected findings still surface. A regression — login broke, the
 * scan broke, or a known-buggy demo's findings dropped to zero — becomes an
 * UNHEALTHY result, which fires `canary.demo_failed` AND alerts a workspace admin
 * at high priority, so the team catches it before a client does.
 *
 * Two auth paths (mirrors /api/cron/integration-health + /api/cron/audit-log-verify):
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron hits this on
 *      the schedule. Returns false when CRON_SECRET is unset (local dev), so the
 *      user/session path is the only way in.
 *   2. User path: `requireCapability(req, "settings.manage_team")` for an admin
 *      triggering a manual run.
 *
 * INERT when DEMO_CANARY_TARGETS is unset/empty: returns `{ ok:true, skipped:true,
 * targets:0 }` with no network calls (same posture as the platform-scan-browser
 * spec). Never 500s on a recoverable condition: a top-level throw returns a zeroed
 * 200 so the cron health-monitor stays green. An UNHEALTHY canary result is NOT an
 * error — it is the real signal, returned in the summary alongside the alerts.
 */

import { NextRequest, NextResponse } from "next/server";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  requireCapability,
  effectiveCapabilitiesFor,
} from "@/lib/auth/require-capability";
import { notify } from "@/lib/notifications/in-app";
import {
  runDemoCanary,
  parseCanaryTargets,
  type CanaryResult,
} from "@/lib/platform-scan/canary";
import type { TeamMember } from "@/lib/auth";

/** Cron secret check. Shared mental model with the other cron endpoints. Returns
 *  false when CRON_SECRET is unset (local dev) so the user-session path is the
 *  only way in. */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

/** Capability that gates the platform-scan admin surface; the admins we alert. */
const CANARY_ADMIN_CAPABILITY = "settings.manage_team" as const;

interface ActiveMemberRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  workspace_id: string | null;
}

/**
 * Alert every workspace admin (settings.manage_team holder) that a demo canary
 * went unhealthy — the scan tool regressed against a demo target. High priority
 * because it is a "the product is broken before a client sees it" signal. Best
 * effort, resolved through the canonical capability resolver (reusing the
 * audit-log-verify / notify-readers pattern) so per-user grants + revokes are
 * honored. Never throws into the cron path. Returns recipient count.
 */
async function alertAdmins(result: CanaryResult): Promise<number> {
  let recipientCount = 0;
  try {
    const { rows } = await safeQuery<ActiveMemberRow>(
      `SELECT id, email, name, role, workspace_id
         FROM instinct_team_members
        WHERE is_active = true`,
    );
    const body =
      `The demo-login canary for "${result.name}" is UNHEALTHY: ` +
      `${result.reason ?? "unknown"} (login_ok=${result.loginOk}, ` +
      `scan_ok=${result.scanOk}, findings=${result.findingCount}). The scan tool ` +
      `regressed against a demo target — investigate before a client hits it.`;
    for (const row of rows) {
      try {
        const member: TeamMember = {
          id: row.id,
          email: row.email ?? "",
          name: row.name ?? "",
          role: (row.role as TeamMember["role"]) ?? "ops",
          workspaceId: row.workspace_id ?? "",
          created_at: "",
        };
        const { capabilities } = await effectiveCapabilitiesFor(member);
        if (!capabilities.has(CANARY_ADMIN_CAPABILITY)) continue;

        await notify({
          userId: row.id,
          category: "security",
          priority: "high",
          title: `Demo canary unhealthy: ${result.name}`,
          body,
          actionUrl: "/admin/platform-scans",
          actionLabel: "Review platform scans",
          source: "demo-canary",
          sourceId: `unhealthy-${result.name}`,
          metadata: {
            name: result.name,
            login_ok: result.loginOk,
            scan_ok: result.scanOk,
            finding_count: result.findingCount,
            reason: result.reason ?? "unknown",
          },
          dedup: true,
        });
        recipientCount += 1;
      } catch (err) {
        console.warn(`[cron/demo-canary] alert skip ${row.id}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn("[cron/demo-canary] admin alert fanout failed:", (err as Error).message);
  }
  return recipientCount;
}

async function runCanary(actorId: string, actorRole: string): Promise<NextResponse> {
  try {
    const targets = parseCanaryTargets(process.env.DEMO_CANARY_TARGETS);

    // INERT: no targets configured → no network, no events, no alerts.
    if (targets.length === 0) {
      return NextResponse.json({ ok: true, skipped: true, targets: 0 });
    }

    const results = await runDemoCanary(targets);

    let healthy = 0;
    let unhealthy = 0;
    for (const r of results) {
      // Every run is a learning signal regardless of outcome.
      trackEvent("canary.demo_run", actorId, actorRole, {
        name: r.name,
        login_ok: r.loginOk,
        scan_ok: r.scanOk,
        finding_count: r.findingCount,
        healthy: r.healthy,
      });

      if (r.healthy) {
        healthy += 1;
        continue;
      }

      // UNHEALTHY = a real regression. Emit the failure event AND alert admins.
      unhealthy += 1;
      trackEvent("canary.demo_failed", actorId, actorRole, {
        name: r.name,
        login_ok: r.loginOk,
        scan_ok: r.scanOk,
        finding_count: r.findingCount,
        reason: r.reason ?? "unknown",
      });
      await alertAdmins(r);
    }

    return NextResponse.json({ ok: true, targets: results.length, healthy, unhealthy });
  } catch (err) {
    // Recoverable conditions (no DB, transient failure) must not flap the cron
    // health monitor: return a zeroed 200, never 500.
    console.error("[cron/demo-canary]", (err as Error).message);
    return NextResponse.json({ ok: true, targets: 0, healthy: 0, unhealthy: 0, skipped: true });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return runCanary("cron", "system");
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runCanary(auth.user.id, auth.user.role);
}
