/**
 * What we are connected to, against what we could be.
 *
 * WHY THIS EXISTS. On 2026-09-02 the question "are we connected to all the
 * docs?" could not be answered by the product at all. It turned out we held
 * three sources pointing at two SharePoint sites, each at a folder several
 * levels down, while the tenant had nine sites. Two of the three sources were
 * duplicates that had never synced and one was named TEST. Nobody had done
 * anything wrong on any particular day: a source is added by pasting a folder
 * URL, and nothing ever compared the pile of pastes against what exists.
 *
 * That is a coverage question and it has two halves, which fail differently
 * and must be reported separately:
 *
 *   REACH   - sites and libraries we hold no source for at all. Content we
 *             could not answer from if asked, and the client would have no
 *             reason to suspect it, because a confident answer from a partial
 *             library reads exactly like a confident answer from a whole one.
 *
 *   DEPTH   - files inside a source we DO hold, that never became a readable
 *             document. A source that syncs and indexes a third of its folder
 *             reports success on every run.
 *
 * NEITHER IS AN ERROR ON ITS OWN. A Center may deliberately connect one folder.
 * The failure is not knowing, so this reports and never repairs: it is a
 * measurement, and something that quietly connected what it found would be a
 * far worse thing to run against a client's tenant.
 */

/**
 * Anything that runs a SQL string and hands back rows.
 *
 * Narrower than pg's Client on purpose. This module needs one shape, and
 * depending on pg's overloaded signature meant a test double could not satisfy
 * the type without pretending to be a whole client.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** A source as configured, with what we can tell about how it is doing. */
export interface SourceCoverage {
  id: string;
  name: string;
  siteUrl: string;
  folderPath: string | null;
  isActive: boolean;
  lastSyncedAt: string | null;
  /** Documents whose web_url sits under this source's site. */
  documentsIndexed: number;
  /** Of those, how many actually answer a question rather than being a filename. */
  documentsReadable: number;
}

export interface CoverageReport {
  sources: SourceCoverage[];
  /** Distinct SharePoint sites we hold at least one source for. */
  sitesConnected: string[];
  /** Sources that will never contribute: inactive, or never synced. */
  dormant: SourceCoverage[];
  /** Active sources whose last sync is older than the staleness window. */
  stale: SourceCoverage[];
  /** Sites seen in indexed content that no source points at. */
  sitesIndexedWithoutSource: string[];
}

/** A sync older than this is not a schedule, it is a stop. */
export const STALE_AFTER_DAYS = 3;

/** The site part of a SharePoint URL, or null when it is not one. */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^(https:\/\/[^/]+\/sites\/[^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Read coverage from the database alone.
 *
 * DELIBERATELY NO GRAPH CALL. Reach is answered here only for sites we can
 * already see evidence of; enumerating the tenant needs a scope this app does
 * not request, and pretending otherwise would make this report look complete
 * when it is not. What it CAN do without any new permission is compare the
 * sources against each other and against the library, which is where every
 * problem found so far actually was.
 */
export async function readCoverage(
  client: Queryable,
  workspaceId: string,
  now = new Date(),
): Promise<CoverageReport> {
  const { rows: sourceRows } = await client.query<{
    id: string;
    name: string;
    site_url: string;
    folder_path: string | null;
    is_active: boolean;
    last_synced_at: Date | null;
  }>(
    /* WORKSPACE-SCOPED. The repo-wide tenant guardrail caught this unscoped and
       was right to: on a multi-tenant deployment an unfiltered read would show
       one client the shape of another's document estate, which is worse than
       the gap this report exists to find.

       BOUND, not interpolated. The first version built the literal with a
       hand-rolled quoting helper because Queryable took SQL only, and CodeQL
       flagged it high severity on the pull request. It was right to: an escape
       function written once is a thing every future reader has to re-verify,
       and "the value is internal" is exactly the assumption that stops being
       true later. Widening the interface by one optional argument costs
       nothing and removes the question. */
    `SELECT id::text AS id, name, site_url, folder_path, is_active, last_synced_at
       FROM instinct_sharepoint_sources
      WHERE workspace_id = $1
      ORDER BY is_active DESC, name`,
    [workspaceId],
  );

  /* Documents are attributed by the site in their web_url, because a document
     carries no source id. That is coarse on purpose: two sources on one site
     cannot be told apart, and saying so is better than inventing a split. */
  const { rows: docRows } = await client.query<{ site: string; total: string; readable: string }>(
    `SELECT lower(substring(d.web_url from '^(https://[^/]+/sites/[^/?#]+)')) AS site,
            count(*)::text AS total,
            count(*) FILTER (WHERE c.n > 0)::text AS readable
       FROM brain_documents d
       LEFT JOIN (SELECT document_id, count(*)::int n FROM brain_chunks GROUP BY 1) c
              ON c.document_id = d.id
      WHERE d.web_url IS NOT NULL
      GROUP BY 1`,
  );
  const bySite = new Map(docRows.filter((r) => r.site).map((r) => [r.site, r]));

  const sources: SourceCoverage[] = sourceRows.map((r) => {
    const site = siteOf(r.site_url);
    const docs = site ? bySite.get(site) : undefined;
    return {
      id: r.id,
      name: r.name,
      siteUrl: r.site_url,
      folderPath: r.folder_path,
      isActive: r.is_active,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
      documentsIndexed: Number(docs?.total ?? 0),
      documentsReadable: Number(docs?.readable ?? 0),
    };
  });

  const connected = new Set(sources.map((s) => siteOf(s.siteUrl)).filter((s): s is string => !!s));

  /* A source that is switched off, or has never once run, contributes nothing
     and looks like configuration. Three of the six found on 2026-09-02 were
     exactly this, two of them duplicates of a source that already existed. */
  const dormant = sources.filter((s) => !s.isActive || s.lastSyncedAt === null);

  const cutoff = now.getTime() - STALE_AFTER_DAYS * 86_400_000;
  const stale = sources.filter(
    (s) => s.isActive && s.lastSyncedAt !== null && new Date(s.lastSyncedAt).getTime() < cutoff,
  );

  /* Content we have indexed from a site nobody configured. Usually means a
     source was deleted while its documents stayed, so the library still
     answers from a place we no longer refresh: the answers quietly age. */
  const sitesIndexedWithoutSource = [...bySite.keys()].filter((s) => !connected.has(s)).sort();

  return {
    sources,
    sitesConnected: [...connected].sort(),
    dormant,
    stale,
    sitesIndexedWithoutSource,
  };
}

/**
 * The report as lines a person reads, and whether anything needs attention.
 *
 * Returns `ok: false` only for things that are unambiguously wrong: a source
 * that cannot contribute, or one that has stopped syncing. A narrow connection
 * is a decision somebody may have made on purpose, so it is stated and never
 * failed on.
 */
export function describeCoverage(report: CoverageReport): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  lines.push(
    `${report.sources.length} source(s) across ${report.sitesConnected.length} SharePoint site(s)`,
  );
  for (const s of report.sources) {
    const where = s.folderPath ? `${s.folderPath}` : "(library root)";
    lines.push(
      `  ${s.isActive ? "active  " : "inactive"} ${s.name}  ${where}  ` +
        `synced ${s.lastSyncedAt ?? "never"}  ${s.documentsReadable}/${s.documentsIndexed} readable`,
    );
  }
  for (const s of report.dormant) {
    lines.push(`  DORMANT  ${s.name}: ${s.isActive ? "never synced" : "switched off"}, contributes nothing`);
  }
  for (const s of report.stale) {
    lines.push(`  STALE    ${s.name}: last synced ${s.lastSyncedAt}, older than ${STALE_AFTER_DAYS} days`);
  }
  for (const site of report.sitesIndexedWithoutSource) {
    lines.push(`  ORPHANED ${site}: indexed content, no source refreshing it`);
  }
  return { ok: report.dormant.length === 0 && report.stale.length === 0, lines };
}
