/**
 * Accountable actions replay: run the accountability verdict over recorded
 * site events and return COUNTS ONLY (no paths, principals, fingerprints or
 * countries), so the would-hold set can be sized before any hold is turned on.
 *
 * What the history can and cannot show (honest by construction):
 *   - Rows recorded after this change carry props.accountability: counted as
 *     recorded, by class.
 *   - Older rows never stored the HTTP method, and a normal browser POST was
 *     never forwarded at all (observeRequest returned null). So older rows are
 *     only ACTION-ROUTE HITS: recorded events on a named action route (login,
 *     checkout, ...), method unknown, re-classified from the stored client
 *     class. That is an upper bound on agent actions there and says nothing
 *     about browser volume.
 *   - Header names are not stored, so the Fetch Metadata check cannot run on
 *     history: a stored "browser" counts as a browser session unless it came
 *     from a datacenter.
 *   - site.contact_submitted rows (form submissions the site reports itself)
 *     are counted separately: no client signals were recorded with them.
 */
import {
  DEFAULT_STATE_CHANGE_RULES,
  accountabilityVerdict,
  ACCOUNTABILITY_CLASSES,
  type AccountabilityClass,
  type StateChangeRules,
} from "@/lib/forcefield-web/accountability";
import { scopeMatches } from "@/lib/forcefield/principal-types";

export interface ReplayRow {
  type: string;
  path: string;
  site: string;
  clientType: string | null;
  hosting: string | null;
  authenticated: boolean;
  synthetic: boolean;
  /** Known allowlisted agent or a Web Bot Auth signature on the row. */
  identifiedAgent: boolean;
  principalStatus: string | null;
  principalScopes: string[];
  /** Set on rows recorded with the verdict. */
  accountability: string | null;
  wouldHold: boolean | null;
}

type ClassCounts = Record<AccountabilityClass, number> & { wouldHold: number };

export interface AccountabilityReplay {
  rows: number;
  /** Rows that already carry the recorded verdict. */
  recorded: ClassCounts;
  /** Older rows on a named action route, re-classified (method unknown). */
  actionRouteHits: ClassCounts & { total: number };
  /** Per action kind, for the action-route hits. */
  byKind: Record<string, number>;
  /** Form submissions the site reported itself (no client signals stored). */
  siteReportedSubmissions: number;
  /** Synthetic probe rows excluded from every count. */
  syntheticExcluded: number;
}

const zero = (): ClassCounts => ({ browser_session: 0, signed_principal: 0, unaccountable: 0, wouldHold: 0 });

function under(path: string, p: string): boolean {
  return path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/** The named action route a path is on, or null (method is not consulted:
 *  history never stored it). */
function routeKind(site: string, path: string, rules: StateChangeRules): string | null {
  const lower = path.toLowerCase();
  for (const r of [...(rules.siteRoutes?.[site] ?? []), ...rules.routes]) {
    if (under(lower, r.pattern.toLowerCase())) return r.kind;
  }
  return null;
}

export function replayAccountability(rows: readonly ReplayRow[], rules: StateChangeRules = DEFAULT_STATE_CHANGE_RULES): AccountabilityReplay {
  const out: AccountabilityReplay = {
    rows: rows.length,
    recorded: zero(),
    actionRouteHits: { ...zero(), total: 0 },
    byKind: {},
    siteReportedSubmissions: 0,
    syntheticExcluded: 0,
  };
  for (const r of rows) {
    if (r.synthetic) {
      out.syntheticExcluded++;
      continue;
    }
    if (r.type === "site.contact_submitted") {
      out.siteReportedSubmissions++;
      continue;
    }
    if (r.accountability && (ACCOUNTABILITY_CLASSES as readonly string[]).includes(r.accountability)) {
      out.recorded[r.accountability as AccountabilityClass]++;
      if (r.wouldHold) out.recorded.wouldHold++;
      continue;
    }
    if (r.type === "site.page_viewed") continue; // a GET navigation, a read
    const kind = routeKind(r.site, r.path, rules);
    if (!kind) continue;
    const ct = r.clientType ?? "unknown";
    const v = accountabilityVerdict({
      clientType: ct,
      headerMismatch: false,
      hosting: r.hosting ?? "unknown",
      authenticated: r.authenticated,
      // Header names are not stored: assume Fetch Metadata for a stored browser.
      headerNames: ct === "browser" ? ["sec-fetch-mode"] : [],
      identifiedAgent: r.identifiedAgent,
      principal:
        r.principalStatus === "verified"
          ? { status: "verified", withinMandate: r.principalScopes.some((s) => scopeMatches(s, r.path)) }
          : r.principalStatus === "claimed"
            ? { status: "claimed" }
            : undefined,
    });
    out.actionRouteHits.total++;
    out.actionRouteHits[v.class]++;
    if (v.wouldHold) out.actionRouteHits.wouldHold++;
    out.byKind[kind] = (out.byKind[kind] ?? 0) + 1;
  }
  return out;
}
