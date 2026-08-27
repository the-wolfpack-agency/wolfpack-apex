/**
 * compare_across_sources: "compare contacts across systems"
 *
 * The other half of the cross-source overlap insight. That one says the
 * same entity lives in two places; this one goes and asks both.
 *
 * Every value it reports is the client's own data read back to them
 * through connectors they configured, so nothing new is exposed. What
 * IS new is the comparison, which neither vendor can perform because
 * neither can see the other.
 *
 * Zero AI tokens. The matching and diffing are arithmetic, and a
 * disagreement a client can check line by line is worth more than a
 * paragraph a model composed about their data quality.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import { resolveScopedConnector } from "./resolve-connector";
import type { ToolDef, ToolResult, ToolContext } from "./types";
import type { Connector } from "@/lib/assistant/connectors/types";
import { compareRecordSets, renderDrift, type DriftReport } from "@/lib/insights/cross-source-drift";

const ParamSchema = z.object({
  objectType: z.string().min(2).max(40),
  /** Per system. Bounded: this is two live queries against a client's CRM. */
  limit: z.number().int().min(10).max(200).default(100),
});
type Params = z.infer<typeof ParamSchema>;

const OBJECT_ALIAS: Record<string, string> = {
  contacts: "contact",
  contact: "contact",
  customers: "contact",
  customer: "contact",
  people: "contact",
  deals: "deal",
  deal: "deal",
  opportunities: "deal",
  companies: "company",
  company: "company",
  accounts: "company",
  account: "company",
  tickets: "ticket",
  ticket: "ticket",
  invoices: "invoice",
  invoice: "invoice",
  vehicles: "vehicle",
  vehicle: "vehicle",
};

/* "compare contacts across systems" / "compare deals across both" /
   "where do our systems disagree about contacts", and the chip text
   emitted by the cross_source_overlap insight, which is the main way
   anyone arrives here. */
const INTENT_RE =
  /* Alternation is ORDERED, so the longest form comes first: with `the` ahead
     of `the two`, "where do the two systems disagree" matched `the`, then
     required " systems" and met " two systems", and fell through to no tool at
     all. The plainest phrasing of the product's central claim was unreachable
     by one alternative being in the wrong place. The object tail is optional
     AS A WHOLE: a mandatory \s+ after "disagree" meant the sentence had to
     carry a trailing space, so the shortest form could never match either. */
  /\bcompare\s+(?:my\s+|our\s+)?([a-z]{3,20})\s+across\s+(?:all\s+)?(?:my\s+|our\s+)?(?:systems?|sources?|tools?|both|connectors?)\b|\bwhere\s+do\s+(?:the\s+two|my|our|the|both)\s+systems?\s+disagree(?:\s+(?:about\s+|on\s+)?([a-z]{3,20}))?\b|\b([a-z]{3,20})\s+drift\s+(?:across|between)\s+(?:my\s+|our\s+)?systems?\b/i;

function matchIntent(message: string): Params | null {
  const m = INTENT_RE.exec(message.trim());
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase();
  /* "where do the two systems disagree" names no object, and it is the
     plainest way anybody asks this. Contacts is the default because it is the
     object every connected system holds; the handler still reports which
     systems it actually compared, so a wrong default is visible rather than
     silent. Cross-source reconciliation is the whole middleware argument, and
     requiring the object noun made the argument unreachable by its own
     sentence. */
  const objectType = raw ? OBJECT_ALIAS[raw] : "contacts";
  if (!objectType) return null;
  return { objectType, limit: 100 };
}

interface CompareData {
  objectType: string;
  systems: string[];
  report?: DriftReport;
}

/**
 * The configured systems that actually hold this object type.
 *
 * Each candidate still goes through resolveScopedConnector, so the
 * workspace scoping and agent binding that gate every other connector
 * tool gate this one too. Reading the registry directly would be a way
 * around a check, and there is never a good reason for a new tool to
 * have one.
 */
async function systemsHolding(
  ctx: ToolContext,
  objectType: string,
): Promise<Array<{ name: string; connector: Connector }>> {
  const { listConnectors } = await import("@/lib/assistant/connectors/registry");
  const out: Array<{ name: string; connector: Connector }> = [];
  for (const candidate of listConnectors()) {
    let holds = false;
    try {
      holds =
        candidate.isConfigured() &&
        (candidate.objectTypes?.() ?? []).includes(objectType);
    } catch {
      holds = false;
    }
    if (!holds) continue;
    const resolved = await resolveScopedConnector(ctx, candidate.name);
    if ("ok" in resolved && resolved.ok === false) continue;
    const connector = (resolved as { connector: Connector }).connector;
    if (connector?.isConfigured()) out.push({ name: candidate.name, connector });
  }
  return out;
}

export const compareAcrossSourcesTool: ToolDef<Params, CompareData> = {
  name: "compare_across_sources",
  description:
    "Read the same object type from two connected systems and report where they disagree, which records exist in only one, and which could not be matched. Rule-based; no AI tokens.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent,
  async handler(params, ctx): Promise<ToolResult<CompareData>> {
    const systems = await systemsHolding(ctx, params.objectType);

    if (systems.length < 2) {
      /* Not an error. One system cannot disagree with anything, and
         saying so plainly is more useful than a failure code. */
      return {
        ok: true,
        data: { objectType: params.objectType, systems: systems.map((s) => s.name) },
        answer:
          systems.length === 1
            ? `Only ${systems[0].name} holds ${params.objectType} records right now, so there is nothing to compare it against. Connect a second system and this becomes a one-line check.`
            : `No connected system holds ${params.objectType} records yet.`,
      };
    }

    const [left, right] = systems;
    const [lRes, rRes] = await Promise.all([
      left.connector.searchRecords(params.objectType, "", params.limit),
      right.connector.searchRecords(params.objectType, "", params.limit),
    ]);

    const failed = !lRes.ok ? left.name : !rRes.ok ? right.name : null;
    if (failed) {
      /* Half a comparison is worse than none: it would report every
         record as "only in the system that answered". */
      return {
        ok: false,
        code: "internal",
        message: `${failed} did not return ${params.objectType} records, so the comparison would be misleading rather than incomplete.`,
      };
    }

    const report = compareRecordSets(
      params.objectType,
      { name: left.name, records: lRes.data ?? [] },
      { name: right.name, records: rRes.data ?? [] },
    );

    /* Counts only. The disagreeing VALUES are the client's customer
       data and belong in the answer they asked for, not in our
       analytics table. */
    trackEvent("assistant.cross_source_compared", ctx.userId, ctx.userRole, {
      object_type: params.objectType,
      left: left.name,
      right: right.name,
      matched: report.matched,
      drifting_fields: report.fields.length,
      only_left: report.onlyInLeft,
      only_right: report.onlyInRight,
      unmatchable: report.unmatchable,
    });

    return {
      ok: true,
      data: { objectType: params.objectType, systems: [left.name, right.name], report },
      answer: renderDrift(report),
    };
  },
};

registerTool(compareAcrossSourcesTool);
