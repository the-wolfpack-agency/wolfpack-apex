/**
 * POST /api/admin/audit-log/reanchor
 *
 * Acknowledge a KNOWN, non-tamper break in the audit hash chain at a given seq
 * (e.g. the seq-509 concurrency fork). This NEVER rewrites history — it records
 * an acknowledged re-anchor so verifyChain stops failing on that expected break
 * while STILL catching any real tampering elsewhere.
 *
 * Gated by `settings.manage_team`. The action is audited (hash-chained) and
 * emits `system.audit_log_reanchored` inside reanchorChain.
 *
 * Body: { seq: number, reason: string }
 * Responses: 200 { seq, reason, acknowledgedBy, alreadyAnchored } | 400 | 403
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { reanchorChain, reconcileChain } from "@/lib/audit-log";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const body = await req
    .json()
    .catch(() => ({} as { seq?: unknown; reason?: unknown; mode?: unknown }));

  // mode: "reconcile" drains the WHOLE backlog of authentic concurrency forks in
  // one click (no per-seq whack-a-mole), refusing if any genuine tamper exists.
  // Default (single seq) stays for explicit, one-off acknowledgements.
  if ((body as { mode?: unknown }).mode === "reconcile") {
    const recon = await reconcileChain({ user_id: user.id, role: user.role });
    return NextResponse.json(recon, { status: recon.refused ? 409 : 200 });
  }

  const seqRaw = (body as { seq?: unknown }).seq;
  const reasonRaw = (body as { reason?: unknown }).reason;

  const seq = Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 1) {
    return NextResponse.json(
      { error: "`seq` is required and must be a positive integer" },
      { status: 400 },
    );
  }

  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length === 0) {
    return NextResponse.json(
      { error: "`reason` is required (why this break is a known, non-tamper event)" },
      { status: 400 },
    );
  }

  const result = await reanchorChain(seq, reason, {
    user_id: user.id,
    role: user.role,
  });

  return NextResponse.json(result, { status: 200 });
}
