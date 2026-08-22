/**
 * platform_scan_findings — what the scanner found, from the chat.
 *
 * WHY READ AND NOT RUN
 *
 * The scan engine is built and, until now, unreachable from the assistant. The
 * obvious move is a tool that runs a scan on request. That is the wrong first
 * slice, for two reasons that do not soften with care:
 *
 *   1. A scan sends real traffic at a real system. A tool that fires one
 *      because a sentence matched a regex is a tool that will one day probe
 *      somebody's production estate because a person typed a question near the
 *      wrong words.
 *   2. Scanning is already gated on verified target ownership, and that gate
 *      exists precisely so scanning is a deliberate act. Reaching around it
 *      from a chat box would be reaching around the control, not extending it.
 *
 * Reading costs nothing, sends nothing, and is what somebody actually asks
 * between scans: "what is outstanding?". Running one from here is a separate
 * decision, and it belongs behind the confirmation flow with the ownership
 * check intact, not inside this file.
 *
 * WHAT IT REFUSES TO IMPLY
 *
 * Zero open findings is reported as "nothing open", never as "you are clean".
 * A scan that has not run, a target that was never onboarded, and a platform
 * with genuinely nothing outstanding all produce the same empty number, and
 * only one of them is good news. Coverage is stated alongside, because the
 * honest reading of a clean result depends entirely on how much was actually
 * looked at.
 */
import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { listStoredTargets } from "@/lib/platform-scan/targets-store";
import { summarizeFindings, listScans } from "@/lib/platform-scan/store";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({
  /** Narrow to one onboarded platform. Absent means every one. */
  platform: z.string().min(1).max(120).optional(),
});
type Params = z.infer<typeof ParamSchema>;

interface ScanFindingsData {
  platform: string | null;
  total: number;
  bySeverity: Record<string, number>;
  /** Onboarded targets, so "nothing found" can be told apart from
   *  "nothing was ever scanned". */
  targetCount: number;
  lastScanAt: string | null;
  /** Null when the last run predates coverage accounting or was an external
   *  ingest that probed no routes. Null is NOT zero and is NOT complete. */
  coveragePct: number | null;
  degraded: boolean | null;
}

/* Tight, so this does not answer a question about a supermarket scan or a
   document scan. The vocabulary is the product's own. */
const INTENT_RE =
  /\b(?:(?:scan|security|vulnerabilit\w+|pentest)\s+(?:findings|results|issues|report)|what\s+did\s+the\s+scan\s+find|open\s+(?:scan|security)\s+findings|any\s+(?:security|scan)\s+(?:issues|findings)|platform\s+scan)\b/i;

const PLATFORM_RE = /\b(?:for|on|in)\s+([a-z0-9][a-z0-9._-]{1,60})\b/i;

export function matchScanFindingsIntent(message: string): Params | null {
  if (message.length > 300) return null;
  if (!INTENT_RE.test(message)) return null;
  const m = PLATFORM_RE.exec(message);
  /* Only treat the captured word as a platform when it is not one of our own
     nouns; "findings for scan results" should not target a platform called
     "scan". */
  const candidate = m?.[1]?.toLowerCase();
  const ours = new Set(["scan", "security", "the", "my", "our", "findings", "results", "platform"]);
  return candidate && !ours.has(candidate) ? { platform: candidate } : {};
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;

export const platformScanFindingsTool: ToolDef<Params, ScanFindingsData> = {
  name: "platform_scan_findings",
  description:
    "Report open findings from the platform scanner for this workspace, with how much of the target was actually covered.",
  /* Reading a workspace's own security posture is a lead-and-above question.
     The gate is the dispatcher's, same as every other tool. */
  capability: "lead",
  paramSchema: ParamSchema,
  matchIntent: matchScanFindingsIntent,
  async handler(params, ctx): Promise<ToolResult<ScanFindingsData>> {
    const workspaceId = ctx.workspaceId || "default";

    let targets: Awaited<ReturnType<typeof listStoredTargets>> = [];
    let summary = { total: 0, bySeverity: {} as Record<string, number>, byCategory: {} };
    let scans: Awaited<ReturnType<typeof listScans>> = [];
    try {
      [targets, summary, scans] = await Promise.all([
        listStoredTargets(workspaceId),
        summarizeFindings(workspaceId, params.platform),
        listScans(workspaceId, 1),
      ]);
    } catch {
      /* An unreadable scan store must not answer with an encouraging zero. */
      return {
        ok: false,
        code: "internal",
        message:
          "The scan results could not be read just now, so I cannot tell you what is outstanding. That is not the same as nothing being outstanding.",
      };
    }

    const last = scans[0] ?? null;
    /* coverageRatio is 0..1; the answer speaks in percent because that is how
       somebody reads a coverage number out loud. */
    const coveragePct =
      last?.coverage && typeof last.coverage.coverageRatio === "number"
        ? last.coverage.coverageRatio * 100
        : null;

    const data: ScanFindingsData = {
      platform: params.platform ?? null,
      total: summary.total,
      bySeverity: summary.bySeverity,
      targetCount: targets.length,
      lastScanAt: last?.createdAt ?? null,
      coveragePct,
      degraded: last?.degraded ?? null,
    };

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "platform_scan_findings",
      workspace_id: workspaceId,
      open_findings: summary.total,
      targets: targets.length,
      ...(params.platform ? { platform: params.platform } : {}),
      ...(ctx.workflowId ? { workflow_id: ctx.workflowId } : {}),
    });

    return { ok: true, data, answer: render(data) };
  },
};

function render(d: ScanFindingsData): string {
  const scope = d.platform ? ` for ${d.platform}` : "";

  /* NOTHING ONBOARDED is a different answer from NOTHING FOUND, and conflating
     them is how somebody walks away believing an unscanned estate is clean. */
  if (d.targetCount === 0) {
    return `No platform has been onboarded for scanning in this workspace, so there is nothing to report${scope}. Onboarding a target and verifying ownership is the first step.`;
  }

  if (d.lastScanAt === null) {
    return `${d.targetCount} ${d.targetCount === 1 ? "target is" : "targets are"} onboarded${scope}, but no scan has run yet. Nothing is outstanding because nothing has been looked at.`;
  }

  const lines: string[] = [];

  if (d.total === 0) {
    lines.push(`Nothing open${scope} as of the last scan on ${d.lastScanAt.slice(0, 10)}.`);
  } else {
    const parts = SEVERITY_ORDER.filter((s) => (d.bySeverity[s] ?? 0) > 0).map(
      (s) => `${d.bySeverity[s]} ${s}`,
    );
    lines.push(
      `${d.total} open ${d.total === 1 ? "finding" : "findings"}${scope}: ${parts.join(", ")}. Last scan ${d.lastScanAt.slice(0, 10)}.`,
    );
  }

  /* COVERAGE ALWAYS, and loudest when the news is good. A clean result over a
     tenth of the estate is not a clean result, and the moment somebody repeats
     "no open findings" in a meeting without that sentence attached, the tool
     has misled them. */
  if (d.coveragePct === null) {
    lines.push(
      "How much of the target that run actually covered is unknown, so read the number above as a floor rather than a total.",
    );
  } else {
    lines.push(`That run covered ${Math.round(d.coveragePct)}% of the routes it knows about.`);
    if (d.degraded) {
      lines.push(
        "Coverage was below the trust threshold, so treat this as a partial picture rather than a clean bill.",
      );
    }
  }

  return lines.join(" ");
}

registerTool(platformScanFindingsTool);
