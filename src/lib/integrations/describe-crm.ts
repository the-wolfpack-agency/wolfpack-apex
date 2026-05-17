/**
 * Vendor schema describe — for CRM widgets that mirror the source
 * tool's field set 1:1 instead of hand-curating.
 *
 * Today this is used by the create_crm_record form tool to pull
 * Salesforce describe / HubSpot properties at form-render time so
 * the chat form matches what the tenant actually has (custom fields
 * included). Tomorrow it's the same surface the nightly orchestrator
 * hashes for drift detection.
 *
 * Strategy:
 *   1. Try the vendor's live describe endpoint via the workspace's
 *      connector credentials.
 *   2. On any failure (no creds, rate limit, 5xx, schema endpoint
 *      not mapped), fall back to integration_templates.fallback_field_set
 *      so the user still gets a usable form.
 *   3. The fallback is the same shape as a live response — the form
 *      tool doesn't need to know which path was taken.
 */

import { loadConnectorCredentials } from "@/lib/assistant/connectors/credentials";
import { getIntegrationTemplate } from "@/lib/templates/registry";

export type CrmVendor = "salesforce" | "hubspot";
export type CrmObjectType = "deal" | "contact" | "account" | "task";

export interface DescribedField {
  /** Vendor's field name (Salesforce: "StageName", HubSpot: "dealstage"). */
  name: string;
  /** Vendor's type label normalized to a small set. */
  type: "string" | "number" | "date" | "datetime" | "select" | "boolean" | "reference" | "other";
  required: boolean;
  /** Picklist values when type=select. */
  options?: Array<{ value: string; label: string }>;
  /** Display label preferred by the vendor (Salesforce "Stage", HubSpot "Deal stage"). */
  label?: string;
  /** Vendor's max-length hint, when present. */
  maxLength?: number;
}

export interface DescribeResult {
  fields: DescribedField[];
  /** Where the fields came from. "fallback" means the live describe
   *  failed and we used the template registry's snapshot. The form
   *  tool surfaces this so the UI can show a "may be out of date"
   *  hint when relevant. */
  source: "live" | "fallback" | "none";
  /** Vendor-specific schema hash; equal to the integration_health
   *  hash when source="live". */
  schemaHash?: string;
}

/* Vendor endpoint paths — kept here rather than imported from
 * integration-probes.ts so this module can be exercised in tests
 * without dragging the probe lib's wider mock surface. */
const SF_PATHS: Record<CrmObjectType, string> = {
  deal: "/services/data/v59.0/sobjects/Opportunity/describe",
  contact: "/services/data/v59.0/sobjects/Contact/describe",
  account: "/services/data/v59.0/sobjects/Account/describe",
  task: "/services/data/v59.0/sobjects/Task/describe",
};

const HS_PATHS: Record<CrmObjectType, string> = {
  deal: "/crm/v3/properties/deals",
  contact: "/crm/v3/properties/contacts",
  account: "/crm/v3/properties/companies",
  task: "/crm/v3/properties/tasks",
};

const TEMPLATE_ID: Record<CrmVendor, string> = {
  salesforce: "create_crm_record_form",
  hubspot: "create_crm_record_form",
};

function mapSalesforceType(raw: string): DescribedField["type"] {
  switch (raw) {
    case "string":
    case "textarea":
    case "phone":
    case "email":
    case "url":
    case "id":
      return "string";
    case "currency":
    case "double":
    case "int":
    case "percent":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "picklist":
    case "multipicklist":
      return "select";
    case "boolean":
      return "boolean";
    case "reference":
      return "reference";
    default:
      return "other";
  }
}

function mapHubspotType(raw: string): DescribedField["type"] {
  switch (raw) {
    case "string":
    case "enumeration":
      return raw === "enumeration" ? "select" : "string";
    case "number":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "bool":
      return "boolean";
    default:
      return "other";
  }
}

function extractSalesforce(payload: Record<string, unknown>): DescribedField[] {
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  return fields
    .map((f) => {
      const raw = f as Record<string, unknown>;
      const type = mapSalesforceType(String(raw.type ?? ""));
      const out: DescribedField = {
        name: String(raw.name ?? ""),
        type,
        /* required = !nillable && !defaultedOnCreate — the same predicate
         * the integration-health probe uses. */
        required: raw.nillable === false && raw.defaultedOnCreate === false,
      };
      if (typeof raw.label === "string") out.label = raw.label;
      if (typeof raw.length === "number" && raw.length > 0) out.maxLength = raw.length;
      if (type === "select" && Array.isArray(raw.picklistValues)) {
        out.options = (raw.picklistValues as Array<Record<string, unknown>>)
          .filter((p) => p.active !== false)
          .map((p) => ({
            value: String(p.value ?? ""),
            label: String(p.label ?? p.value ?? ""),
          }))
          .filter((p) => p.value);
      }
      return out;
    })
    .filter((f) => f.name);
}

function extractHubspot(payload: Record<string, unknown>): DescribedField[] {
  const results = Array.isArray((payload as { results?: unknown[] }).results)
    ? (payload as { results: unknown[] }).results
    : [];
  return results
    .map((r) => {
      const raw = r as Record<string, unknown>;
      const out: DescribedField = {
        name: String(raw.name ?? ""),
        type: mapHubspotType(String(raw.type ?? "")),
        /* HubSpot doesn't carry "required" on the property level —
         * it's enforced at form creation time. For drift + fallback
         * we default false; the integration_templates fallback row
         * can override per-field. */
        required: false,
      };
      if (typeof raw.label === "string") out.label = raw.label;
      if (out.type === "select" && Array.isArray(raw.options)) {
        out.options = (raw.options as Array<Record<string, unknown>>)
          .map((p) => ({
            value: String(p.value ?? ""),
            label: String(p.label ?? p.value ?? ""),
          }))
          .filter((p) => p.value);
      }
      return out;
    })
    .filter((f) => f.name);
}

/**
 * Pull the vendor's describe for the given object. Falls back to the
 * integration_templates row's frozen schema when the live call fails.
 */
export async function describeCrmObject(
  vendor: CrmVendor,
  objectType: CrmObjectType,
  workspaceId: string,
): Promise<DescribeResult> {
  const path = vendor === "salesforce" ? SF_PATHS[objectType] : HS_PATHS[objectType];
  if (!path) return loadFallback(vendor);

  try {
    const creds = await loadConnectorCredentials(workspaceId, vendor);
    if (!creds || !creds.isActive) {
      return loadFallback(vendor);
    }
    const res = await fetch(`${creds.baseUrl}${path}`, {
      headers: { Authorization: creds.authHeader, Accept: "application/json" },
    });
    if (res.status < 200 || res.status >= 300) {
      return loadFallback(vendor);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    const fields = vendor === "salesforce"
      ? extractSalesforce(payload)
      : extractHubspot(payload);
    if (fields.length === 0) return loadFallback(vendor);
    return { fields, source: "live" };
  } catch {
    return loadFallback(vendor);
  }
}

async function loadFallback(vendor: CrmVendor): Promise<DescribeResult> {
  const tpl = await getIntegrationTemplate(TEMPLATE_ID[vendor]);
  if (!tpl || tpl.fallbackFieldSet.length === 0) {
    return { fields: [], source: "none" };
  }
  /* Adapt template fallback shape → DescribedField. The template
   * stores at least { name, required? }; type info is optional. */
  const fields: DescribedField[] = tpl.fallbackFieldSet.map((f) => ({
    name: f.name,
    type: "string",
    required: !!f.required,
  }));
  return { fields, source: "fallback", schemaHash: tpl.lastKnownSchemaHash ?? undefined };
}
