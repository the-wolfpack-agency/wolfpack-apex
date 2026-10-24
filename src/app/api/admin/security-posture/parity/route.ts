/**
 * GET /api/admin/security-posture/parity
 *
 * Checks every claim in docs/security-posture.md (the public /security-posture
 * page) against measured evidence. A claim the page marks "In place" whose
 * evidence reads gap is a violation. Read-only; capability-gated because the
 * per-claim evidence is internal.
 *
 *   GET -> 200 { measuredAt, violations, unknown, proven, results[], docDrift[] }
 *   401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { requireCapability } from "@/lib/auth/require-capability";
import { checkPostureParity, parseDocClaims, POSTURE_CLAIMS } from "@/lib/compliance/posture-claims";
import { collectPostureFacts } from "@/lib/compliance/posture-evidence";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rows where the document and the claim registry disagree (missing, extra, or a
 *  different status). Empty when the page and the registry say the same thing. */
function docDrift(md: string | null): string[] {
  if (md === null) return ["docs/security-posture.md could not be read"];
  const rows = parseDocClaims(md);
  const drift: string[] = [];
  for (const c of POSTURE_CLAIMS) {
    const row = rows.find((r) => r.key === c.key);
    if (!row) drift.push(`${c.key}: missing from the Control status table`);
    else if (row.status !== c.docStatus) drift.push(`${c.key}: page says "${row.statusText}", registry says ${c.docStatus}`);
  }
  for (const r of rows) if (!POSTURE_CLAIMS.some((c) => c.key === r.key)) drift.push(`${r.key}: on the page but has no evidence check`);
  return drift;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let md: string | null = null;
  try {
    md = readFileSync(join(process.cwd(), "docs", "security-posture.md"), "utf8");
  } catch {
    md = null;
  }

  const facts = await collectPostureFacts(auth.user.workspaceId ?? "default");
  const report = checkPostureParity(facts);
  const drift = docDrift(md);

  trackEvent("assurance.posture_parity_checked", auth.user.id, auth.user.role, {
    claims: report.results.length,
    proven: report.proven,
    in_progress: report.results.filter((r) => r.docStatus === "in_progress").length,
    violations: report.violations,
    unknown: report.unknown,
    drift: drift.length,
  });

  return NextResponse.json({ measuredAt: new Date().toISOString(), ...report, docDrift: drift });
}
