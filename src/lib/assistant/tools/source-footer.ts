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

/** Source attribution helper.
 *
 *  The chat UI renders the connector source as a styled badge
 *  ("Salesforce" / "HubSpot" / "GitHub") alongside "Zero tokens".
 *  Source data flows from:
 *    1. The tool's typed data block → AssistantResponse.connectorSource
 *       → API JSON → Message.connectorSource → badge render.
 *    2. Persisted on the message row in metadata.connector_source so
 *       conversation reloads also render the badge.
 *
 *  This helper is a NO-OP by default for the chat surface — the badge
 *  is the canonical attribution, never inline body text. Non-UI
 *  consumers (analytics export, transcript download) can opt in via
 *  `inline: true` if they need a self-contained string. */
export function withSourceFooter(
  answer: string,
  connectorName?: string | null,
  opts: { inline?: boolean } = {},
): string {
  if (!connectorName || !opts.inline) return answer;
  const trimmed = answer.replace(/\s+$/g, "");
  return `${trimmed}\n\n*— Source: ${sourceLabel(connectorName)}*`;
}
