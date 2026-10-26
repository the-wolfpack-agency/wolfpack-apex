/**
 * Forcefield hostile INCIDENTS: grouping, severity routing and the daily digest
 * period. Pure and deterministic (no DB, no clock, no mail); alerts.ts wires it.
 *
 * Input: hostile events collapsed by SQL into groups of identical facts (same
 * kind, site, attack class, 6-hour window, fingerprint, signature, path,
 * source and outcome) with an exact count and first/last time. Nothing is
 * capped at this stage, so every count derived here is exact.
 *
 * Grouping (one incident per source burst, never per attack class): inside one
 * site and one 6-hour window, two groups are the same incident when they share
 * a fingerprint, share a session signature, or are part of one continuous burst
 * (each group starts within BURST_GAP_SECONDS of the previous activity). A
 * scanner that rotates its headers changes fingerprint and signature on every
 * request, so the burst rule is what keeps a 16-second scan one incident.
 *
 * Routing:
 *   - immediate: the incident needs attention now. A decoy or honeytoken trip
 *     (proven hostile reached hidden content), or ANY request that was recorded
 *     but not stopped (watch / report-only posture). A mixed burst with one
 *     unblocked request is immediate, and the email lists every class in it.
 *   - digest: every request was blocked or contained. Reported once, in the
 *     daily digest that covers the incident's window.
 *
 * Digest period: windows are aligned to 00/06/12/18 UTC. The digest for US
 * Eastern date D covers windows starting in [cutoff(D-1), cutoff(D)), where
 * cutoff(D) is the window boundary at or before 08:00 ET on D. Consecutive
 * periods therefore partition time exactly, so every window (and every incident
 * in it) belongs to exactly one digest, and a digest only covers windows that
 * have ended.
 */
import type { IncidentDetail } from "@/lib/forcefield-web/alert-email";

export const INCIDENT_WINDOW_HOURS = 6;
/** Two groups whose activity is at most this far apart are one burst. */
export const BURST_GAP_SECONDS = 120;
/** Most distinct values of one attribute an incident or digest row lists. */
export const LIST_CAP = 5;
/** The daily digest goes out on the first scan at or after this US Eastern hour. */
export const DIGEST_HOUR_ET = 8;
/** A digest never reaches further back than this, however long delivery failed. */
export const DIGEST_MAX_LOOKBACK_DAYS = 7;

export type EventOutcome = "blocked" | "contained" | "recorded";

/** One collapsed group of identical hostile events (see the file header). */
export interface HostileEventGroup {
  kind: "honeytoken_trip" | "payload_attack";
  site: string;
  /** The payload class (sql_injection, xss, ...) or "honeytoken_trip". */
  attackClass: string;
  windowStart: string;
  fp: string;
  sig: string;
  path: string;
  country: string;
  hosting: string;
  clientType: string;
  agent: string;
  network: string;
  outcome: EventOutcome;
  posture: string;
  reasonKind: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export type AttentionReason = "decoy" | "unblocked";

/** One attack class inside an incident or a digest site section. */
export interface ClassLine {
  kind: "honeytoken_trip" | "payload_attack";
  attackClass: string;
  count: number;
  outcomes: { blocked: number; contained: number; recorded: number };
  firstAt: string;
  lastAt: string;
  /** Top paths by request count (capped) and the exact distinct count. */
  paths: string[];
  pathCount: number;
  /** Distinct recorded fingerprints (0 = none recorded). */
  sources: number;
  signatureCount: number;
}

export interface HostileIncident {
  /** Stable anchor: the earliest group of the burst. Feeds the dedupe key. */
  anchor: string;
  site: string;
  windowStart: string;
  /** honeytoken_trip when the burst includes a trap trip, else payload_attack. */
  kind: "honeytoken_trip" | "payload_attack";
  route: "immediate" | "digest";
  attention: AttentionReason[];
  /** Every class in the burst, most requests first. */
  classes: ClassLine[];
  /** The burst's facts across all classes. */
  detail: IncidentDetail;
  /** The member groups (exact, uncapped), for digest aggregation. */
  groups: HostileEventGroup[];
}

/* ------------------------------- aggregation ------------------------------ */

const ms = (iso: string) => new Date(iso).getTime();
const minIso = (a: string, b: string) => (ms(a) <= ms(b) ? a : b);
const maxIso = (a: string, b: string) => (ms(a) >= ms(b) ? a : b);

/** Distinct non-empty values, most requests first, ties by value. */
function ranked(groups: readonly HostileEventGroup[], pick: (g: HostileEventGroup) => string): string[] {
  const n = new Map<string, number>();
  for (const g of groups) {
    const v = pick(g);
    if (v) n.set(v, (n.get(v) ?? 0) + g.count);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([v]) => v);
}

function outcomesOf(groups: readonly HostileEventGroup[]) {
  const o = { blocked: 0, contained: 0, recorded: 0 };
  for (const g of groups) o[g.outcome] += g.count;
  return o;
}

/** The facts of a set of groups, exact (lists capped, counts not). */
export function aggregateGroups(groups: readonly HostileEventGroup[], windowStart: string): IncidentDetail {
  const paths = ranked(groups, (g) => g.path);
  const fps = ranked(groups, (g) => g.fp);
  const sigs = ranked(groups, (g) => g.sig);
  let firstAt = groups[0]?.firstAt ?? windowStart;
  let lastAt = groups[0]?.lastAt ?? windowStart;
  let count = 0;
  for (const g of groups) {
    firstAt = minIso(firstAt, g.firstAt);
    lastAt = maxIso(lastAt, g.lastAt);
    count += g.count;
  }
  return {
    firstAt,
    lastAt,
    count,
    windowStart,
    windowHours: INCIDENT_WINDOW_HOURS,
    paths: paths.slice(0, LIST_CAP),
    pathCount: paths.length,
    countries: ranked(groups, (g) => g.country).slice(0, LIST_CAP),
    hosting: ranked(groups, (g) => g.hosting).slice(0, LIST_CAP),
    clientTypes: ranked(groups, (g) => g.clientType).slice(0, LIST_CAP),
    agents: ranked(groups, (g) => g.agent).slice(0, LIST_CAP),
    networks: ranked(groups, (g) => g.network).slice(0, LIST_CAP),
    fingerprints: fps.slice(0, LIST_CAP),
    fingerprintCount: fps.length,
    signatures: sigs.slice(0, LIST_CAP),
    signatureCount: sigs.length,
    outcomes: outcomesOf(groups),
    postures: ranked(groups, (g) => g.posture).slice(0, LIST_CAP),
    reasonKinds: ranked(groups, (g) => g.reasonKind).slice(0, LIST_CAP),
  };
}

/** One line per attack class, most requests first. */
export function classLines(groups: readonly HostileEventGroup[]): ClassLine[] {
  const by = new Map<string, HostileEventGroup[]>();
  for (const g of groups) {
    const k = `${g.kind}|${g.attackClass}`;
    const list = by.get(k);
    if (list) list.push(g);
    else by.set(k, [g]);
  }
  const lines: ClassLine[] = [];
  for (const list of by.values()) {
    const d = aggregateGroups(list, list[0].windowStart);
    lines.push({
      kind: list[0].kind,
      attackClass: list[0].attackClass,
      count: d.count,
      outcomes: d.outcomes,
      firstAt: d.firstAt,
      lastAt: d.lastAt,
      paths: d.paths,
      pathCount: d.pathCount,
      sources: d.fingerprintCount,
      signatureCount: d.signatureCount,
    });
  }
  return lines.sort((a, b) => b.count - a.count || (a.attackClass < b.attackClass ? -1 : 1));
}

/* -------------------------------- grouping -------------------------------- */

function groupOrder(a: HostileEventGroup, b: HostileEventGroup): number {
  const t = ms(a.firstAt) - ms(b.firstAt);
  if (t !== 0) return t;
  const ka = `${a.fp}|${a.sig}|${a.path}|${a.attackClass}|${a.outcome}`;
  const kb = `${b.fp}|${b.sig}|${b.path}|${b.attackClass}|${b.outcome}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Why an incident needs attention now (empty = digest only). */
export function attentionReasons(groups: readonly HostileEventGroup[]): AttentionReason[] {
  const out: AttentionReason[] = [];
  if (groups.some((g) => g.kind === "honeytoken_trip")) out.push("decoy");
  if (groups.some((g) => g.outcome === "recorded" && g.count > 0)) out.push("unblocked");
  return out;
}

/** Group events into incidents (see the file header). Deterministic order:
 *  by window, then site, then first event time. */
export function buildIncidents(input: readonly HostileEventGroup[], burstGapSeconds = BURST_GAP_SECONDS): HostileIncident[] {
  const parts = new Map<string, HostileEventGroup[]>();
  for (const g of input) {
    if (!(g.count > 0)) continue;
    const k = `${g.windowStart}|${g.site}`;
    const list = parts.get(k);
    if (list) list.push(g);
    else parts.set(k, [g]);
  }
  const out: HostileIncident[] = [];
  for (const groups of parts.values()) {
    groups.sort(groupOrder);
    const parent = groups.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const byFp = new Map<string, number>();
    const bySig = new Map<string, number>();
    let prev = -1;
    let reach = Number.NEGATIVE_INFINITY;
    groups.forEach((g, i) => {
      if (g.fp) {
        const j = byFp.get(g.fp);
        if (j === undefined) byFp.set(g.fp, i);
        else union(i, j);
      }
      if (g.sig) {
        const j = bySig.get(g.sig);
        if (j === undefined) bySig.set(g.sig, i);
        else union(i, j);
      }
      if (prev >= 0 && ms(g.firstAt) <= reach + burstGapSeconds * 1000) union(i, prev);
      reach = Math.max(reach, ms(g.lastAt));
      prev = i;
    });
    const comps = new Map<number, HostileEventGroup[]>();
    groups.forEach((g, i) => {
      const r = find(i);
      const list = comps.get(r);
      if (list) list.push(g);
      else comps.set(r, [g]);
    });
    for (const members of comps.values()) {
      const first = members[0];
      const attention = attentionReasons(members);
      out.push({
        anchor: `${first.firstAt}|${first.fp || first.sig || first.path}`,
        site: first.site,
        windowStart: first.windowStart,
        kind: members.some((g) => g.kind === "honeytoken_trip") ? "honeytoken_trip" : "payload_attack",
        route: attention.length > 0 ? "immediate" : "digest",
        attention,
        classes: classLines(members),
        detail: aggregateGroups(members, first.windowStart),
        groups: members,
      });
    }
  }
  return out.sort((a, b) => ms(a.windowStart) - ms(b.windowStart) || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0) || ms(a.detail.firstAt) - ms(b.detail.firstAt));
}

/* ----------------------------- digest period ------------------------------ */

const ET = "America/New_York";
let etFmt: Intl.DateTimeFormat | null = null;

/** US Eastern calendar date (YYYY-MM-DD) and hour (0..23) of an instant. */
export function easternParts(at: Date): { date: string; hour: number } {
  etFmt ??= new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(etFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function windowFloor(t: number): number {
  const w = INCIDENT_WINDOW_HOURS * 3600_000;
  return Math.floor(t / w) * w;
}

/** The instant of DIGEST_HOUR_ET on an Eastern date, floored to a window boundary. */
export function digestCutoff(etDate: string): Date {
  const [y, m, d] = etDate.split("-").map(Number);
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, DIGEST_HOUR_ET + offset);
    const p = easternParts(new Date(t));
    if (p.date === etDate && p.hour === DIGEST_HOUR_ET) return new Date(windowFloor(t));
  }
  return new Date(windowFloor(Date.UTC(y, m - 1, d, DIGEST_HOUR_ET + 5)));
}

/** The Eastern date before `etDate`. */
export function previousEasternDate(etDate: string): string {
  const [y, m, d] = etDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Where the next digest's coverage resumes, from the digest rows already in the
 * store: the end of the latest HANDLED digest (delivered, or empty), else the
 * start of the earliest digest that was claimed but never handled (its period
 * began at the previous date's cutoff). Null when there is no history.
 */
export function digestResumeFrom(handledEnd: Date | null, firstUnhandledEnd: Date | null): Date | null {
  if (handledEnd) return handledEnd;
  if (firstUnhandledEnd) return digestCutoff(previousEasternDate(easternParts(firstUnhandledEnd).date));
  return null;
}

/** The digest due at `now`, or null before the digest hour. The period covers
 *  windows starting in [start, end): normally the previous digest's cutoff to
 *  today's; after a failed or missed digest it starts at the last digest that
 *  was handled (capped at DIGEST_MAX_LOOKBACK_DAYS), so nothing is skipped. */
export function digestPeriod(now: Date, lastHandledEnd: Date | null): { etDate: string; start: Date; end: Date } | null {
  const { date, hour } = easternParts(now);
  if (hour < DIGEST_HOUR_ET) return null;
  const end = digestCutoff(date);
  const normal = digestCutoff(previousEasternDate(date));
  const floor = end.getTime() - DIGEST_MAX_LOOKBACK_DAYS * 86400_000;
  let start = lastHandledEnd && lastHandledEnd.getTime() < normal.getTime() ? lastHandledEnd : normal;
  if (start.getTime() < floor) start = new Date(floor);
  return { etDate: date, start, end };
}

/* --------------------------------- digest --------------------------------- */

export interface DigestSite {
  site: string;
  incidents: number;
  attempts: number;
  /** Distinct recorded fingerprints across the site's incidents. */
  sources: number;
  firstAt: string;
  lastAt: string;
  outcomes: { blocked: number; contained: number; recorded: number };
  rows: ClassLine[];
}

export interface DigestData {
  etDate: string;
  periodStart: string;
  periodEnd: string;
  sites: DigestSite[];
  totals: { incidents: number; attempts: number; sites: number; sources: number };
  /** Incidents in the same period that were emailed immediately instead. */
  immediateIncidents: number;
  /** Every digest incident's anchor + site + window (for the exactly-once test). */
  incidentKeys: string[];
}

export const incidentIdentity = (i: Pick<HostileIncident, "site" | "windowStart" | "anchor">) => `${i.site}|${i.windowStart}|${i.anchor}`;

/** The digest over incidents whose window starts in [start, end). */
export function buildDigest(incidents: readonly HostileIncident[], period: { etDate: string; start: Date; end: Date }): DigestData {
  const inPeriod = incidents.filter((i) => ms(i.windowStart) >= period.start.getTime() && ms(i.windowStart) < period.end.getTime());
  const digest = inPeriod.filter((i) => i.route === "digest");
  const bySite = new Map<string, HostileIncident[]>();
  for (const i of digest) {
    const list = bySite.get(i.site);
    if (list) list.push(i);
    else bySite.set(i.site, [i]);
  }
  const sites: DigestSite[] = [];
  for (const [site, list] of bySite) {
    const groups = list.flatMap((i) => i.groups);
    const d = aggregateGroups(groups, list[0].windowStart);
    sites.push({ site, incidents: list.length, attempts: d.count, sources: d.fingerprintCount, firstAt: d.firstAt, lastAt: d.lastAt, outcomes: d.outcomes, rows: classLines(groups) });
  }
  sites.sort((a, b) => b.attempts - a.attempts || (a.site < b.site ? -1 : 1));
  const allFps = new Set(digest.flatMap((i) => i.groups.map((g) => g.fp)).filter(Boolean));
  return {
    etDate: period.etDate,
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    sites,
    totals: { incidents: digest.length, attempts: sites.reduce((n, s) => n + s.attempts, 0), sites: sites.length, sources: allFps.size },
    immediateIncidents: inPeriod.length - digest.length,
    incidentKeys: digest.map(incidentIdentity),
  };
}
