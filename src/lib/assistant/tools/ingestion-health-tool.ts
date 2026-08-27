/**
 * pipeline_health: is the document library actually working?
 *
 * THE FIRST REAL AGENT JOB. Every check behind this is something that went
 * wrong this month and was found by hand, late: ten PDFs stuck mid-ingest from
 * May to August, ninety Word documents broken for three months after their
 * parser was fixed, a sync reporting hundreds of successes while its remaining
 * count rose, and 744 of 795 answerable documents turning out to be demo
 * fixtures the assistant was quoting.
 *
 * None of those is a bug in a function, so no test could have caught them.
 * They are facts about accumulated state that somebody has to go and ask for.
 * That is the definition of work to hand to an agent.
 *
 * READ-ONLY, which is what makes it a good first job. It reports and decides
 * nothing, so it can run on a schedule and be delegated freely, while the
 * approval gate holds anything that would change something.
 *
 * Reachable by a person too. An operator asking "is the brain healthy" gets
 * the same answer the agent gets, from the same reader, which is the only way
 * the two stay honest about each other.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { readIngestionHealth, summarizeHealth } from "@/lib/brain/ingestion-health";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface HealthData {
  kind: "pipeline_health";
  readable: boolean;
  findingCount: number;
  seriousCount: number;
}

/**
 * The words people use for "is the library working".
 *
 * Nobody says "ingestion health". They ask whether documents are getting in,
 * whether anything is stuck, or whether the brain is up to date. Anchored on
 * the pipeline nouns so it cannot claim a question about a document's
 * CONTENTS, which belongs to search.
 */
const INTENT_RE = new RegExp(
  [
    `\\b(?:is|are)\\s+(?:the\\s+)?(?:brain|library|document\\s+library|ingestion|pipeline|sync)\\s+(?:healthy|ok|working|up\\s+to\\s+date|broken)\\b`,
    `\\b(?:brain|ingestion|pipeline|document)\\s+health\\b`,
    `\\bhealth\\s+of\\s+(?:the\\s+)?(?:brain|library|pipeline|ingestion)\\b`,
    `\\bis\\s+anything\\s+stuck\\b`,
    `\\bwhat(?:'?s| is)\\s+(?:stuck|failing)\\s+(?:in\\s+)?(?:the\\s+)?(?:brain|library|ingestion|pipeline)\\b`,
    `\\bare\\s+(?:my|our)\\s+documents\\s+(?:indexed|searchable|answerable)\\b`,
    `\\bhow\\s+many\\s+documents\\s+(?:failed|are\\s+stuck)\\b`,
  ].join("|"),
  "i",
);

export function matchPipelineHealthIntent(message: string): Params | null {
  return INTENT_RE.test(message.trim()) ? {} : null;
}

export const ingestionHealthTool: ToolDef<Params, HealthData> = {
  name: "pipeline_health",
  description:
    "Report what the document pipeline is quietly failing to do: documents stuck mid-ingest, extractions that failed, passages not embedded, and how much of the library is real content rather than demo or system-generated. Read-only, zero AI tokens.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchPipelineHealthIntent,
  async handler(_params, ctx): Promise<ToolResult<HealthData>> {
    const health = await readIngestionHealth();
    const serious = health.findings.filter((f) => f.severity === "high").length;

    trackEvent("assistant.tool_invoked", ctx.userId, ctx.userRole, {
      tool: "pipeline_health",
      readable: health.readable,
      finding_count: health.findings.length,
      serious_count: serious,
      /* Which findings, so a rising one is nameable in the data rather than
         only visible to whoever happened to read the answer. */
      findings: health.findings.map((f) => f.id).join(",") || "none",
    });

    const lines = health.findings.map((f) => {
      const mark = f.severity === "high" ? "!" : f.severity === "medium" ? "*" : "-";
      return `${mark} ${f.title}\n  ${f.detail}${f.action ? `\n  Next: ${f.action}` : ""}`;
    });

    const answer = health.readable
      ? [summarizeHealth(health), "", ...lines].join("\n").trim()
      : summarizeHealth(health);

    return {
      ok: true,
      data: {
        kind: "pipeline_health",
        readable: health.readable,
        findingCount: health.findings.length,
        seriousCount: serious,
      },
      answer,
    };
  },
};

registerTool(ingestionHealthTool);
