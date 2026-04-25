/**
 * POST /api/automations/[automationId]/audit/[id]/revert
 *
 * Revert (undo) an automated action recorded in
 * `instinct_automation_audit_actions`. Dispatches to the right
 * kind-specific handler in `audit-revert.ts`, then marks the audit row
 * reverted (audit-repo.revertAction).
 *
 * Auth: `automations.override` is the closest fit in the registered
 * capability set — undoing a class_match merge IS an override action,
 * undoing a SharePoint upload IS a destructive admin operation, and
 * undoing an auto-split is the same trust level as resolving an
 * exception. The spec asks for `automations.manage` first but that
 * capability is NOT registered in `src/lib/auth/capabilities.ts`; we
 * use `automations.override` per the same reasoning the upload-
 * sharepoint route uses `automations.run` (capability-coverage guardrail
 * test will refuse anything else).
 *
 * Status codes:
 *   200 → reverted successfully
 *   404 → automation, action_id, or kind dispatch unknown
 *   409 → action was already reverted
 *   410 → action is older than the 24h undo window
 *   502 → revert handler failed (Graph rejected, pg outage, etc.)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { trackEvent } from "@/lib/analytics";
import {
  getActionById,
  isWithinUndoWindow,
  revertAction,
  type AuditActionRecord,
} from "@/lib/automations/porsche-classes/audit-repo";
import {
  revertClassMatchMerge,
  revertSharepointUpload,
  revertSurveyAutoSplit,
} from "@/lib/automations/porsche-classes/audit-revert";

interface Ctx {
  params: Promise<{ automationId: string; id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "automations.override");
  if (!auth.ok) return auth.response;

  const { automationId, id } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found", automationId },
      { status: 404 },
    );
  }

  const action = await getActionById(id);
  if (!action || action.automation_id !== automation.id) {
    return NextResponse.json(
      { error: "audit action not found", id },
      { status: 404 },
    );
  }

  if (action.reverted_at != null) {
    return NextResponse.json(
      {
        error: "action already reverted",
        reverted_at: action.reverted_at,
        reverted_by: action.reverted_by,
      },
      { status: 409 },
    );
  }

  if (!isWithinUndoWindow(action.created_at)) {
    return NextResponse.json(
      {
        error: "undo window expired (24h)",
        created_at: action.created_at,
      },
      { status: 410 },
    );
  }

  // Dispatch on action_kind. Each handler returns ok|error and never
  // throws. We do NOT mark the audit row reverted unless the handler
  // succeeded — the audit row is the source of truth for the timeline,
  // a half-applied revert (e.g. SharePoint DELETE failed mid-flight)
  // must remain visibly un-reverted so the operator can retry.
  const result = await dispatchRevert(action, {
    userId: auth.user.id,
    userEmail: auth.user.email,
  });
  if (!result.ok) {
    trackEvent("automations.override_applied", auth.user.id, auth.user.role, {
      automation_id: automation.id,
      kind: action.action_kind,
      revert_failed: true,
    });
    return NextResponse.json(
      { ok: false, error: result.error, kind: action.action_kind },
      { status: 502 },
    );
  }

  // Mark audit row reverted. Returns null when the row was reverted by
  // another concurrent request between our checks above and here — we
  // surface that as 409 (already reverted) rather than 200 so the client
  // doesn't silently double-bill the undo.
  const updated = await revertAction(action.id, auth.user.email);
  if (!updated) {
    return NextResponse.json(
      { error: "action was concurrently reverted" },
      { status: 409 },
    );
  }

  trackEvent("automations.override_applied", auth.user.id, auth.user.role, {
    automation_id: automation.id,
    kind: action.action_kind,
    reverted: true,
  });

  return NextResponse.json({ ok: true, action: updated });
}

/* ------------------------------------------------------------------ */
/* Dispatch helper                                                     */
/* ------------------------------------------------------------------ */

interface DispatchCtx {
  userId: string;
  userEmail: string | null;
}

async function dispatchRevert(
  action: AuditActionRecord,
  ctx: DispatchCtx,
): Promise<{ ok: true } | { ok: false; error: string }> {
  switch (action.action_kind) {
    case "class_match_merge":
      return revertClassMatchMerge(
        action as AuditActionRecord<"class_match_merge">,
      );
    case "sharepoint_upload":
      return revertSharepointUpload(
        action as AuditActionRecord<"sharepoint_upload">,
        { userId: ctx.userId, userEmail: ctx.userEmail },
      );
    case "survey_auto_split":
      return revertSurveyAutoSplit(
        action as AuditActionRecord<"survey_auto_split">,
      );
    default:
      // The CHECK constraint on the table prevents new kinds from
      // landing without a revert handler, so this is a defensive
      // never-arm. If we ever widen the union, the type-checker will
      // flag this default block as exhaustive-mismatched.
      return {
        ok: false,
        error: `no revert handler for action_kind=${action.action_kind}`,
      };
  }
}
