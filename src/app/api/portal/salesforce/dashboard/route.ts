/**
 * GET /api/portal/salesforce/dashboard
 *
 * Aggregates the /portal/salesforce home page:
 *   - Pipeline snapshot: open-opportunity count, $ in pipeline, by-stage
 *     breakdown.
 *   - Recent activity: 10 most-recently-modified records across
 *     contact / opportunity / account.
 *
 * Auth: `settings.manage_team` (matches the admin connector pages —
 * portal access is owner-grade for the MVP; we'll relax to a dedicated
 * `portal.salesforce.view` capability once the surface stabilizes).
 *
 * Connector-down behavior: returns ok=true, notConfigured=true so the
 * page renders the "Connect Salesforce" CTA without flashing an error.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  resolveSalesforceConnector,
  connectorErrorToHttp,
} from "../_helpers";

interface PipelineSnapshot {
  openCount: number;
  totalAmount: number;
  byStage: Array<{ stage: string; count: number; amount: number }>;
}

interface Recentercord {
  id: string;
  name: string;
  type: "contacts" | "opportunities" | "accounts";
  lastModified: string | null;
}

interface DashboardResponse {
  notConfigured: boolean;
  pipeline: PipelineSnapshot;
  recent: Recentercord[];
  connector: string;
}

const CLOSED_STAGES = new Set(["Closed Won", "Closed Lost"]);

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId;
  const resolved = await resolveSalesforceConnector(workspaceId);
  if (resolved.notConfigured) {
    const body: DashboardResponse = {
      notConfigured: true,
      pipeline: { openCount: 0, totalAmount: 0, byStage: [] },
      recent: [],
      connector: resolved.connectorName,
    };
    trackEvent("portal.salesforce_dashboard_viewed", auth.user.id, auth.user.role, {
      connector: resolved.connectorName,
      configured: false,
    });
    return NextResponse.json(body);
  }

  /* Fan out three searches in parallel — contacts/opps/accounts. The
     vendor preset's search builder takes a "match anything" query when
     we pass a 2-char wildcard the SOQL LIKE accepts. To keep that
     deterministic we pass a single character that matches any name
     containing it; 'a' covers the vast majority of CRM data. The pages
     paginate at 50/page when the user clicks into the list. */
  const oppsResult = await resolved.connector.searchRecords("opportunity", "a", 200);
  const contactsResult = await resolved.connector.searchRecords("contact", "a", 50);
  const accountsResult = await resolved.connector.searchRecords("account", "a", 50);

  /* If opportunities errors with auth_failed we surface a typed 502 so
     the UI can prompt reconnect. Any one of contacts/accounts erroring
     doesn't block the dashboard — we just leave that list empty. */
  if (!oppsResult.ok) {
    const mapped = connectorErrorToHttp(oppsResult.code);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  const opportunities = oppsResult.data ?? [];
  const contacts = contactsResult.ok ? contactsResult.data ?? [] : [];
  const accounts = accountsResult.ok ? accountsResult.data ?? [] : [];

  /* Pipeline aggregation — keep on the server so we don't ship 200
     records to the client when the UI only needs three numbers. */
  let openCount = 0;
  let totalAmount = 0;
  const byStage = new Map<string, { count: number; amount: number }>();
  for (const o of opportunities) {
    const stage =
      typeof o.StageName === "string" && o.StageName.length > 0
        ? o.StageName
        : "(no stage)";
    const amount = typeof o.Amount === "number" ? o.Amount : 0;
    const isClosed = CLOSED_STAGES.has(stage);
    if (!isClosed) {
      openCount++;
      totalAmount += amount;
    }
    const entry = byStage.get(stage) ?? { count: 0, amount: 0 };
    entry.count++;
    entry.amount += amount;
    byStage.set(stage, entry);
  }

  /* Recent activity — sort the union by LastModifiedDate desc, take 10. */
  const combined: Recentercord[] = [];
  for (const c of contacts) {
    if (typeof c.Id !== "string") continue;
    combined.push({
      id: c.Id,
      name: typeof c.Name === "string" ? c.Name : "(unnamed contact)",
      type: "contacts",
      lastModified: typeof c.LastModifiedDate === "string" ? c.LastModifiedDate : null,
    });
  }
  for (const o of opportunities) {
    if (typeof o.Id !== "string") continue;
    combined.push({
      id: o.Id,
      name: typeof o.Name === "string" ? o.Name : "(unnamed opportunity)",
      type: "opportunities",
      lastModified: typeof o.LastModifiedDate === "string" ? o.LastModifiedDate : null,
    });
  }
  for (const a of accounts) {
    if (typeof a.Id !== "string") continue;
    combined.push({
      id: a.Id,
      name: typeof a.Name === "string" ? a.Name : "(unnamed account)",
      type: "accounts",
      lastModified: typeof a.LastModifiedDate === "string" ? a.LastModifiedDate : null,
    });
  }
  combined.sort((a, b) => {
    const at = a.lastModified ? Date.parse(a.lastModified) : 0;
    const bt = b.lastModified ? Date.parse(b.lastModified) : 0;
    return bt - at;
  });
  const recent = combined.slice(0, 10);

  trackEvent("portal.salesforce_dashboard_viewed", auth.user.id, auth.user.role, {
    connector: resolved.connectorName,
    configured: true,
    open_count: openCount,
    pipeline_amount: totalAmount,
    recent_count: recent.length,
  });

  const body: DashboardResponse = {
    notConfigured: false,
    connector: resolved.connectorName,
    pipeline: {
      openCount,
      totalAmount,
      byStage: Array.from(byStage.entries())
        .map(([stage, v]) => ({ stage, count: v.count, amount: v.amount }))
        .sort((a, b) => b.amount - a.amount),
    },
    recent,
  };
  return NextResponse.json(body);
}
