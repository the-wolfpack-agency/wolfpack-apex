/**
 * Pure rules for the daily AI-spend tripwire.
 *
 * WHY. Azure AI spend has been about $0.36 a day since 2026-10-18. A stolen
 * model key does not announce itself; it shows up as a bill. Comparing each AI
 * resource's latest day against its own trailing week turns that bill into a
 * signal the next morning instead of at month end.
 *
 *   rise:   last day > 3x the trailing 7-day mean AND > $5    -> info
 *   new:    an AI resource with cost on the last day and none in the
 *           trailing 7 days                                    -> info
 *
 * Both are info, never a failing finding. Spend rises whenever usage does:
 * testing, releases and demos all raise it on purpose, and a red run for
 * that trains everyone to ignore the check. They are listed so the numbers
 * are visible; the failing rule is the deployment-model mismatch below, a
 * defect rather than usage.
 */
import type { Finding } from "./report";

export const SPIKE_MULTIPLIER = 3;
export const SPIKE_MIN_USD = 5;
export const TRAILING_DAYS = 7;

export interface CostRow {
  resourceId: string;
  serviceName: string;
  resourceType: string;
  /** YYYY-MM-DD */
  date: string;
  cost: number;
  currency: string;
}

/** Cognitive Services, Azure OpenAI, AI Foundry, Machine Learning, Copilot Studio. */
export function isAiCost(serviceName: string, resourceType: string): boolean {
  const t = resourceType.toLowerCase();
  if (t.startsWith("microsoft.cognitiveservices/") || t.startsWith("microsoft.machinelearningservices/")) return true;
  return /cognitive|openai|foundry|machine learning|\bai\b|copilot studio/i.test(serviceName);
}

/** Cost Management returns dates as 20261023 (number); normalize to 2026-10-23. */
export function normalizeUsageDate(v: unknown): string {
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

export function parseCostQuery(columns: { name: string }[], rows: unknown[][]): CostRow[] {
  const idx = (n: string) => columns.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
  const iCost = idx("Cost") > -1 ? idx("Cost") : idx("PreTaxCost");
  const iDate = idx("UsageDate");
  const iRes = idx("ResourceId");
  const iSvc = idx("ServiceName");
  const iType = idx("ResourceType");
  const iCur = idx("Currency");
  return rows.map((r) => ({
    cost: Number(r[iCost] ?? 0),
    date: normalizeUsageDate(r[iDate]),
    resourceId: String(r[iRes] ?? "").toLowerCase(),
    serviceName: String(r[iSvc] ?? ""),
    resourceType: String(r[iType] ?? ""),
    currency: iCur > -1 ? String(r[iCur]) : "USD",
  }));
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export interface ResourceSpend {
  resourceId: string;
  name: string;
  serviceName: string;
  last: number;
  trailingMean: number;
  trailingDaysWithCost: number;
}

export function resourceName(resourceId: string): string {
  return resourceId.split("/").filter(Boolean).pop() ?? resourceId;
}

/** Per-AI-resource spend on `lastDay` against the 7 days before it. */
export function summarizeAiSpend(rows: CostRow[], lastDay: string): ResourceSpend[] {
  const first = shiftDay(lastDay, -TRAILING_DAYS);
  const byRes = new Map<string, { svc: string; days: Map<string, number> }>();
  for (const r of rows) {
    if (!isAiCost(r.serviceName, r.resourceType)) continue;
    if (r.date < first || r.date > lastDay) continue;
    const e = byRes.get(r.resourceId) ?? { svc: r.serviceName, days: new Map<string, number>() };
    e.days.set(r.date, (e.days.get(r.date) ?? 0) + r.cost);
    byRes.set(r.resourceId, e);
  }
  const out: ResourceSpend[] = [];
  for (const [id, e] of byRes) {
    let sum = 0;
    let withCost = 0;
    for (let i = 1; i <= TRAILING_DAYS; i++) {
      const c = e.days.get(shiftDay(lastDay, -i)) ?? 0;
      sum += c;
      if (c > 0) withCost += 1;
    }
    out.push({
      resourceId: id,
      name: resourceName(id),
      serviceName: e.svc,
      last: e.days.get(lastDay) ?? 0,
      trailingMean: sum / TRAILING_DAYS,
      trailingDaysWithCost: withCost,
    });
  }
  return out.sort((a, b) => b.last - a.last);
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function aiSpendFindings(spend: ResourceSpend[], lastDay: string, subscription: string): Finding[] {
  const out: Finding[] = [];
  for (const s of spend) {
    const isNew = s.last > 0 && s.trailingDaysWithCost === 0;
    const spike = s.last > SPIKE_MIN_USD && s.last > SPIKE_MULTIPLIER * s.trailingMean;
    if (spike) {
      out.push({
        severity: "info",
        rule: isNew ? "ai-spend.new-resource-rise" : "ai-spend.rise",
        subject: `${s.name} (${s.serviceName})`,
        detail: `${usd(s.last)} on ${lastDay} against a trailing 7-day mean of ${usd(s.trailingMean)}${s.trailingMean > 0 ? ` (${(s.last / s.trailingMean).toFixed(1)}x)` : ""}. Usage rose; expected on days with testing, releases or demos.`,
        source: `https://portal.azure.com/#@/resource${s.resourceId}/costanalysis`,
      });
    } else if (isNew) {
      out.push({
        severity: "info",
        rule: "ai-spend.new-resource",
        subject: `${s.name} (${s.serviceName})`,
        detail: `AI resource with spend on ${lastDay} (${usd(s.last)}) and none in the 7 days before, in subscription ${subscription}.`,
        source: `https://portal.azure.com/#@/resource${s.resourceId}/overview`,
      });
    }
  }
  return out;
}

/**
 * A model deployment whose NAME says one model while it SERVES another.
 *
 * WHY. Code picks a model by deployment name. A deployment named for a cheap
 * model that serves a dearer one bills every call at the dearer price (gpt-4o
 * costs about 16x gpt-4o-mini), and no spend threshold notices a steady cost
 * that was always there. Nothing else compares the name with the model.
 *
 *   mismatch: the name reads as a model id and the served model is not that
 *             model (normalized: the model name equals the deployment name or
 *             extends it, so "Deepseek-v3" serving DeepSeek-V3.2 is fine and
 *             "gpt-4o-mini" serving gpt-4o is not)                   -> high
 */
export interface ModelDeployment {
  accountId: string;
  name: string;
  model: string;
  version: string;
  sku: string;
}

/** A deployment name that a caller would read as a model id. */
const MODEL_NAME_RE = /gpt|\bo[1-9]|deepseek|llama|mistral|phi|embedding|dall-?e|whisper|tts|grok|claude/i;
const normModel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function deploymentNameMismatch(d: Pick<ModelDeployment, "name" | "model">): boolean {
  if (!d.model || !MODEL_NAME_RE.test(d.name)) return false;
  const name = normModel(d.name);
  const model = normModel(d.model);
  return !(model === name || model.startsWith(name));
}

export function deploymentFindings(deployments: ModelDeployment[]): Finding[] {
  return deployments.filter(deploymentNameMismatch).map((d) => ({
    severity: "high" as const,
    rule: "ai-spend.deployment-model-mismatch",
    subject: `${resourceName(d.accountId)} / ${d.name}`,
    detail: `Deployment "${d.name}" serves ${d.model} ${d.version} (${d.sku}). Code that picks it by name expects a different model, and is billed for ${d.model}. Redeploy it with the model its name says, or rename it and point the callers at the new name.`,
    source: `https://portal.azure.com/#@/resource${d.accountId}/overview`,
  }));
}
