/**
 * Shared source-attribution footer for connector-backed tool answers.
 *
 * Every CRM-backed tool (get/search/related/filter/aggregate/create/
 * update) appends this footer so the user can always tell which
 * system the data came from. Critical when a workspace has multiple
 * CRMs connected (Salesforce + HubSpot) and the same query could in
 * principle return data from either.
 *
 * Format intentionally subtle — italic, single line, separated by a
 * blank line so it doesn't compete with the answer.
 */

/** Friendly display label for known connectors. Falls back to the
 *  raw name (e.g. "rest-default") when the connector isn't in the
 *  table — that's still informative; the user can see which connector
 *  the assistant routed to. */
const CONNECTOR_LABELS: Record<string, string> = {
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  quickbooks: "QuickBooks",
  jira: "Jira",
  github: "GitHub",
  zendesk: "Zendesk",
  "rest-default": "REST (generic)",
};

export function sourceLabel(connectorName: string): string {
  return CONNECTOR_LABELS[connectorName] ?? connectorName;
}

/** Append the source attribution to an answer. Returns the answer
 *  unchanged when no connector is provided (e.g. "not configured"
 *  paths where the source is implicit / irrelevant). */
export function withSourceFooter(answer: string, connectorName?: string | null): string {
  if (!connectorName) return answer;
  const trimmed = answer.replace(/\s+$/g, "");
  return `${trimmed}\n\n*— Source: ${sourceLabel(connectorName)}*`;
}
