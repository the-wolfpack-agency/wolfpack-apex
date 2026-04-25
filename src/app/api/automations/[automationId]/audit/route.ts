/**
 * GET /api/automations/[automationId]/audit
 *
 * List recent automated actions on this automation. Powers the audit
 * history widget and the per-class "what just happened?" surface.
 *
 * Auth: `automations.view` capability — same as the rest of the
 * read-side automations dashboard.
 *
 * Query params:
 *   class_key  — optional, narrow to one class
 *   since      — optional ISO timestamp, only rows with created_at >=
 *   limit      — optional, 1..500 (default 100)
 *
 * Response shape:
 *   200 { actions: AuditActionRecord[] }
 *   404 { error } when the automation id is unknown
 *
 * Each row includes a derived `revertable` boolean computed from
 * `created_at` + `reverted_at` so the UI doesn't need to duplicate the
 * 24h window calculation.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import {
  isWithinUndoWindow,
  listActionsForAutomation,
} from "@/lib/automations/porsche-classes/audit-repo";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string }> },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found", automationId },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const class_key = url.searchParams.get("class_key") ?? undefined;
  const since = url.searchParams.get("since") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const actions = await listActionsForAutomation({
    automation_id: automation.id,
    class_key,
    since,
    limit,
  });

  // Decorate with `revertable` so the client doesn't reimplement the
  // 24h-window check. Reverted rows are NEVER revertable (idempotent).
  const decorated = actions.map((a) => ({
    ...a,
    revertable: a.reverted_at == null && isWithinUndoWindow(a.created_at),
  }));

  return NextResponse.json({ actions: decorated });
}
