/**
 * vendor-presets.ts — known baseUrls + objectMaps + search shapes for
 * popular CRMs.
 *
 * Each preset captures three things every connector-backed vendor
 * needs the same way:
 *   1. baseUrl  — API root (or empty when per-org)
 *   2. objectMap — domain object name → URL path for record lookup
 *   3. search    — provider-aware free-text search (Salesforce SOSL,
 *                  HubSpot search endpoint, etc.)
 *
 * Adding a new vendor: add an entry here. The connector dispatcher
 * doesn't change. Anything beyond simple REST (Salesforce SOQL
 * filter queries, QuickBooks OAuth-only) lands as a separate
 * Connector implementation in a follow-up.
 */

/** Result of building a search request — RestConnector takes this and
 *  executes the GET, then runs `extract` over the parsed response body. */
export interface VendorSearchRequest {
  /** Path appended to baseUrl. Pre-encoded; RestConnector does not
   *  further URL-encode this. */
  path: string;
  /** Pull a normalized list of records out of whatever shape the
   *  vendor returns. */
  extract: (raw: unknown) => Array<Record<string, unknown>>;
}

export interface VendorPreset {
  baseUrl: string;
  objectMap: Record<string, string>;
  description: string;
  /** Optional — when present, RestConnector.searchRecords uses this to
   *  build the request. When absent, the connector falls back to a
   *  generic `${path}?q=${q}&limit=${limit}` shape (matches HubSpot's
   *  legacy contacts-search style). */
  search?: {
    /** Build the request for a single object type. Vendors that don't
     *  support per-object-type search (or always search across all
     *  objects) can ignore objectType and return the same shape. */
    build(objectType: string, query: string, limit: number): VendorSearchRequest;
  };
}

/** Salesforce SOQL string-literal escape. Single quotes wrap the value,
 *  so any embedded single quote must be doubled. We also strip backslashes
 *  because they're not legal inside a SOQL string. */
function sfSoqlEscape(s: string): string {
  return s.replace(/\\/g, "").replace(/'/g, "\\'");
}

/** URL-encoder for SOQL/SOSL query strings — the SF REST `q` parameter
 *  needs `%20` for spaces, but `+` is also accepted. URLSearchParams uses
 *  `+`; we go with that for compactness. */
function sfEncode(s: string): string {
  return new URLSearchParams({ q: s }).toString();
}

export const VENDOR_PRESETS: Record<string, VendorPreset> = {
  hubspot: {
    baseUrl: "https://api.hubapi.com",
    objectMap: {
      contact: "crm/v3/objects/contacts",
      deal: "crm/v3/objects/deals",
      company: "crm/v3/objects/companies",
      ticket: "crm/v3/objects/tickets",
    },
    description:
      "HubSpot CRM v3. Auth header: 'Bearer <private-app-token>' (settings → integrations → private apps).",
    search: {
      build(objectType, query, limit) {
        /* HubSpot v3 search uses POST with a filter body, but their
           GET-based contact list with a `q` query string covers the
           common "look up someone by name/email" case. We use the GET
           shape for simplicity until per-property filter UX warrants
           the POST upgrade. */
        const path = `/crm/v3/objects/${objectType}s?q=${encodeURIComponent(query)}&limit=${limit}`;
        return {
          path,
          extract: (raw) => {
            const r = raw as { results?: Array<Record<string, unknown>> };
            return Array.isArray(r?.results) ? r.results : [];
          },
        };
      },
    },
  },
  salesforce: {
    /* baseUrl varies per org (https://<instance>.my.salesforce.com).
       Caller MUST override; we leave it empty so the admin route
       requires it. */
    baseUrl: "",
    objectMap: {
      contact: "services/data/v59.0/sobjects/Contact",
      deal: "services/data/v59.0/sobjects/Opportunity",
      company: "services/data/v59.0/sobjects/Account",
      account: "services/data/v59.0/sobjects/Account",
    },
    description:
      "Salesforce REST API. Auth header: 'Bearer <oauth-access-token>'. baseUrl must be the org's https://<instance>.my.salesforce.com.",
    search: {
      build(objectType, query, limit) {
        /* Salesforce SOQL for the common "look up Grimace" / "find
           grimace@example.com" case. Matches Name OR Email containing
           the query (substring, case-insensitive on Salesforce's side).
           For multi-object search we'd switch to SOSL; this single-
           object SOQL covers the 80% case and disambiguates results
           cleanly. */
        const SObjectByType: Record<string, string> = {
          contact: "Contact",
          deal: "Opportunity",
          company: "Account",
          account: "Account",
        };
        const sobject = SObjectByType[objectType] ?? "Contact";
        const fields =
          sobject === "Contact"
            ? "Id,Name,Email,Phone,AccountId,Account.Name"
            : sobject === "Opportunity"
            ? "Id,Name,StageName,Amount,CloseDate,AccountId"
            : "Id,Name,Phone,Website,Industry";
        const escaped = sfSoqlEscape(query);
        const where =
          sobject === "Contact"
            ? `Name LIKE '%${escaped}%' OR Email LIKE '%${escaped}%'`
            : `Name LIKE '%${escaped}%'`;
        const soql = `SELECT ${fields} FROM ${sobject} WHERE ${where} LIMIT ${limit}`;
        const path = `/services/data/v59.0/query?${sfEncode(soql)}`;
        return {
          path,
          extract: (raw) => {
            const r = raw as { records?: Array<Record<string, unknown>> };
            return Array.isArray(r?.records) ? r.records : [];
          },
        };
      },
    },
  },
  quickbooks: {
    /* QuickBooks Online uses a realmId in the URL — same pattern as
       Salesforce: caller provides the full base including the realm. */
    baseUrl: "",
    objectMap: {
      invoice: "v3/company/REALM_ID/invoice",
      payment: "v3/company/REALM_ID/payment",
      customer: "v3/company/REALM_ID/customer",
    },
    description:
      "QuickBooks Online. baseUrl: https://quickbooks.api.intuit.com (sandbox: https://sandbox-quickbooks.api.intuit.com). Replace REALM_ID in objectMap with the company realm. Auth: 'Bearer <oauth-access-token>'.",
  },
};

/** Returns the preset (baseUrl + objectMap + optional search) for a
 *  known vendor name, or null when the connector is a non-preset name
 *  (e.g. "rest-default"). Callers merge the preset with caller-
 *  supplied overrides. */
export function getVendorPreset(connectorName: string): VendorPreset | null {
  return VENDOR_PRESETS[connectorName] ?? null;
}
