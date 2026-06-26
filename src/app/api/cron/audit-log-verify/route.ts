/**
 * GET /api/cron/audit-log-verify
 *
 * Scheduled break-glass verification of the compliance audit hash chain
 * (`instinct_audit_log`). The OGIAM decision ledger is already notarized +
 * verified hourly by its own cron; the compliance log, by contrast, was only
 * ever verified when an admin manually clicked "Verify" on /admin/audit-log.
 * A silent tamper (a row UPDATE that slipped past the append-only trigger, a
 * restored-from-backup gap, a malicious edit) would sit undetected until the
 * next manual check. This cron closes that window: it recomputes the chain
 * every hour and raises a high/critical alert the instant the chain breaks.
 *
 * Two auth paths (mirrors /api/cron/integration-health):
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron hits this
 *      hourly. Returns false when CRON_SECRET is unset (local dev) so the
 *      user/session path is the only way in.
 *   2. User path: `requireCapability(req, "settings.manage_team")` for an admin
 *      triggering a manual verification.
 * Fails closed when neither path authorizes.
 *
 * Never 500s on a RECOVERABLE error: a top-level throw (no DB, transient query
 * failure) returns a zeroed 200 so the cron health-monitor stays green — same
 * contract as integration-health. A genuine chain-INVALID result is NOT an
 * error: it is the real security signal, so it returns `{ ok:true, valid:false,
 * ... }` alongside the alert.
 *
 * Emits `audit.chain_verified` on every run with `{ valid, checked }`. On an
 * invalid chain it additionally emits the existing
 * `system.audit_log_tamper_suspected` (the same event the manual verify route
 * fires) and notifies every `settings.manage_team` holder at critical priority.
 */

import { NextRequest, NextResponse } from "next/server";
import { safeQuery } from "@/lib/db";
import { verifyChain } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import {
  requireCapability,
  effectiveCapabilitiesFor,
} from "@/lib/auth/require-capability";
import { notify } from "@/lib/notifications/in-app";
import type { TeamMember } from "@/lib/auth";

/**
 * Cron secret check. Mirrors the helper in /api/cron/integration-health so all
 * cron-triggered endpoints share one mental model. Returns false when
 * CRON_SECRET is unset (local dev) so the user-session path is the only way in.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

/** Capability that gates the /admin/audit-log surface; the admins we alert. */
const AUDIT_ADMIN_CAPABILITY = "settings.manage_team" as const;

interface ActiveMemberRow {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  workspace_id: string | null;
}

/**
 * Alert every workspace admin (settings.manage_team holder) that the audit
 * chain failed verification. Break-glass signal → critical priority so it
 * bypasses quiet hours + digest batching. Best-effort and resolved through the
 * canonical capability resolver (reusing the notify-readers.ts pattern) so a
 * per-user grant or revoke is honored. Never throws into the cron path.
 */
async function alertAdminsChainBroken(detail: {
  brokenAt: number;
  reason: string;
  checkedCount: number;
}): Promise<number> {
  let recipientCount = 0;
  try {
    const { rows } = await safeQuery<ActiveMemberRow>(
      `SELECT id, email, name, role, workspace_id
         FROM instinct_team_members
        WHERE is_active = true`,
    );
    const body =
      `The compliance audit hash chain failed verification at seq ` +
      `${detail.brokenAt} (${detail.reason}). ${detail.checkedCount} entries ` +
      `were checked. This is a break-glass tamper signal — investigate now.`;
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
        if (!capabilities.has(AUDIT_ADMIN_CAPABILITY)) continue;

        await notify({
          userId: row.id,
          category: "security",
          priority: "critical",
          title: "Audit chain verification FAILED",
          body,
          actionUrl: "/admin/audit-log",
          actionLabel: "Open audit log",
          source: "audit-log-verify",
          sourceId: `broken-${detail.brokenAt}`,
          metadata: {
            broken_at: detail.brokenAt,
            reason: detail.reason,
            checked_count: detail.checkedCount,
          },
          dedup: true,
        });
        recipientCount += 1;
      } catch (err) {
        console.warn(
          `[cron/audit-log-verify] alert skip ${row.id}:`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[cron/audit-log-verify] admin alert fanout failed:",
      (err as Error).message,
    );
  }
  return recipientCount;
}

async function runVerify(
  actorId: string,
  actorRole: string,
): Promise<NextResponse> {
  try {
    const result = await verifyChain();

    // Always record that the unattended verifier ran, with its outcome.
    trackEvent("audit.chain_verified", actorId, actorRole, {
      valid: result.valid,
      checked: result.checkedCount,
    });

    if (result.valid) {
      return NextResponse.json({ ok: true, valid: true, checked: result.checkedCount });
    }

    // INVALID is a real signal, not an error. Fire the existing tamper event,
    // alert the admins at critical priority, and return the failure detail.
    const brokenAt = result.brokenAt ?? -1;
    const reason = result.reason ?? "unknown";
    trackEvent("system.audit_log_tamper_suspected", actorId, actorRole, {
      broken_at: brokenAt,
      reason,
      checked_count: result.checkedCount,
    });
    const alerted = await alertAdminsChainBroken({
      brokenAt,
      reason,
      checkedCount: result.checkedCount,
    });

    return NextResponse.json({
      ok: true,
      valid: false,
      brokenAt,
      reason,
      checked: result.checkedCount,
      alerted,
    });
  } catch (err) {
    // Recoverable conditions (no DB, transient query failure) must not flap the
    // cron health monitor: return a zeroed 200, never 500. A broken chain does
    // NOT reach here — that path returns valid:false above.
    console.error("[cron/audit-log-verify]", (err as Error).message);
    return NextResponse.json({ ok: true, valid: true, checked: 0, skipped: true });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return runVerify("cron", "system");
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runVerify(auth.user.id, auth.user.role);
}
