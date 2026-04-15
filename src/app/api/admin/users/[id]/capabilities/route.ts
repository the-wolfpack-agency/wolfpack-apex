/**
 * GET /api/admin/users/[id]/capabilities
 *
 * Returns the target user's effective capability set with a per-cap
 * source trace (role / grant / revoked / expired-grant).
 * Requires: `admin.roles.assign`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  loadUserOverrides,
  emptyOverrides,
  resolveCapabilities,
  traceCapabilities,
} from "@/lib/auth/capability-overrides";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "admin.roles.assign");
  if (!auth.ok) return auth.response;

  const { id: targetUserId } = await params;

  const stored = await loadUserOverrides(targetUserId);
  if (!stored && process.env.DATABASE_URL) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  const role = stored?.role ?? "";
  const overrides = stored?.overrides ?? emptyOverrides();
  const effective = Array.from(resolveCapabilities(role, overrides)).sort();
  const trace = traceCapabilities(role, overrides);

  return NextResponse.json({
    user_id: targetUserId,
    role,
    overrides,
    effective,
    trace,
  });
}
