/**
 * Only claim what this deployment is actually connected to.
 *
 * WHAT IT FIXES. "What can you do" reads the live tool registry and filters by
 * the caller's ROLE, which is the right gate and not the only one. Measured on
 * this deployment on 2026-08-31: no connectors configured, zero CRM events
 * ever, zero DMS events ever, and the answer advertised six CRM capabilities
 * and a dealer inventory widget anyway.
 *
 * The file that builds that answer already knows better. It routes "can you
 * SEE my email" to live connection status precisely so it never says yes about
 * a mailbox nobody linked, quoting the reason: a claimed capability that does
 * not exist is the thing a client discovers by relying on it. Plain "what can
 * you do" skipped the check.
 *
 * IT MATTERS MOST FOR THE ONES THAT SOUND MOST RELEVANT. Somebody running
 * dealerships reads forty items and goes straight for "deals over $50k closing
 * this month" and "how many Cayennes are on the lot". Those are the two most
 * tempting lines on the page and, with nothing connected, the two that answer
 * nothing.
 *
 * NOT CONNECTED IS NOT THE SAME AS NOT BUILT, and the wording carries that.
 * These capabilities are real and work the moment a system is linked, so they
 * are named as something to connect rather than hidden or apologised for. The
 * list of what works today stays honest, and the offer stays visible.
 */

/** A system a tool needs before it can do anything. */
export type BackingSystem = "crm" | "dms" | "quickbooks" | "github" | "microsoft";

/**
 * Tools that cannot work until a system is linked.
 *
 * Matched by name because the registry is the only list of tools there is, and
 * a second copy here would drift from it. Anything unmatched is assumed to
 * need nothing, which is the safe direction: a tool wrongly listed as always
 * available is a tool that already worked.
 */
const NEEDS: Array<{ system: BackingSystem; match: RegExp }> = [
  { system: "crm", match: /external_record|crm|related_records|aggregate_external|filter_external/i },
  { system: "dms", match: /dms|inventory/i },
  { system: "quickbooks", match: /quickbooks|invoice_sync/i },
  { system: "github", match: /github|pull_request|workflow_run|issue/i },
];

export function backingSystemFor(toolName: string): BackingSystem | null {
  return NEEDS.find((n) => n.match.test(toolName))?.system ?? null;
}

/** What a person calls each system, for a sentence they will read. */
export const SYSTEM_LABEL: Record<BackingSystem, string> = {
  crm: "a CRM",
  dms: "a dealer management system",
  quickbooks: "QuickBooks",
  github: "GitHub",
  microsoft: "Microsoft 365",
};

export interface ScopedTools<T> {
  /** Runs today. */
  available: T[];
  /** Real, built, and waiting on a connection. */
  awaiting: T[];
  /** The systems those waiting tools need, deduplicated and named. */
  awaitingSystems: BackingSystem[];
}

/**
 * Split a tool list by whether its backing system is connected.
 *
 * `connected` is passed in rather than read here so the decision stays pure
 * and the caller owns the single place that talks to the database.
 */
export function scopeToConnected<T extends { name: string }>(
  tools: T[],
  connected: ReadonlySet<BackingSystem>,
): ScopedTools<T> {
  const available: T[] = [];
  const awaiting: T[] = [];
  const systems = new Set<BackingSystem>();

  for (const tool of tools) {
    const needs = backingSystemFor(tool.name);
    if (needs === null || connected.has(needs)) {
      available.push(tool);
      continue;
    }
    awaiting.push(tool);
    systems.add(needs);
  }

  return { available, awaiting, awaitingSystems: [...systems].sort() };
}

/**
 * One sentence naming what could be connected next.
 *
 * A sentence rather than a second menu, deliberately. Six unavailable CRM
 * capabilities listed one by one read as a product with holes in it; "connect
 * a CRM and this answers questions about your deals" reads as the next step,
 * which is what it is.
 */
export function describeAwaiting(systems: BackingSystem[]): string | null {
  if (systems.length === 0) return null;
  const names = systems.map((s) => SYSTEM_LABEL[s]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Connect ${list} and I can answer about that too.`;
}

/**
 * Which backing systems this workspace has actually linked.
 *
 * FAILS CLOSED. An unreadable connector table means we do not know, and not
 * knowing must never become a claim: the whole point is to stop the menu
 * saying yes about a system nobody connected. A quiet false negative costs one
 * line of offer; a false positive costs a client's trust the first time they
 * try it.
 */
export async function connectedSystems(workspaceId: string): Promise<Set<BackingSystem>> {
  const connected = new Set<BackingSystem>();

  /* CRM and QuickBooks come from the connector table, which is the only place
     a workspace's own linkage is recorded. */
  try {
    const { safeQuery } = await import("@/lib/db");
    const { rows } = await safeQuery<{ vendor: string }>(
      `SELECT DISTINCT vendor FROM instinct_connector_credentials
        WHERE workspace_id = $1 AND is_active = true`,
      [workspaceId],
    );
    for (const r of rows) {
      const vendor = String(r.vendor).toLowerCase();
      if (/salesforce|hubspot|pipedrive|dynamics|zoho|crm/.test(vendor)) connected.add("crm");
      if (/quickbooks|intuit/.test(vendor)) connected.add("quickbooks");
      if (/dms|dealer/.test(vendor)) connected.add("dms");
    }
  } catch {
    /* silent-ok: fails closed by design. Nothing is added, so nothing is
       claimed, which is the safe outcome and is what an empty result means
       anyway. */
  }

  /* The dealer driver is a separate process reached over HTTP, so its address
     being set is what "connected" means for it. */
  if (process.env.DMS_DRIVER_URL) connected.add("dms");
  if (process.env.GITHUB_TOKEN_WOLFPACK_AGENCY) connected.add("github");

  return connected;
}
