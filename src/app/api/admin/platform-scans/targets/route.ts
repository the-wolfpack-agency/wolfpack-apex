import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listScanTargets } from "@/lib/platform-scan/manifests";

/**
 * GET /api/admin/platform-scans/targets -> the scan targets the operator can
 * choose from. Drives the platform selector in the review UI so a scan is always
 * run against an explicitly chosen platform (and findings are labeled by it).
 * Gated on settings.manage_team.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ targets: listScanTargets() });
}
