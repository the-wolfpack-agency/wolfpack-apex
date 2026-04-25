/**
 * GET /api/automations — list every registered automation.
 *
 * Returns the LIGHT metadata projection (no parsers, no assembler) so
 * the dashboard `/automations` index can render without server-only
 * imports leaking client-side.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listAutomationMetadata } from "@/lib/automations/registry";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ automations: listAutomationMetadata() });
}
