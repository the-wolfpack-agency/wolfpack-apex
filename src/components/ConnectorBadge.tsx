/**
 * ConnectorBadge — styled pill rendered next to "Zero tokens" when an
 * assistant answer came from a CRM or external system (Salesforce,
 * HubSpot, GitHub, Jira, …).
 *
 * Extracted from InstinctChat so it has its own DOM-level test
 * (`__tests__/ConnectorBadge.test.tsx`). The bug pattern this catches:
 * a connectorSource string flows through the API correctly but never
 * appears in the rendered chat because of a regression in the message
 * metadata row's conditional gates. A regression there is invisible
 * until a user (or the demo) hits the exact tool path.
 *
 * Keep this component pure — no hooks, no context, no side effects.
 * `connector` is the canonical lowercase name (e.g. "salesforce"); the
 * map below resolves it to the display label + color. Unknown names
 * still render (badge shows the raw name) so a newly-added connector
 * is never silently invisible.
 */

interface ConnectorStyle {
  label: string;
  color: string;
}

const CONNECTOR_BADGE: Record<string, ConnectorStyle> = {
  salesforce: { label: "Salesforce", color: "#00a1e0" },
  hubspot: { label: "HubSpot", color: "#ff7a59" },
  quickbooks: { label: "QuickBooks", color: "#2ca01c" },
  jira: { label: "Jira", color: "#2684ff" },
  /* GitHub doesn't have a strong brand color we can rely on across
     light + dark themes. #6e7681 is the gray they use for muted UI in
     primer.style — readable on white AND on dark backgrounds with the
     20%-alpha pill we render. */
  github: { label: "GitHub", color: "#6e7681" },
  zendesk: { label: "Zendesk", color: "#03363d" },
};

export function resolveConnectorStyle(name: string): ConnectorStyle {
  return CONNECTOR_BADGE[name] ?? {
    label: name,
    color: "var(--wp-text-muted, #6b7280)",
  };
}

export interface ConnectorBadgeProps {
  /** The lowercase canonical connector name from the API. Renders
   *  nothing when this is falsy — callers can render unconditionally. */
  connector?: string | null;
}

export function ConnectorBadge({ connector }: ConnectorBadgeProps) {
  if (!connector) return null;
  const style = resolveConnectorStyle(connector);
  return (
    <span
      data-testid={`connector-badge-${connector}`}
      className="inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium"
      style={{
        background: `${style.color}20`,
        color: style.color,
        border: `1px solid ${style.color}40`,
      }}
    >
      {style.label}
    </span>
  );
}
