/**
 * What a connected account can actually reach, versus what we have connected.
 *
 * WHY THIS IS SEARCH AND NOT A SITE LISTING.
 *
 * Graph's obvious answer, `GET /sites?search=`, needs `Sites.Read.All`. That
 * scope requires tenant admin consent and was deliberately removed from this
 * app's OAuth request on 2026-05-20, because demanding it blocked every
 * non-admin teammate from connecting Microsoft at all. Asking for it back would
 * make the product something only an administrator can set up, which is the
 * opposite of what a client deployment needs.
 *
 * `/search/query` restricted to driveItem needs only `Files.ReadWrite.All`,
 * which every connected account already holds. It is delegated, so it returns
 * exactly what that person can open and nothing else. Running it for each
 * connected account and taking the union gives the honest answer to "what can
 * we reach", built from real permissions rather than from an administrator's
 * view of the tenant.
 *
 * WHAT IT COSTS TO BE WRONG HERE. On 2026-09-02 we held sources for two sites
 * out of nine, each pointing at a folder several levels down, and one whole
 * site contributed ten documents. If a client hands over access to twenty
 * libraries and we index one folder of one of them, every answer we give is
 * confident and drawn from a fraction of what they gave us. They have no way to
 * tell: a confident answer from a partial library reads exactly like a
 * confident answer from a complete one.
 *
 * IT NEVER CONNECTS ANYTHING. It reports a gap for a person to act on.
 * Something that silently attached itself to whatever it could see in a
 * client's tenant would be a far worse thing to deploy than the gap it closes.
 */

import { siteOf } from "./coverage";

/** One site an account can reach, and how much of it we have seen. */
export interface ReachableSite {
  /** Canonical site URL, lowercased. */
  site: string;
  /** Distinct files seen there during discovery. A floor, never a total. */
  filesSeen: number;
  /** Accounts that could reach it, by email. */
  reachableBy: string[];
}

export interface DiscoveryReport {
  /** Sites at least one connected account can reach. */
  reachable: ReachableSite[];
  /** Of those, the ones no source points at: the gap. */
  unconnected: ReachableSite[];
  /** Accounts whose search failed, so their reach is unknown rather than empty. */
  couldNotAsk: Array<{ email: string; reason: string }>;
}

/** A hit reduced to the only field discovery needs. */
export interface DiscoverableHit {
  url: string;
}

/** How each account is asked. Injected so the caller owns Graph and auth. */
export type SearchAs = (
  account: { email: string },
) => Promise<{ ok: true; hits: DiscoverableHit[] } | { ok: false; reason: string }>;

/**
 * Fold per-account search results into the reachable set.
 *
 * PURE, so the interesting rules are testable without Graph: which URLs count
 * as a site, how accounts combine, and what "unconnected" means. The Graph call
 * itself is one fetch and is the least likely part to be wrong.
 */
export async function discoverReach(
  accounts: Array<{ email: string }>,
  searchAs: SearchAs,
  connectedSiteUrls: string[],
): Promise<DiscoveryReport> {
  const bySite = new Map<string, { files: Set<string>; by: Set<string> }>();
  const couldNotAsk: Array<{ email: string; reason: string }> = [];

  for (const account of accounts) {
    const res = await searchAs(account);
    if (!res.ok) {
      /* AN ACCOUNT WE COULD NOT ASK IS NOT AN ACCOUNT THAT REACHES NOTHING.
         Collapsing the two would shrink the reported gap every time a token
         expired, which is precisely when the report matters most: it would
         say "you are connected to everything" on the day the connection
         broke. */
      couldNotAsk.push({ email: account.email, reason: res.reason });
      continue;
    }
    for (const hit of res.hits) {
      const site = siteOf(hit.url);
      if (!site) continue;
      const entry = bySite.get(site) ?? { files: new Set<string>(), by: new Set<string>() };
      entry.files.add(hit.url);
      entry.by.add(account.email);
      bySite.set(site, entry);
    }
  }

  const reachable: ReachableSite[] = [...bySite.entries()]
    .map(([site, v]) => ({
      site,
      filesSeen: v.files.size,
      reachableBy: [...v.by].sort(),
    }))
    .sort((a, b) => b.filesSeen - a.filesSeen);

  const connected = new Set(
    connectedSiteUrls.map((u) => siteOf(u)).filter((s): s is string => s !== null),
  );

  return {
    reachable,
    unconnected: reachable.filter((r) => !connected.has(r.site)),
    couldNotAsk,
  };
}

/**
 * The report as lines a person reads.
 *
 * Never returns "not ok". A site we can reach and have not connected is
 * information, not a fault: somebody may have decided to leave it out. The one
 * thing worth shouting about is an account we could not ask, because that makes
 * the gap look smaller than it is.
 */
export function describeDiscovery(report: DiscoveryReport): string[] {
  const lines: string[] = [];
  lines.push(
    `${report.reachable.length} site(s) reachable, ${report.unconnected.length} with no source`,
  );
  for (const r of report.unconnected) {
    lines.push(`  NOT CONNECTED  ${r.site}  (${r.filesSeen}+ files, via ${r.reachableBy.join(", ")})`);
  }
  for (const f of report.couldNotAsk) {
    lines.push(
      `  COULD NOT ASK  ${f.email}: ${f.reason}. The gap above may be larger than it looks.`,
    );
  }
  /* SAID EVERY TIME, not only when something is found. Search returns what the
     index holds for that account, so a site with no recently touched files can
     be reachable and absent from this list. The number is a floor. */
  lines.push(
    "  These are sites seen in search results, so this is a floor rather than a full inventory.",
  );
  return lines;
}
