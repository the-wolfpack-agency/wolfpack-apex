/**
 * CRM provider — fans out Universal Search into the workspace's
 * configured CRM connector(s). Reuses the SAME code path that backs
 * the assistant's `search_external_records` tool — no duplicated
 * connector logic. The connector framework already handles
 * Salesforce / HubSpot / generic-REST under one interface; this
 * provider just calls `connector.searchRecords()` across the common
 * object types and maps each record onto `SearchResult`.
 *
 * Discovery: we ask `pickConfiguredConnector(workspaceId)` for the
 * preferred active CRM row (vendor-specific OAuth rows beat
 * rest-default, see credentials.ts comment). When there is no row
 * AND no env-default, `isEnabled` returns false and the provider is
 * skipped cleanly.
 *
 * URLs: for Salesforce the per-record URL is `<instance_url>/<Id>`;
 * for HubSpot we surface the connector's baseUrl + object/record
 * path (best-effort — when the connector exposes nothing useful we
 * omit the URL rather than fabricate one).
 */

import {
  buildRestConnectorForWorkspace,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import { loadConnectorCredentials } from "@/lib/assistant/connectors";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { buildSnippet } from "./util";

const DEFAULT_WORKSPACE = "default";

/* The object types we expand into. The connector framework's preset
 * objectMap covers Salesforce (Contact / Opportunity / Account) and
 * HubSpot (Contact / Deal / Company) under the same domain words. */
const OBJECT_TYPES = ["contact", "deal", "account"] as const;

async function pickConnectorName(workspaceId: string): Promise<string | null> {
  const preferred = await pickConfiguredConnector(workspaceId);
  if (preferred && preferred !== "rest-default") return preferred;
  /* Fall through to rest-default — only viable when env-driven
   *  baseUrl/auth are present (single-workspace deploys). The
   *  connector itself will report isConfigured()=false otherwise. */
  return "rest-default";
}

function valueOf(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function buildRecordUrl(
  vendor: string,
  baseUrl: string | undefined,
  objectType: string,
  record: Record<string, unknown>,
): string | undefined {
  const id = valueOf(record, "Id", "id");
  if (!id) return undefined;
  if (vendor === "salesforce" && baseUrl) {
    /* SF: <instance_url>/<Id> opens the record in Lightning. */
    return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
  }
  if (vendor === "hubspot") {
    /* HubSpot's portal URL pattern needs the portal id which the API
     *  token alone doesn't expose. Surface the API base path as a
     *  fallback the user can paste; admin UI eventually replaces. */
    const map: Record<string, string> = {
      contact: "contacts",
      deal: "deals",
      account: "companies",
      company: "companies",
    };
    const path = map[objectType] ?? `${objectType}s`;
    return `https://app.hubspot.com/${path}/${encodeURIComponent(id)}`;
  }
  /* Generic REST: surface the API URL — better than nothing for the
   *  citation surface. The connector's own baseUrl + objectMap path. */
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
  }
  return undefined;
}

function recordTitle(record: Record<string, unknown>, objectType: string): string {
  const name = valueOf(record, "Name", "name", "fullName", "FullName");
  if (name) return `${name} (${objectType})`;
  const id = valueOf(record, "Id", "id") ?? "?";
  return `${objectType} ${id}`;
}

function recordSnippet(record: Record<string, unknown>, objectType: string, query: string): string {
  const extras: string[] = [];
  if (objectType === "contact") {
    const email = valueOf(record, "Email", "email", "primaryEmail");
    if (email) extras.push(email);
    const acct =
      valueOf(record, "Account.Name") ??
      (record["Account"] as { Name?: string } | undefined)?.Name;
    if (acct) extras.push(`@ ${acct}`);
  } else if (objectType === "deal") {
    const stage = valueOf(record, "StageName", "stage");
    const amount = valueOf(record, "Amount", "amount");
    if (stage) extras.push(stage);
    if (amount) extras.push(`$${amount}`);
  } else if (objectType === "account") {
    const industry = valueOf(record, "Industry", "industry");
    const phone = valueOf(record, "Phone", "phone");
    if (industry) extras.push(industry);
    if (phone) extras.push(phone);
  }
  const joined = extras.join(" · ");
  return joined || buildSnippet(JSON.stringify(record).slice(0, 240), query);
}

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  /* Empty query: no useful CRM result without at least a fragment.
   *  Mirrors the connector's own validation (min 2 chars). Bail
   *  early to avoid a wasted round-trip. */
  if (!query || query.trim().length < 2) return [];
  const workspaceId = ctx.workspaceId || DEFAULT_WORKSPACE;
  const connectorName = await pickConnectorName(workspaceId);
  if (!connectorName) return [];
  const connector = await buildRestConnectorForWorkspace(workspaceId, connectorName);
  if (!connector.isConfigured()) return [];
  /* Vendor lookup feeds the URL builder. We re-read the credentials
   *  row for the per-tenant baseUrl (Salesforce instance_url).
   *  Env-default rest-default returns null here. */
  const creds = await loadConnectorCredentials(workspaceId, connectorName);
  const vendor = connectorName; // "salesforce" / "hubspot" / "rest-default"
  /* Per-type slot allocation inside the CRM provider: divide the
   *  per-provider budget across the object types we expand into so
   *  one mega-result account search doesn't crowd out contacts. */
  const perObject = Math.max(1, Math.ceil(perTypeLimit / OBJECT_TYPES.length));
  const out: SearchResult[] = [];
  for (const objectType of OBJECT_TYPES) {
    const r = await connector.searchRecords(objectType, query, perObject);
    if (!r.ok) continue;
    const records = r.data ?? [];
    for (const rec of records) {
      const id = valueOf(rec, "Id", "id") ?? "";
      if (!id) continue;
      out.push({
        type: "crm",
        id: `${vendor}:${objectType}:${id}`,
        title: recordTitle(rec, objectType),
        snippet: recordSnippet(rec, objectType, query),
        /* CRM records don't carry a stable timestamp shape across
         *  vendors. SystemModstamp / hs_lastmodifieddate land here
         *  when present; otherwise an empty string (the merger
         *  tolerates that, matches channel behavior). */
        timestamp:
          valueOf(rec, "LastModifiedDate", "SystemModstamp", "hs_lastmodifieddate", "updatedAt") ?? "",
        url: buildRecordUrl(vendor, creds?.baseUrl, objectType, rec),
      });
      if (out.length >= perTypeLimit) return out;
    }
  }
  return out;
}

async function isEnabled(ctx: RunSearchContext): Promise<boolean> {
  /* pickConfiguredConnector returns null when no DB row exists and no
   *  env DATABASE_URL is set. In single-workspace deploys the env-
   *  driven rest-default still applies — we check via the connector's
   *  own isConfigured() in the search path. Returning true here keeps
   *  env-only deployments working. */
  const workspaceId = ctx.workspaceId || DEFAULT_WORKSPACE;
  const preferred = await pickConfiguredConnector(workspaceId);
  if (preferred) return true;
  /* No DB row — check env-default. Building a connector here is the
   *  cheapest way to ask "are env creds present" without duplicating
   *  the env-parsing. */
  const connector = await buildRestConnectorForWorkspace(workspaceId, "rest-default");
  return connector.isConfigured();
}

export const crmProvider: SearchProvider = {
  type: "crm",
  name: "CRM",
  countKey: "crm",
  isEnabled,
  search,
};
