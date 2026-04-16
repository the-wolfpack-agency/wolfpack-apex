/**
 * MS capabilities probe — derived from the MS_SCOPES list in microsoft-graph.
 *
 * Reads the requested scope set from the environment (via the process-wide
 * MS_SCOPES constant exposed indirectly through getAuthUrl's string). To
 * keep this decoupled from the private MS_SCOPES array we snapshot the
 * scopes at module load by reading the authorization URL and parsing the
 * `scope` query parameter. This ensures this module never drifts from
 * Stream D's ownership of the scope list.
 *
 * If the probe fails (e.g. env vars missing), falls back to `false` for
 * every Tier 2 capability — the UI will show the tooltip-gated disabled
 * state Stream A shipped.
 */

export interface MsCapabilities {
  // Tier 2 · Stream E
  onlineMeetings: boolean;
  channelMessages: boolean;
  // Tier 2 · Stream D
  planner: boolean;
  groups: boolean;
  // Tier 2 · Stream F / B
  directory: boolean;
  mailboxSettings: boolean;
  // Always-on Tier 1 reference
  calendarWrite: boolean;
  mailSend: boolean;
}

const ZERO: MsCapabilities = {
  onlineMeetings: false,
  channelMessages: false,
  planner: false,
  groups: false,
  directory: false,
  mailboxSettings: false,
  calendarWrite: false,
  mailSend: false,
};

function readRequestedScopes(): Set<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAuthUrl } = require("@/lib/microsoft-graph");
    const url = getAuthUrl("probe");
    if (!url) return new Set();
    const qs = new URL(url).searchParams.get("scope") ?? "";
    return new Set(qs.split(/\s+/).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function getScopeCapabilities(): MsCapabilities {
  const scopes = readRequestedScopes();
  if (scopes.size === 0) return ZERO;
  return {
    onlineMeetings: scopes.has("OnlineMeetings.ReadWrite.All"),
    channelMessages: scopes.has("ChannelMessage.Read.All"),
    planner: scopes.has("Tasks.ReadWrite.Shared"),
    groups: scopes.has("Group.Read.All"),
    directory:
      scopes.has("User.ReadBasic.All") ||
      scopes.has("User.Read.All") ||
      scopes.has("Directory.Read.All"),
    mailboxSettings: scopes.has("MailboxSettings.Read"),
    calendarWrite: scopes.has("Calendars.ReadWrite"),
    mailSend: scopes.has("Mail.Send"),
  };
}
