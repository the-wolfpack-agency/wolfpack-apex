/**
 * Daily AI-spend tripwire across every Azure subscription the az CLI can see.
 *
 *   npm run security:ai-spend
 *   npm run security:ai-spend -- --out /tmp/sec --fail-on high
 *
 * Asks Azure Cost Management for daily cost per resource over the last nine
 * days, keeps the AI services (Cognitive Services, Azure OpenAI, AI Foundry
 * "Foundry Models", Machine Learning, Copilot Studio) and lists, as info only,
 * a resource whose latest day is more than 3x its trailing 7-day mean and over
 * $5, or an AI resource that has just appeared (usage, including our regular
 * testing, never fails the check); and fails on any model deployment whose
 * name says one model while it serves another. Rules: scripts/security/lib/ai-spend.ts.
 *
 * READ-ONLY: the Cost Management "query" endpoint is a POST that only reads.
 * Needs Cost Management Reader on each subscription, and Reader on the AI
 * resources for the deployment check. Locally that
 * is `az login`; in Actions, azure/login with GitHub OIDC (AZURE_CLIENT_ID,
 * AZURE_TENANT_ID, optional AZURE_SUBSCRIPTION_ID secrets). Without a token
 * the check reports SKIPPED and exits 0.
 */
import { az, apiGet, apiQuery, getToken } from "./lib/azure";
import { aiSpendFindings, deploymentFindings, parseCostQuery, shiftDay, summarizeAiSpend, type CostRow, type ModelDeployment } from "./lib/ai-spend";
import { emitReport, newReport, parseCliOptions } from "./lib/report";

const ARM = "https://management.azure.com";
const opts = parseCliOptions(process.argv.slice(2), "scripts/security/out");

interface QueryResult {
  properties: { columns: { name: string }[]; rows: unknown[][]; nextLink?: string | null };
}

async function subscriptions(): Promise<{ id: string; name: string }[]> {
  const fromEnv = process.env.AZURE_SUBSCRIPTION_IDS ?? process.env.AZURE_SUBSCRIPTION_ID;
  if (fromEnv) return fromEnv.split(",").map((id) => ({ id: id.trim(), name: id.trim() })).filter((s) => s.id);
  const r = await az(["account", "list", "--query", "[?state=='Enabled'].{id:id,name:name}", "-o", "json"]);
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout) as { id: string; name: string }[];
  } catch {
    return [];
  }
}

interface ArmList<T> { value: T[]; nextLink?: string | null }
interface Account { id: string; kind?: string }
interface Deployment { name: string; sku?: { name?: string }; properties?: { model?: { name?: string; version?: string } } }

/** Every Cognitive Services account's model deployments in one subscription (needs Reader on them). */
async function modelDeployments(sub: { id: string; name: string }, token: string, notes: string[]): Promise<ModelDeployment[]> {
  // the generic resource list: the provider's own account list can answer an empty list for a
  // subscription that holds accounts
  const list: Account[] = [];
  let url: string | null = `${ARM}/subscriptions/${sub.id}/resources?api-version=2021-04-01&$filter=${encodeURIComponent("resourceType eq 'Microsoft.CognitiveServices/accounts'")}`;
  while (url) {
    const page: Awaited<ReturnType<typeof apiGet<ArmList<Account>>>> = await apiGet<ArmList<Account>>(url, token);
    if (!page.ok) {
      notes.push(`${sub.name}: model deployments NOT checked (listing AI accounts: ${page.status}: ${page.message.slice(0, 150)}). Grant the identity Reader on the AI resources.`);
      return [];
    }
    list.push(...page.data.value);
    url = page.data.nextLink ?? null;
  }
  if (!list.length) notes.push(`${sub.name}: no AI accounts visible, so no model deployment was checked. If the subscription has any, grant the identity Reader on them.`);
  const out: ModelDeployment[] = [];
  for (const a of list) {
    const deps = await apiGet<ArmList<Deployment>>(`${ARM}${a.id}/deployments?api-version=2024-10-01`, token);
    if (!deps.ok) {
      notes.push(`${sub.name}: deployments of ${a.id.split("/").pop()} NOT checked (${deps.status}).`);
      continue;
    }
    for (const d of deps.data.value) out.push({ accountId: a.id, name: d.name, model: d.properties?.model?.name ?? "", version: d.properties?.model?.version ?? "", sku: d.sku?.name ?? "" });
  }
  return out;
}

async function main(): Promise<number> {
  const report = newReport("ai-spend");
  const { token, reason } = await getToken(ARM, "ARM_TOKEN");
  if (!token) {
    report.skipped = `No Azure Resource Manager token (${reason}). Locally run \`az login\`; in Actions add the AZURE_CLIENT_ID and AZURE_TENANT_ID secrets for the read-only OIDC identity with Cost Management Reader (docs/security/scheduled-checks.md).`;
    return emitReport(report, opts);
  }
  const subs = await subscriptions();
  if (!subs.length) {
    report.skipped = "The signed-in identity can see no enabled Azure subscription. Grant it Cost Management Reader on the subscription, or set AZURE_SUBSCRIPTION_ID.";
    return emitReport(report, opts);
  }

  const today = new Date().toISOString().slice(0, 10);
  const from = shiftDay(today, -9);
  const to = shiftDay(today, -1);
  const body = {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [
        { type: "Dimension", name: "ResourceId" },
        { type: "Dimension", name: "ServiceName" },
        { type: "Dimension", name: "ResourceType" },
      ],
    },
  };

  let aiResources = 0;
  let totalAiLastDay = 0;
  for (const sub of subs) {
    const rows: CostRow[] = [];
    let url: string | null = `${ARM}/subscriptions/${sub.id}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
    let failed = false;
    while (url) {
      const r: Awaited<ReturnType<typeof apiQuery<QueryResult>>> = await apiQuery<QueryResult>(url, token, body);
      if (!r.ok) {
        report.notes.push(`${sub.name}: Cost Management query failed (${r.status}: ${r.message.slice(0, 150)}). This subscription was NOT checked.`);
        failed = true;
        break;
      }
      rows.push(...parseCostQuery(r.data.properties.columns, r.data.properties.rows));
      url = r.data.properties.nextLink ?? null;
    }
    if (failed) continue;
    // Cost data lags by up to a day: compare the latest day that has any data.
    const lastDay = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
    if (!lastDay) {
      report.notes.push(`${sub.name}: no cost rows between ${from} and ${to}.`);
      continue;
    }
    if (lastDay !== to) report.notes.push(`${sub.name}: newest cost data is ${lastDay} (${to} not yet published); compared ${lastDay}.`);
    const spend = summarizeAiSpend(rows, lastDay);
    aiResources += spend.length;
    for (const s of spend) {
      totalAiLastDay += s.last;
      report.stats[`${sub.name} / ${s.name}`] = `${s.serviceName}: $${s.last.toFixed(2)} on ${lastDay}, trailing 7-day mean $${s.trailingMean.toFixed(2)}`;
    }
    report.findings.push(...aiSpendFindings(spend, lastDay, sub.name));
  }

  // Each model deployment's name against the model it serves (rules: deploymentFindings).
  let deploymentsChecked = 0;
  for (const sub of subs) {
    const deployments = await modelDeployments(sub, token, report.notes);
    deploymentsChecked += deployments.length;
    report.findings.push(...deploymentFindings(deployments));
  }
  report.stats = {
    token_source: reason,
    subscriptions: subs.map((s) => s.name).join(", "),
    window: `${from} to ${to}`,
    ai_resources_with_cost: aiResources,
    ai_cost_latest_day_usd: totalAiLastDay.toFixed(2),
    model_deployments_checked: deploymentsChecked,
    ...report.stats,
  };
  report.notes.push(
    "Spend rises with usage (testing, releases, demos), so a rise (latest day > 3x the trailing 7-day mean and > $5) or a new AI resource is listed as info and never fails the check. Only a deployment serving a different model than its name fails it.",
    "Cost Management data lags usage by several hours to a day, so a rise shows on the next morning's run, not in real time. A per-resource budget alert in Azure is the faster backstop.",
  );
  return emitReport(report, opts);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`security:ai-spend failed: ${(e as Error).stack ?? e}\n`);
    process.exit(2);
  },
);
