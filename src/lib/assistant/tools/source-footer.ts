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
 *  Every CRM/external-system tool answer carries this footer in the
 *  body so the source is preserved even when the answer is read by a
 *  non-chat consumer (analytics export, transcript download, a refresh
 *  of a saved conversation message where the connectorSource field
 *  didn't get persisted). The chat UI extracts the footer at render
 *  time and renders it as a styled badge alongside "Zero tokens" (see
 *  `extractSourceFooter` below + InstinctChat consuming it).
 *
 *  Callers MAY pass `{ inline: false }` to skip the footer for
 *  contexts where the data is already attributed (e.g. a dashboard
 *  card that names the connector in the heading). */
export function withSourceFooter(
  answer: string,
  connectorName?: string | null,
  opts: { inline?: boolean } = {},
): string {
  const inline = opts.inline ?? true;
  if (!connectorName || !inline) return answer;
  const trimmed = answer.replace(/\s+$/g, "");
  return `${trimmed}\n\n*— Source: ${sourceLabel(connectorName)}*`;
}

/** Reverse of withSourceFooter: pull the source attribution back out of
 *  an answer body. Returns the connector label (e.g. "Salesforce") and
 *  the answer with the footer stripped, or null when no footer present.
 *  Used by the chat UI to render the badge + show a clean body. */
export function extractSourceFooter(
  answer: string,
): { label: string; bodyWithoutFooter: string } | null {
  const m = /\n\n\*— Source: ([^*\n]+)\*\s*$/.exec(answer);
  if (!m) return null;
  return {
    label: m[1].trim(),
    bodyWithoutFooter: answer.slice(0, m.index),
  };
}

/** Inverse lookup for the badge UI: vendor display label → canonical
 *  connector name. Lets the UI extract "Salesforce" from a stripped
 *  footer and route to the right badge color. Falls back to lowercase
 *  of the label for unknown vendors. */
export function connectorNameFromLabel(label: string): string {
  for (const [name, l] of Object.entries(CONNECTOR_LABELS)) {
    if (l === label) return name;
  }
  return label.toLowerCase();
}
