/**
 * Page integrity, the Instinct side: the browser-side tamper reports a protected
 * site forwards (src/lib/forcefield-web/integrity.ts), stored per scope and read
 * back as "which origins do this site's pages load that the site never named".
 *
 * Precision: one person's browser extension produces reports from ONE session;
 * an injected skimmer or a hijacked script produces them from every visitor. So:
 *   - the first 7 days of a site's reports are its baseline (learning), and
 *     nothing it loads in that time is called new;
 *   - after that an origin is "new", and it would raise an alert only when it
 *     shows up for at least 5 distinct sessions on at least 2 pages in 24 hours.
 * Alerts are not sent yet: the rule is measured on our own sites first, and the
 * panel shows "would alert" so the measurement is visible.
 *
 * Stored per (scope, directive, origin, session, page, day) with a counter, so
 * a busy page adds repeats, not rows. Origins only: never a full URL, a query or
 * anything about the visitor. Pure folding + an injectable query; never throws.
 */
import { query, safeQuery } from "@/lib/db";
import { INTEGRITY_DIRECTIVES, type IntegrityDirective, type IntegrityReport } from "@/lib/forcefield-web/integrity";

export const LEARNING_DAYS = 7;
export const ALERT_MIN_SESSIONS = 5;
export const ALERT_MIN_PAGES = 2;

export type IntegrityQuery = (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const appWrite: IntegrityQuery = (t, p) => query(t, p) as never;
const appRead: IntegrityQuery = (t, p) => safeQuery(t, p) as never;

const SCOPE_RE = /^(tenant:[0-9a-f-]{36}|site:[a-z0-9._-]{1,64})$/;
const ORIGIN_RE = /^((https?|wss?):\/\/[a-z0-9.-]{1,253}(:\d{1,5})?|data|blob)$/;
const SIG_RE = /^[a-z0-9_-]{1,32}$/i;

/** The forwarded reports that are well formed (pure): server-side validation of
 *  what a site sent, so a hand-built request can store nothing else. */
export function validReports(reports: unknown): IntegrityReport[] {
  if (!Array.isArray(reports)) return [];
  const out: IntegrityReport[] = [];
  for (const r of reports.slice(0, 20)) {
    const o = r as Partial<IntegrityReport> | null;
    if (!o || typeof o !== "object") continue;
    if (!(INTEGRITY_DIRECTIVES as readonly string[]).includes(String(o.directive))) continue;
    const origin = String(o.blockedOrigin ?? "").toLowerCase();
    if (!ORIGIN_RE.test(origin)) continue;
    const page = typeof o.page === "string" && o.page.startsWith("/") ? o.page.slice(0, 200) : "/";
    out.push({ directive: o.directive as IntegrityDirective, blockedOrigin: origin, page });
  }
  return out;
}

/** Store a batch for a scope. Returns how many were stored; 0 on any error. */
export async function recordIntegrityReports(scope: string, sig: unknown, reports: unknown, q: IntegrityQuery = appWrite): Promise<number> {
  const valid = validReports(reports);
  const s = typeof sig === "string" && SIG_RE.test(sig) ? sig : "-";
  if (!SCOPE_RE.test(scope) || valid.length === 0) return 0;
  try {
    for (const r of valid) {
      await q(
        `INSERT INTO forcefield_page_integrity (scope, directive, blocked_origin, sig, page, day)
         VALUES ($1, $2, $3, $4, $5, (now() AT TIME ZONE 'UTC')::date)
         ON CONFLICT (scope, directive, blocked_origin, sig, page, day)
         DO UPDATE SET reports = forcefield_page_integrity.reports + 1, last_seen = now()`,
        [scope, r.directive, r.blockedOrigin, s, r.page],
      );
    }
    return valid.length;
  } catch {
    return 0;
  }
}

export interface IntegrityRow {
  directive: string;
  blocked_origin: string;
  first_seen: string;
  last_seen: string;
  reports: number | string;
  sessions: number | string;
  pages: number | string;
  sessions_24h: number | string;
  pages_24h: number | string;
  top_page: string | null;
}

export type OriginStatus = "baseline" | "new";

export interface IntegrityOrigin {
  directive: IntegrityDirective;
  origin: string;
  status: OriginStatus;
  /** A new origin that meets the alert rule in the last 24 hours. */
  wouldAlert: boolean;
  firstSeen: string;
  lastSeen: string;
  reports: number;
  sessions: number;
  pages: number;
  sessions24h: number;
  pages24h: number;
  topPage: string | null;
}

export interface PageIntegrity {
  /** null until the site has sent its first report. */
  learning: { startedAt: string; endsAt: string; active: boolean } | null;
  origins: IntegrityOrigin[];
  totals: { origins: number; newOrigins: number; wouldAlert: number };
}

const num = (v: unknown) => Math.max(0, Number(v) || 0);

/** Fold the per-origin rows into the report (pure; exported for tests). */
export function foldIntegrity(rows: IntegrityRow[], nowMs: number): PageIntegrity {
  if (rows.length === 0) return { learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } };
  const start = Math.min(...rows.map((r) => Date.parse(r.first_seen)).filter(Number.isFinite));
  const end = start + LEARNING_DAYS * 86400_000;
  const origins: IntegrityOrigin[] = rows
    .filter((r) => (INTEGRITY_DIRECTIVES as readonly string[]).includes(r.directive))
    .map((r) => {
      const status: OriginStatus = Date.parse(r.first_seen) >= end ? "new" : "baseline";
      const sessions24h = num(r.sessions_24h);
      const pages24h = num(r.pages_24h);
      return {
        directive: r.directive as IntegrityDirective,
        origin: r.blocked_origin,
        status,
        wouldAlert: status === "new" && sessions24h >= ALERT_MIN_SESSIONS && pages24h >= ALERT_MIN_PAGES,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        reports: num(r.reports),
        sessions: num(r.sessions),
        pages: num(r.pages),
        sessions24h,
        pages24h,
        topPage: r.top_page,
      };
    })
    .sort((a, b) => Number(b.wouldAlert) - Number(a.wouldAlert) || Number(b.status === "new") - Number(a.status === "new") || b.sessions - a.sessions || a.origin.localeCompare(b.origin));
  return {
    learning: { startedAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), active: nowMs < end },
    origins,
    totals: { origins: origins.length, newOrigins: origins.filter((o) => o.status === "new").length, wouldAlert: origins.filter((o) => o.wouldAlert).length },
  };
}

const READ_SQL = `
SELECT directive, blocked_origin,
       min(first_seen)::text AS first_seen,
       max(last_seen)::text AS last_seen,
       sum(reports)::int AS reports,
       count(DISTINCT sig)::int AS sessions,
       count(DISTINCT page)::int AS pages,
       count(DISTINCT sig) FILTER (WHERE last_seen >= now() - interval '24 hours')::int AS sessions_24h,
       count(DISTINCT page) FILTER (WHERE last_seen >= now() - interval '24 hours')::int AS pages_24h,
       mode() WITHIN GROUP (ORDER BY page) AS top_page
  FROM forcefield_page_integrity
 WHERE scope = $1
 GROUP BY 1, 2
 ORDER BY 6 DESC
 LIMIT 200`;

/** One scope's page integrity. Never throws (an unreadable store reads empty). */
export async function getPageIntegrity(scope: string, opts: { q?: IntegrityQuery; nowMs?: number } = {}): Promise<PageIntegrity> {
  const now = opts.nowMs ?? Date.now();
  if (!SCOPE_RE.test(scope)) return foldIntegrity([], now);
  try {
    const { rows } = await (opts.q ?? appRead)(READ_SQL, [scope]);
    return foldIntegrity(rows as unknown as IntegrityRow[], now);
  } catch {
    return foldIntegrity([], now);
  }
}
