/**
 * PATCH /api/admin/feedback/[id] — mark resolved / reopen.
 *
 * Body: { action: "resolve" | "reopen", note?: string }
 * Capability: settings.manage_team (same as /api/admin/feedback GET).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { resolveFeedback, reopenFeedback } from "@/lib/feedback/resolve-feedback";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    action?: string;
    note?: string;
  } | null;
  if (!body || (body.action !== "resolve" && body.action !== "reopen")) {
    return NextResponse.json(
      { error: "action must be 'resolve' or 'reopen'" },
      { status: 400 },
    );
  }

  try {
    if (body.action === "resolve") {
      const row = await resolveFeedback({
        workspaceId: auth.user.workspaceId,
        feedbackId: id,
        resolverId: auth.user.id,
        resolverRole: auth.user.role,
        note: body.note,
      });
      return NextResponse.json({ ok: true, feedback: row });
    } else {
      const row = await reopenFeedback({
        workspaceId: auth.user.workspaceId,
        feedbackId: id,
        reopenerId: auth.user.id,
        reopenerRole: auth.user.role,
      });
      return NextResponse.json({ ok: true, feedback: row });
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/i.test(msg)) {
      return NextResponse.json({ error: "feedback not found" }, { status: 404 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
