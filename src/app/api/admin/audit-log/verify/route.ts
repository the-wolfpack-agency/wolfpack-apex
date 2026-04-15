/**
 * POST /api/admin/audit-log/verify
 *
 * Recompute the hash chain end-to-end. Returns `{ valid, brokenAt?, checkedCount }`.
 * Emits `system.audit_log_tamper_suspected` on failure.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { verifyChain } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";
import type { Capability } from "@/lib/auth/capabilities";

const AUDIT_CAPABILITY = "admin.audit_log.view" as Capability;

async function checkAuth(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (user.role === "ceo" || user.role === "cto") return { ok: true as const, user };
  try {
    const { capabilities } = await effectiveCapabilitiesFor(user);
    if (capabilities.has(AUDIT_CAPABILITY)) return { ok: true as const, user };
  } catch {
    // ignore
  }
  return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
}

export async function POST(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const body = await req.json().catch(() => ({} as { from_seq?: number; to_seq?: number }));
  const result = await verifyChain(body.from_seq, body.to_seq);

  if (!result.valid) {
    trackEvent("system.audit_log_tamper_suspected", user.id, user.role, {
      broken_at: result.brokenAt ?? -1,
      reason: result.reason ?? "unknown",
      checked_count: result.checkedCount,
    });
  }

  return NextResponse.json(result);
}
