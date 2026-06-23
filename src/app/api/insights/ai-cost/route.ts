/**
 * GET /api/insights/ai-cost
 *
 * Per-workspace AI spend chargeback, read from v_ai_cost_daily (which
 * aggregates the append-only `ai.completion` event stream, no separate
 * write path). Turns Instinct's "AI cost-efficiency" positioning into a
 * measurable, CFO-facing number.
 *
 * Scope:
 *   - ceo / cto see every workspace (org-wide chargeback + by_workspace).
 *   - everyone else sees only their own workspace.
 *
 * Query: ?days=30 (1..365, default 30).
 *
 * The ranking/serialization is all here; the SQL aggregation lives in the
 * view. Degrades to an empty (zeroed) report in shadow mode / DB-down so
 * the dashboard renders an explicit empty state, never an error page.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";

export interface AiCostBucket {
  key: string;
  calls: number;
  cost_usd: number;
}
export interface AiCostReport {
  shadow_mode: boolean;
  window_days: number;
  scope: "workspace" | "org";
  workspace_id: string;
  total: {
    calls: number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    semantic_hits: number;
    fallbacks: number;
  };
  by_feature: AiCostBucket[];
  by_provider: AiCostBucket[];
  by_workspace: AiCostBucket[];
  by_day: { day: string; cost_usd: number; calls: number }[];
}

interface Row {
  day: string;
  workspace_id: string;
  feature: string;
  provider: string;
  model: string;
  user_id: string;
  calls: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  fallbacks: number;
  semantic_hits: number;
}

const ORG_ROLES = new Set(["ceo", "cto"]);

function clampDays(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, n));
}

function emptyReport(
  days: number,
  scope: "workspace" | "org",
  workspaceId: string,
): AiCostReport {
  return {
    shadow_mode: true,
    window_days: days,
    scope,
    workspace_id: workspaceId,
    total: {
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      semantic_hits: 0,
      fallbacks: 0,
    },
    by_feature: [],
    by_provider: [],
    by_workspace: [],
    by_day: [],
  };
}

function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Sum `cost_usd` + `calls` into a keyed bucket map, returned sorted by
 *  spend descending. Exported-shape logic kept pure for the unit test. */
export function bucketBy(rows: Row[], key: keyof Row): AiCostBucket[] {
  const map = new Map<string, AiCostBucket>();
  for (const r of rows) {
    const k = String(r[key] ?? "unknown");
    const b = map.get(k) ?? { key: k, calls: 0, cost_usd: 0 };
    b.calls += Number(r.calls) || 0;
    b.cost_usd += Number(r.cost_usd) || 0;
    map.set(k, b);
  }
  return Array.from(map.values())
    .map((b) => ({ ...b, cost_usd: roundUsd(b.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
}

export function summarize(
  rows: Row[],
  days: number,
  scope: "workspace" | "org",
  workspaceId: string,
): AiCostReport {
  const total = rows.reduce(
    (acc, r) => {
      acc.calls += Number(r.calls) || 0;
      acc.cost_usd += Number(r.cost_usd) || 0;
      acc.input_tokens += Number(r.input_tokens) || 0;
      acc.output_tokens += Number(r.output_tokens) || 0;
      acc.semantic_hits += Number(r.semantic_hits) || 0;
      acc.fallbacks += Number(r.fallbacks) || 0;
      return acc;
    },
    {
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      semantic_hits: 0,
      fallbacks: 0,
    },
  );
  total.cost_usd = roundUsd(total.cost_usd);

  const byDayMap = new Map<string, { day: string; cost_usd: number; calls: number }>();
  for (const r of rows) {
    const d = byDayMap.get(r.day) ?? { day: r.day, cost_usd: 0, calls: 0 };
    d.cost_usd += Number(r.cost_usd) || 0;
    d.calls += Number(r.calls) || 0;
    byDayMap.set(r.day, d);
  }
  const by_day = Array.from(byDayMap.values())
    .map((d) => ({ ...d, cost_usd: roundUsd(d.cost_usd) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    shadow_mode: false,
    window_days: days,
    scope,
    workspace_id: workspaceId,
    total,
    by_feature: bucketBy(rows, "feature"),
    by_provider: bucketBy(rows, "provider"),
    by_workspace: scope === "org" ? bucketBy(rows, "workspace_id") : [],
    by_day,
  };
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = clampDays(req.nextUrl.searchParams.get("days"));
  const isOrg = ORG_ROLES.has(user.role);
  const scope: "workspace" | "org" = isOrg ? "org" : "workspace";
  const workspaceId = user.workspaceId ?? "default";

  // Org roles see all workspaces; everyone else is scoped to their own.
  // The interval is interpolated as an integer literal (clamped above),
  // never user text; workspace_id is a bound parameter.
  const where = isOrg ? "" : "AND workspace_id = $1";
  const params: unknown[] = isOrg ? [] : [workspaceId];
  const result = await safeQuery<Row>(
    `SELECT day::text AS day, workspace_id, feature, provider, model, user_id,
            calls, cost_usd, input_tokens, output_tokens, fallbacks, semantic_hits
       FROM v_ai_cost_daily
      WHERE day >= (CURRENT_DATE - INTERVAL '${days} days') ${where}`,
    params,
  );

  if (result.fromCache) {
    return NextResponse.json(emptyReport(days, scope, workspaceId));
  }
  return NextResponse.json(summarize(result.rows, days, scope, workspaceId));
}
