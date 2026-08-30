/**
 * What this workspace already runs, offered to the scanner as an explanation.
 *
 * THE PROBLEM IT SOLVES. The anomaly detector calls a third-party host
 * "unexplained" when nothing in the target's own declarations accounts for it.
 * On a real scan that meant six unexplained hosts, and the reason the list was
 * that long is in the caveat the detector printed itself: the site's
 * Content-Security-Policy permits any host, so it explains nothing. One source
 * of truth, and a permissive one.
 *
 * This product holds a second source. It probes its own integrations nightly
 * and knows which ones a workspace actually runs. buildDeclarations has always
 * accepted `integrationHosts`, described as "hosts implied by integrations the
 * client is known to run", and nothing has ever populated it.
 *
 * WHAT IT WILL AND WILL NOT DO, because the difference matters and is easy to
 * get backwards. Our integrations explain traffic from OUR systems. Walking a
 * third-party product the client happens to use, its vendors are its own: the
 * Salesforce we run does not account for the analytics its forms platform
 * loads, and this will correctly explain nothing there. It earns its keep when
 * the scanned system is one of ours, where "unexplained host" and "the CRM you
 * connected on Tuesday" are otherwise indistinguishable.
 *
 * ONLY INTEGRATIONS THAT ACTUALLY PROBE HEALTHY. A vendor with credentials
 * that no longer work is not an explanation for live traffic: if something is
 * still contacting it, that is the finding rather than the excuse.
 *
 * NO CLIENT DATA IS READ OR STORED. This reads a vendor name and whether its
 * last probe passed. The hosts are a static table in this file.
 */

import { safeQuery } from "@/lib/db";

/**
 * Host signatures per integration this product supports.
 *
 * Precision-first, matching the detector philosophy: a short list of things we
 * are sure about beats a long one that explains away traffic nobody checked.
 * A host missing from here is reported as unexplained, which is the safe
 * direction to be wrong in.
 */
export const INTEGRATION_HOSTS: Readonly<Record<string, readonly string[]>> = {
  microsoft: [
    "graph.microsoft.com",
    "login.microsoftonline.com",
    "sharepoint.com",
    "office.com",
    "office365.com",
  ],
  salesforce: ["salesforce.com", "force.com", "salesforceliveagent.com"],
  hubspot: ["hubapi.com", "hubspot.com", "hs-scripts.com"],
  quickbooks: ["intuit.com", "quickbooks.api.intuit.com"],
  resend: ["resend.com"],
  github: ["github.com", "api.github.com", "githubusercontent.com"],
  qdrant: ["qdrant.io", "qdrant.tech"],
  "model-router": ["openai.azure.com", "services.ai.azure.com", "api.anthropic.com"],
};

/** A human name for the integration, for the sentence a reader sees. */
const LABEL: Readonly<Record<string, string>> = {
  microsoft: "the Microsoft 365 integration",
  salesforce: "the Salesforce integration",
  hubspot: "the HubSpot integration",
  quickbooks: "the QuickBooks integration",
  resend: "the Resend email integration",
  github: "the GitHub integration",
  qdrant: "the Qdrant vector store",
  "model-router": "the AI model router",
};

export interface IntegrationHost {
  host: string;
  name: string;
}

/**
 * Turn a set of healthy vendor names into hosts the scanner can match.
 *
 * Split from the database read so the mapping is testable without one, which
 * is where the mistakes would be.
 */
export function hostsForVendors(vendors: readonly string[]): IntegrationHost[] {
  const out: IntegrationHost[] = [];
  const seen = new Set<string>();
  for (const vendor of vendors) {
    const hosts = INTEGRATION_HOSTS[vendor];
    if (!hosts) continue;
    for (const host of hosts) {
      if (seen.has(host)) continue;
      seen.add(host);
      out.push({ host, name: LABEL[vendor] ?? `the ${vendor} integration` });
    }
  }
  return out;
}

/**
 * Integrations this workspace is currently running, by their latest probe.
 *
 * Degrades to an empty list rather than throwing: an unavailable health table
 * must not stop a scan, and explaining nothing is the same answer this had
 * before anything explained anything.
 */
export async function healthyVendorsFor(workspaceId: string): Promise<string[]> {
  const { rows } = await safeQuery<{ vendor: string }>(
    `SELECT DISTINCT ON (vendor) vendor, ok
       FROM integration_health
      WHERE workspace_id = $1
      ORDER BY vendor, probed_at DESC`,
    [workspaceId],
  );
  /* The DISTINCT ON gives the latest row per vendor; only the passing ones are
     an explanation. A vendor whose credentials have stopped working does not
     account for live traffic to it. */
  return rows.filter((r) => (r as unknown as { ok: boolean }).ok).map((r) => r.vendor);
}

export async function integrationHostsFor(workspaceId: string): Promise<IntegrationHost[]> {
  return hostsForVendors(await healthyVendorsFor(workspaceId));
}
