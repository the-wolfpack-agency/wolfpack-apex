/**
 * GET /api/config/ms-capabilities
 *
 * Server-side scope probe: returns which Tier 2 MS 365 capabilities are
 * currently wired up, based on the static MS_SCOPES list. The UI uses this
 * to enable/disable features that depend on scopes added incrementally by
 * parallel streams (Stream D owns MS_SCOPES, streams B/E/F consume it).
 *
 * This endpoint is CHEAP — no Graph call, no DB hit. It reflects the
 * *requested* scope set, which is the correct signal for UI gating:
 *   - if we never requested the scope, the token can't have it
 *   - if we DID request it and the user refused, they'll hit a 403 with
 *     `code: "scope_missing"` on the actual mutation and the UI should
 *     offer a reconnect flow from there
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getScopeCapabilities } from "@/lib/ms-capabilities";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const caps = getScopeCapabilities();
  return NextResponse.json(caps);
}
