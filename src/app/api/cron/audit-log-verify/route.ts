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
import { verifyChain, reconcileChain } from "@/lib/audit-log";
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
      `were checked. This is a break-glass tamper signal: investigate now.`;
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

/**
 * Inform admins that legacy concurrency forks were auto-reconciled. HIGH, not
 * critical: these are cryptographically authentic rows that were only mis-linked
 * by the pre-advisory-lock race, now acknowledged + re-verified. Surfacing it
 * (rather than silently healing) keeps a human in the loop without the alert
 * fatigue that a critical-per-hour would cause. Same capability-resolved fanout
 * as the tamper alert. Never throws into the cron path.
 */
async function alertAdminsForksReconciled(detail: {
  reconciled: number;
  forkSeqs: number[];
  nowValid: boolean;
}): Promise<number> {
  let recipientCount = 0;
  try {
    const { rows } = await safeQuery<ActiveMemberRow>(
      `SELECT id, email, name, role, workspace_id
         FROM instinct_team_members
        WHERE is_active = true`,
    );
    const preview = detail.forkSeqs.slice(0, 10).join(", ");
    const more = detail.forkSeqs.length > 10 ? ` (+${detail.forkSeqs.length - 10} more)` : "";
    const body =
      `${detail.reconciled} legacy concurrency fork${detail.reconciled === 1 ? "" : "s"} ` +
      `in the audit chain ${detail.reconciled === 1 ? "was" : "were"} auto-reconciled ` +
      `(authentic rows mis-linked by the old pre-lock race, now acknowledged). ` +
      `Seqs: ${preview}${more}. Chain re-verified ${detail.nowValid ? "VALID" : "still failing, review needed"}.`;
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
          priority: "high",
          title: "Audit chain: legacy forks auto-reconciled",
          body,
          actionUrl: "/admin/audit-log",
          actionLabel: "Open audit log",
          source: "audit-log-verify",
          sourceId: `reconciled-${detail.forkSeqs[0] ?? 0}`,
          metadata: {
            reconciled: detail.reconciled,
            fork_seqs: detail.forkSeqs.slice(0, 50),
            now_valid: detail.nowValid,
          },
          dedup: true,
        });
        recipientCount += 1;
      } catch (err) {
        console.warn(
          `[cron/audit-log-verify] reconcile-notify skip ${row.id}:`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[cron/audit-log-verify] reconcile notify fanout failed:",
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

    // INVALID. Before alerting, classify the WHOLE chain: authentic concurrency
    // forks (pre-advisory-lock legacy races, cryptographically valid rows that
    // were just mis-linked) self-heal; genuine content tampering does not.
    const recon = await reconcileChain({ user_id: actorId, role: actorRole });

    if (recon.refused) {
      // Real tamper present (a rewritten row). NOTHING was anchored. This is the
      // break-glass signal: critical alert, no self-heal.
      const brokenAt = recon.tamperSeqs[0] ?? result.brokenAt ?? -1;
      trackEvent("system.audit_log_tamper_suspected", actorId, actorRole, {
        broken_at: brokenAt,
        reason: "entry_hash_mismatch",
        checked_count: recon.checkedCount,
      });
      const alerted = await alertAdminsChainBroken({
        brokenAt,
        reason: "entry_hash_mismatch (content tamper)",
        checkedCount: recon.checkedCount,
      });
      return NextResponse.json({
        ok: true,
        valid: false,
        brokenAt,
        reason: "entry_hash_mismatch",
        tamperSeqs: recon.tamperSeqs,
        checked: recon.checkedCount,
        alerted,
      });
    }

    // Only authentic forks: they have now been acknowledged. Record the
    // self-heal as a learning signal, notify admins at HIGH (not critical) so
    // benign legacy forks no longer cause alert fatigue, and re-verify to
    // confirm the chain reads clean.
    trackEvent("system.audit_log_forks_reconciled", actorId, actorRole, {
      reconciled: recon.reconciled,
      fork_count: recon.forkSeqs.length,
      checked_count: recon.checkedCount,
    });
    const reVerify = await verifyChain();
    let notified = 0;
    if (recon.reconciled > 0) {
      notified = await alertAdminsForksReconciled({
        reconciled: recon.reconciled,
        // List the seqs newly anchored THIS run, so the listed seqs match the
        // reported count (forkSeqs also includes already-acknowledged forks).
        forkSeqs: recon.newlyReconciledSeqs,
        nowValid: reVerify.valid,
      });
    }

    return NextResponse.json({
      ok: true,
      valid: reVerify.valid,
      reconciled: recon.reconciled,
      forkSeqs: recon.newlyReconciledSeqs,
      checked: reVerify.checkedCount,
      notified,
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
