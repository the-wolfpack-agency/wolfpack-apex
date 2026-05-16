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

/** Append the source attribution to an answer.
 *
 *  As of 2026-05-16 the chat UI renders the connector source as a
 *  styled badge alongside "Zero tokens" — sourced from the
 *  `connectorSource` field on AssistantResponse, populated by the
 *  dispatcher from the tool's typed data. The badge replaced the
 *  inline italic markdown footer for clarity (the markdown blended
 *  in with the answer body).
 *
 *  This helper is now a NO-OP for the chat surface (returns answer
 *  unchanged) but kept so:
 *    1. Tool tests keep the call site → easy to flip back if the
 *       badge UX regresses.
 *    2. Non-UI consumers of the answer string (analytics export,
 *       transcript download) can opt in via `inline: true`.
 *
 *  Migration path complete: every connector tool already calls this;
 *  flipping to `inline: true` re-adds the footer everywhere if
 *  needed. */
export function withSourceFooter(
  answer: string,
  connectorName?: string | null,
  opts: { inline?: boolean } = {},
): string {
  if (!connectorName || !opts.inline) return answer;
  const trimmed = answer.replace(/\s+$/g, "");
  return `${trimmed}\n\n*— Source: ${sourceLabel(connectorName)}*`;
}
