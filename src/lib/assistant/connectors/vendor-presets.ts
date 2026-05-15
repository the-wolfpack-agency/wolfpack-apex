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

/** Write-request descriptor. Same shape for create + update so the
 *  REST connector can route them through one helper. `body` is the
 *  vendor-formatted JSON the request will send. `extractCreatedId`
 *  pulls the new record's id out of whatever shape the vendor returns
 *  (Salesforce: top-level `id`; HubSpot: top-level `id`; generic
 *  REST: same). */
export interface VendorWriteRequest {
  path: string;
  body: Record<string, unknown>;
  extractCreatedId: (raw: unknown) => string | null;
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
  /** Optional write support. Vendors that don't expose REST writes
   *  (or where we haven't shipped them yet — see QuickBooks) leave
   *  this undefined. The action-tool framework then refuses to
   *  dispatch to this connector with a typed error. */
  writes?: {
    create(objectType: string, fields: Record<string, unknown>): VendorWriteRequest;
    update(objectType: string, id: string, fields: Record<string, unknown>): VendorWriteRequest;
  };
  /** Optional related-record search ("Acme's opportunities").
   *  Vendors that don't support relationship queries (or where we
   *  haven't shipped them yet) leave this undefined. */
  relatedSearch?: {
    build(
      parentType: string,
      parentName: string,
      relatedType: string,
      limit: number,
    ): VendorSearchRequest;
  };
  /** Optional filter-query support ("deals over $50k closing this month").
   *  Takes a structured FilterSpec the tool composes from regex
   *  parsing; the vendor preset translates it to the vendor's native
   *  filter expression (SOQL WHERE for Salesforce, search filter
   *  body for HubSpot). */
  filterSearch?: {
    build(
      objectType: string,
      filters: FilterSpec,
      limit: number,
    ): VendorSearchRequest;
  };
}

/** Filter clauses the filter-search tool can apply. Each is optional;
 *  the vendor preset composes the ones present into a vendor-native
 *  expression. New clause types land here as patterns get added. */
export interface FilterSpec {
  /** Numeric amount comparison ("over $50k", "under 10000"). Salesforce
   *  fields: Opportunity.Amount, Account.AnnualRevenue, etc. */
  amount?: { op: "gt" | "lt" | "gte" | "lte" | "eq"; value: number };
  /** Symbolic date range applied to the object's default date field
   *  (Opportunity.CloseDate, Contact.CreatedDate, etc). The vendor
   *  preset translates the symbol to a concrete date literal. */
  dateRange?:
    | "this_week"
    | "last_week"
    | "this_month"
    | "last_month"
    | "next_month"
    | "this_quarter"
    | "this_year";
  /** Stage filter for Opportunity ("stuck in Proposal" / "in Closed Won"). */
  stage?: string;
  /** Owner-name filter ("deals Jorge owns"). The vendor preset substring-
   *  matches against Owner.Name. */
  ownerName?: string;
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
    writes: {
      create(objectType, fields) {
        /* HubSpot wraps custom + standard properties in a "properties"
           envelope on both create and update. */
        return {
          path: `/crm/v3/objects/${objectType}s`,
          body: { properties: fields },
          extractCreatedId: (raw) => {
            const r = raw as { id?: string };
            return typeof r?.id === "string" ? r.id : null;
          },
        };
      },
      update(objectType, id, fields) {
        return {
          path: `/crm/v3/objects/${objectType}s/${encodeURIComponent(id)}`,
          body: { properties: fields },
          extractCreatedId: () => id,
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
    writes: {
      create(objectType, fields) {
        /* Salesforce REST insert: POST to the SObject collection with
           the fields directly as the body (no envelope). Response is
           { id, success, errors }. */
        const SObjectByType: Record<string, string> = {
          contact: "Contact",
          deal: "Opportunity",
          opportunity: "Opportunity",
          company: "Account",
          account: "Account",
          task: "Task",
        };
        const sobject = SObjectByType[objectType] ?? objectType;
        return {
          path: `/services/data/v59.0/sobjects/${sobject}`,
          body: fields,
          extractCreatedId: (raw) => {
            const r = raw as { id?: string };
            return typeof r?.id === "string" ? r.id : null;
          },
        };
      },
      update(objectType, id, fields) {
        /* Salesforce PATCH returns 204 No Content — RestConnector
           treats empty 2xx as success with body=null. extractCreatedId
           falls back to the URL id since we know it. */
        const SObjectByType: Record<string, string> = {
          contact: "Contact",
          deal: "Opportunity",
          opportunity: "Opportunity",
          company: "Account",
          account: "Account",
          task: "Task",
        };
        const sobject = SObjectByType[objectType] ?? objectType;
        return {
          path: `/services/data/v59.0/sobjects/${sobject}/${encodeURIComponent(id)}`,
          body: fields,
          extractCreatedId: () => id,
        };
      },
    },
    relatedSearch: {
      build(parentType, parentName, relatedType, limit) {
        /* "Acme's opportunities" → SOQL:
              SELECT … FROM Opportunity WHERE Account.Name LIKE '%Acme%'
           "Jorge's open deals" / "Jorge's contacts" → owner-based
              SELECT … FROM Opportunity WHERE Owner.Name LIKE '%Jorge%'
           parentType=contact treated as owner; account/company as parent. */
        const RelatedSObject: Record<string, string> = {
          opportunity: "Opportunity",
          deal: "Opportunity",
          contact: "Contact",
          account: "Account",
          company: "Account",
          task: "Task",
        };
        const sobject = RelatedSObject[relatedType] ?? "Opportunity";
        const fields =
          sobject === "Opportunity"
            ? "Id,Name,StageName,Amount,CloseDate,AccountId,Account.Name"
            : sobject === "Contact"
            ? "Id,Name,Email,Phone,AccountId,Account.Name"
            : sobject === "Account"
            ? "Id,Name,Industry,Phone"
            : "Id,Subject,Status,ActivityDate";
        const escaped = sfSoqlEscape(parentName);
        /* Build the relationship clause: account/company parents use
           Account.Name; contact/person parents use Owner.Name (a contact
           "owns" opps/accounts via OwnerId in our usage). */
        let whereClause: string;
        if (parentType === "account" || parentType === "company") {
          whereClause =
            sobject === "Opportunity" || sobject === "Contact"
              ? `Account.Name LIKE '%${escaped}%'`
              : `Name LIKE '%${escaped}%'`;
        } else {
          /* Owner-based relationship (Jorge's deals / Jorge's contacts). */
          whereClause = `Owner.Name LIKE '%${escaped}%'`;
        }
        const soql = `SELECT ${fields} FROM ${sobject} WHERE ${whereClause} LIMIT ${limit}`;
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
    filterSearch: {
      build(objectType, filters, limit) {
        /* Compose a SOQL WHERE from the FilterSpec. Always SELECTs
           the same per-sobject field set we use elsewhere so the
           tool's renderer doesn't have to fork. */
        const SObjectByType: Record<string, string> = {
          contact: "Contact",
          deal: "Opportunity",
          opportunity: "Opportunity",
          account: "Account",
          company: "Account",
        };
        const sobject = SObjectByType[objectType] ?? "Opportunity";
        const fields =
          sobject === "Opportunity"
            ? "Id,Name,StageName,Amount,CloseDate,AccountId,Account.Name,Owner.Name"
            : sobject === "Contact"
            ? "Id,Name,Email,Phone,AccountId,Account.Name,Owner.Name"
            : "Id,Name,Industry,Phone,Owner.Name";

        const clauses: string[] = [];
        if (filters.amount && sobject === "Opportunity") {
          const op = ({ gt: ">", lt: "<", gte: ">=", lte: "<=", eq: "=" } as const)[filters.amount.op];
          clauses.push(`Amount ${op} ${filters.amount.value}`);
        }
        if (filters.stage && sobject === "Opportunity") {
          clauses.push(`StageName = '${sfSoqlEscape(filters.stage)}'`);
        }
        if (filters.ownerName) {
          clauses.push(`Owner.Name LIKE '%${sfSoqlEscape(filters.ownerName)}%'`);
        }
        if (filters.dateRange) {
          const dateField = sobject === "Opportunity" ? "CloseDate" : "CreatedDate";
          /* Salesforce SOQL date literals: THIS_WEEK, LAST_WEEK,
             THIS_MONTH, LAST_MONTH, NEXT_MONTH, THIS_QUARTER, THIS_YEAR
             are unquoted reserved tokens. */
          const SOQL_LITERAL: Record<string, string> = {
            this_week: "THIS_WEEK",
            last_week: "LAST_WEEK",
            this_month: "THIS_MONTH",
            last_month: "LAST_MONTH",
            next_month: "NEXT_MONTH",
            this_quarter: "THIS_QUARTER",
            this_year: "THIS_YEAR",
          };
          const lit = SOQL_LITERAL[filters.dateRange];
          if (lit) clauses.push(`${dateField} = ${lit}`);
        }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const orderBy = sobject === "Opportunity" ? "ORDER BY Amount DESC NULLS LAST" : "ORDER BY Name";
        const soql = `SELECT ${fields} FROM ${sobject} ${where} ${orderBy} LIMIT ${limit}`.replace(/\s+/g, " ").trim();
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
