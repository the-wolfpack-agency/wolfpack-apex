/**
 * Run the red-team corpus, persist the result, and emit the learning signals.
 * Shared by the on-demand route and the continuous cron so the run + record +
 * analytics path is identical (DRY). Returns the report + the persisted run id.
 */
import { trackEvent } from "@/lib/analytics";
import { runRedTeam } from "./run";
import { recordRun } from "./store";
import type { RedTeamReport } from "./types";

const MAX_VULN_EVENTS = 100;

export async function executeRedTeam(args: {
  workspaceId: string;
  actorId: string;
  actorRole: string;
  source: "cron" | "manual";
  nowIso: string;
}): Promise<{ report: RedTeamReport; id: string }> {
  const report = runRedTeam();
  const id = await recordRun(args.workspaceId, report, args.source, args.nowIso);

  trackEvent("ai_redteam.run_completed", args.actorId, args.actorRole, {
    attacks: report.attacksRun,
    blocked: report.blocked,
    vulns: report.vulns.length,
    pass_rate: report.passRate,
    source: args.source,
  });
  for (const v of report.vulns.slice(0, MAX_VULN_EVENTS)) {
    trackEvent("ai_redteam.vuln_detected", args.actorId, args.actorRole, {
      category: v.category,
      technique: v.technique,
      attack_id: v.attackId,
    });
  }

  return { report, id };
}
