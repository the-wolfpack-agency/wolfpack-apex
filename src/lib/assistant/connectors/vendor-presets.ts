/**
 * vendor-presets.ts — known baseUrls + objectMaps for popular CRMs.
 *
 * Both HubSpot and Salesforce expose well-documented REST APIs that
 * fit the generic RestConnector shape cleanly — there's no need for
 * a vendor-specific SDK wrapper for the read-only paths Phase-4 cares
 * about. Each preset is just a default (baseUrl, objectMap) the admin
 * route applies when the caller posts only the auth header.
 *
 * Adding a new vendor: add an entry here. The connector dispatcher
 * doesn't change. Anything beyond simple REST (e.g. Salesforce SOQL,
 * QuickBooks OAuth-only) lands as a separate Connector implementation
 * in a follow-up.
 */

export interface VendorPreset {
  baseUrl: string;
  objectMap: Record<string, string>;
  description: string;
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

/** Returns the preset (baseUrl + objectMap) for a known vendor name,
 *  or null when the connector is a non-preset name (e.g. "rest-default").
 *  Callers merge the preset with caller-supplied overrides. */
export function getVendorPreset(connectorName: string): VendorPreset | null {
  return VENDOR_PRESETS[connectorName] ?? null;
}
