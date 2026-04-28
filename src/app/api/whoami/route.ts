/**
 * GET /api/whoami — returns the auth.user shape for the current session.
 *
 * Used to diagnose ms_tokens lookup mismatches: the poll endpoints feed
 * `auth.user.email ?? auth.user.id` into getValidToken, which does a
 * (connected_by OR user_email) lookup. When that returns null we need
 * to know which identity values the session actually carries so we can
 * align the token row.
 *
 * Auth: any logged-in user (we use `automations.run` since that's what
 * the poll routes require — same scope, no privilege escalation).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    id: auth.user.id,
    email: auth.user.email ?? null,
    role: auth.user.role,
    /* The exact value the poll route now passes to getValidToken: */
    poll_lookup_key: auth.user.email ?? auth.user.id,
  });
}
