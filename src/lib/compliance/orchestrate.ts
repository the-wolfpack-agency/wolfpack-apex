/**
 * Compliance orchestrator: collect live evidence, generate the framework report,
 * persist it. The single seam the route and any future cron share.
 */
import { collectEvidence } from "./evidence";
import { generateReport } from "./report";
import { recordReport } from "./store";
import type { ComplianceFramework, ComplianceReport } from "./types";

export async function runComplianceReport(
  workspaceId: string,
  framework: ComplianceFramework,
  nowIso: string,
): Promise<{ report: ComplianceReport; id: string }> {
  const evidence = await collectEvidence(workspaceId, new Date(nowIso).getTime());
  const report = generateReport(framework, evidence);
  const id = await recordReport(workspaceId, report, nowIso);
  return { report, id };
}
