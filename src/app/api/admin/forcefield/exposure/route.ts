/**
 * GET /api/admin/forcefield/exposure - the Forcefield Exposure panel.
 *
 * Edge-device exposure findings (firewall / SSL-VPN portals with CISA KEV
 * entries) recorded by the platform-scan flow for the workspace's VERIFIED
 * targets, plus the bundled KEV snapshot's version and whether the classifier
 * is switched on. Read-only. Outside-in exposure monitoring: Forcefield does not
 * protect the appliance, and the response says so.
 *
 * Capability: settings.manage_team + the forcefield entitlement (same gate as
 * the other Forcefield console routes). Returns 200 | 401 | 403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { listEdgeExposureFindings } from "@/lib/platform-scan/store";
import { isEdgeExposureEnabled } from "@/lib/platform-scan/edge-exposure/gate";
import { KEV_SNAPSHOT } from "@/lib/forcefield/kev";

const EXPOSURE_SCOPE_NOTE =
  "Outside-in exposure monitoring of verified targets. Forcefield does not sit in front of these appliances and does not protect them.";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "forcefield");
  if (gate) return gate;
  const rows = await listEdgeExposureFindings(auth.user.workspaceId ?? "default");
  const findings = rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    route: r.route,
    severity: r.severity,
    title: r.title,
    status: r.status,
    vendor: typeof r.evidence.vendor === "string" ? r.evidence.vendor : "",
    product: typeof r.evidence.product === "string" ? r.evidence.product : "",
    cveIds: typeof r.evidence.cve_ids === "string" ? r.evidence.cve_ids.split(",").map((s) => s.trim()).filter(Boolean) : [],
    knownRansomware: r.evidence.known_ransomware === true,
    createdAt: r.createdAt,
  }));
  return NextResponse.json({
    enabled: isEdgeExposureEnabled(),
    kev: { catalogVersion: KEV_SNAPSHOT.catalogVersion, dateReleased: KEV_SNAPSHOT.dateReleased },
    scope: EXPOSURE_SCOPE_NOTE,
    findings,
  });
}
