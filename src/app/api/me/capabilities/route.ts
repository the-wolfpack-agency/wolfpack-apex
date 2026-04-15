/**
 * GET /api/me/capabilities
 *
 * Returns the caller's effective capabilities so the UI can hide
 * actions/nav the user can't invoke. Auth is "any logged-in user" — we do
 * not require a capability for reading one's own caps.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { capabilities, overrides } = await effectiveCapabilitiesFor(user);
  return NextResponse.json({
    user_id: user.id,
    role: user.role,
    capabilities: Array.from(capabilities).sort(),
    overrides,
  });
}
