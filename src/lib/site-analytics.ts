/**
 * Site analytics: usage telemetry from the OGIAM marketing site, stored in our
 * OWN platform (site_analytics_events, migration 178) and aggregated for the
 * admin Site Analytics page. No third-party analytics product; the data feeds
 * the same Postgres source of truth as everything else.
 *
 * Privacy: anonymous. Only the event type, page path, coarse country (2-letter),
 * and referrer host are kept. No IP, no user id, no cookies.
 */

import { query, safeQuery } from "@/lib/db";
import { buildJourneys, type AgentJourney, type CorrelationKind } from "@/lib/agent-behavior";
import { buildAgentProfile, type AgentProfile } from "@/lib/agent-profile";
import { getNetworkReputation, getNetworkTradecraft, type NetworkReputation, type NetworkTradecraftActor } from "@/lib/forcefield/operator-reputation";
import { summarizeProbeIntel, type ProbeIntelEntry } from "@/lib/agent-probe-signatures";
import { getFindingTriage, type TriageStatus } from "@/lib/site-finding-triage";
import { listBlockedOperatorKeys, liveAgentIntelligence, type AgentIntelSummary } from "@/lib/agent-operators";
import { getProvenAttacks, NOT_CONTROL_PLANE_FP, type ProvenAttacks } from "@/lib/site-analytics-proven";
import { annotateKevProps } from "@/lib/forcefield/kev";
import { getAccountableActions, type AccountableActionsSummary } from "@/lib/site-analytics-accountability";

/** Closed event vocabulary, mirrored from the marketing site's analytics. A
 *  value outside this set is rejected at the ingest boundary. */
export const SITE_EVENT_TYPES = [
  "site.page_viewed",
  "site.section_viewed",
  "site.cta_clicked",
  "site.contact_submitted",
  "site.contact_failed",
  // Forcefield for the Web: agent traffic on ogiam.com (watch-first).
  "site.agent_welcomed",
  "site.agent_flagged",
  "site.agent_trap_tripped",
  // Phase 1 "follow the agent" signals: fused into a behavior class per session.
  "site.agent_read_robots",
  "site.agent_read_sitemap",
  "site.agent_probed_sensitive",
  "site.agent_form_honeypot",
  "site.agent_form_too_fast",
  "site.agent_payload_attack",
  "site.agent_high_rate",
  // Forcefield intent scoring: one row per session step-up (watch / tarpit /
  // block) with its reason ids. Not hostile tradecraft on its own.
  "site.intent_scored",
  // Accountable actions (watch mode): a state-changing request with no other
  // tell, carrying its accountability verdict (forcefield-web/accountability.ts).
  "site.action_observed",
] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];

export function isSiteEventType(v: unknown): v is SiteEventType {
  return typeof v === "string" && (SITE_EVENT_TYPES as readonly string[]).includes(v);
}

/** The event types that are hostile TRADECRAFT on their own (probed a sensitive
 *  path, sent a payload, tripped a decoy, hit a form honeypot / inhuman submit).
 *  One list, used by every hostile count on the board, so the headline and the
 *  origin map can never disagree about what "hostile" means. A high-rate burst
 *  is deliberately NOT here: rate alone is report-only (a shared NAT is bursty). */
export const HOSTILE_EVENT_TYPES: readonly SiteEventType[] = [
  "site.agent_probed_sensitive",
  "site.agent_payload_attack",
  "site.agent_trap_tripped",
  "site.agent_form_honeypot",
  "site.agent_form_too_fast",
];
const HOSTILE_IN = HOSTILE_EVENT_TYPES.map((t) => `'${t}'`).join(",");
/** A row is hostile when its type is hostile tradecraft OR the engine proved it
 *  is impersonating a known agent (props.impersonating). */
const HOSTILE_ROW = `(event_type IN (${HOSTILE_IN}) OR props->>'impersonating' IS NOT NULL OR props->>'agent_verification' = 'impersonation')`;

export interface RecordSiteEventInput {
  eventType: SiteEventType;
  /** Page path, e.g. "/ogiam-iam". Trimmed + length-capped by the caller. */
  path?: string | null;
  /** 2-letter country code from the edge geo header, or null. */
  country?: string | null;
  /** Referrer HOST only (no full URL / query), or null. */
  referrerHost?: string | null;
  /** Coarse, non-identifying props (which CTA, which section). No PII. */
  props?: Record<string, string | number | boolean>;
  /** The Forcefield tenant this event belongs to, when it arrived on a per-tenant
   *  ingest token. Null for the internal shared-token sites. */
  tenantId?: string | null;
}

/** Persist one site event. Best effort: no DATABASE_URL -> no-op; never throws,
 *  so analytics can never break the ingest request. */
export async function recordSiteEvent(input: RecordSiteEventInput): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  // CVE / KEV enrichment at the single write chokepoint: every writer (the
  // central observe route, the vendored-site ingest, the rate events) gets the
  // same deterministic annotation, and a client-sent cve/kev prop is replaced by
  // the server's own lookup. See src/lib/forcefield/kev/index.ts.
  const props = annotateKevProps(input.eventType, input.props);
  try {
    await query(
      `INSERT INTO site_analytics_events (event_type, path, country, referrer_host, props, forcefield_tenant_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        input.eventType,
        input.path ?? null,
        input.country ?? null,
        input.referrerHost ?? null,
        JSON.stringify(props),
        input.tenantId ?? null,
      ],
    );
  } catch (err) {
    console.warn("[site-analytics] record failed:", (err as Error).message);
  }
}

export interface SiteAnalyticsSummary {
  rangeDays: number;
  /* The distinct properties (surfaces) that have forwarded events in-window, so
     the board can offer a per-site filter. Legacy events with no surface tag are
     reported as 'ogiam.com'. */
  surfaces: string[];
  /* The surface this summary is filtered to ('all' = every property). */
  surface: string;
  totalPageViews: number;
  /**
   * Whether this property collects page-view telemetry at all. A Forcefield-
   * monitored property (instinct, weekendwithporsche, aidanmulready) forwards
   * only AGENT observations via the site shim and never a `site.page_viewed`,
   * so its page-view count is structurally 0, not "measured zero". The board
   * renders "n/a - agent monitoring only" instead of a misleading 0 when this
   * is false. True iff the property has ever sent a single page-view event.
   */
  collectsPageViews: boolean;
  totalEvents: number;
  /** 0..23 buckets of page views by hour of day (UTC), for the heatmap. */
  byHour: Array<{ hour: number; count: number }>;
  byPage: Array<{ path: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  /* Forcefield for the Web: how the monitored sites handled agent traffic.
     welcomed = identified good agents given the welcome lane; flagged =
     unidentified automation (a weak signal, recorded); trapped = scrapers that
     tripped the honeypot; blocked = requests actually turned away by enforcement
     (proven-hostile: honeytoken trip / live payload / blocked fingerprint). */
  forcefield: {
    welcomed: number;
    flagged: number;
    trapped: number;
    blocked: number;
    /* Requests enforcement WOULD have turned away, but watch mode or the plan
       held the block back (props.would_block). Shown next to blocked so a
       watch-mode site sees exactly what turning protection on would do. */
    wouldBlock: number;
    /* The truthful threat headline: DISTINCT operators that exhibited hostile
       tradecraft (probe / decoy trip / payload / honeypot). "flagged" is a weak
       heuristic (unidentified automation) and is mostly benign; hostileOperators
       is the number of actors that actually did something hostile.
       hostileEvents is their total event volume. */
    hostileOperators: number;
    hostileEvents: number;
    topAgents: Array<{ agent: string; count: number }>;
  };
  /* Learned hostile-tradecraft signatures: combos mined from caught hostiles.
     shadow = still proving itself (records would-block only); enforcing = earned
     auto-block; autoBlocked = operators turned away by an enforcing signature. */
  learnedSignatures: { shadow: number; enforcing: number; autoBlocked: number };
  /* Deeper agent intelligence: cross-site campaigns, the automation/AI/script mix,
     and who adapted after being blocked. From liveAgentIntelligence. */
  agentIntel: AgentIntelSummary;
  /* Reconstructed agent journeys: correlated sessions with a fused behavior
     class and a proven/inferred confidence. Newest first, capped. */
  journeys: Array<AgentJourney & { profile: AgentProfile; triage: TriageStatus }>;
  /* Agent provenance: where AGENT traffic (not page views) reached us from, by
     the request's edge country. This is the NETWORK ORIGIN of the traffic - a
     cloud region or proxy just as often as a person's country - so it is a
     coarse origin signal, never a confirmed operator location. Broken down by
     how Forcefield handled it so a hostile cluster from one origin stands out. */
  agentOrigins: Array<{ country: string; total: number; welcomed: number; welcomedVerified: number; flagged: number; hostile: number }>;
  /* Probe intelligence: the named attacks/CWEs agents are scanning our surface
     for, aggregated from the paths in the reconstructed journeys. Reuses the
     AgenticQA probe-signature knowledge (see agent-probe-signatures). */
  probeIntel: ProbeIntelEntry[];
  /* Payload attacks: active exploitation attempts (injection payloads) agents
     sent, aggregated by attack kind. From the edge payload detector. */
  payloadIntel: Array<{ attack: string; count: number }>;
  /* Operator-level triage state, keyed by operatorKey, so escalating/dismissing
     an operator persists across its findings and across reloads. */
  operatorTriage: Record<string, TriageStatus>;
  /* Operator keys currently on the blocklist, so the consolidation view can show
     which actors are already blocked. */
  blockedOperators: string[];
  /* Cross-workspace reputation for the operators shown, keyed by operatorKey, when
     this workspace has opted in to consume the network. Only counts + severity from
     OTHER workspaces - never which ones. Empty when not opted in. */
  networkReputation: Record<string, NetworkReputation>;
  /* The network's corroborated known-hostile actors and their tradecraft, for
     matching operators we have never seen against actors the rest of the network
     already knows. Empty when not opted in to consume. Carries no operator key or
     workspace identity - behavior only. */
  networkTradecraft: NetworkTradecraftActor[];
  /* Know the Principal: per-operator verdict on the human/mandate behind the
     agent. Only operators that presented a delegation appear here. A verified
     principal that stepped outside its granted scope is flagged mandateExceeded -
     the strongest hostile signal, an authorized agent abusing its grant. */
  principalByOperator: Record<string, PrincipalSummary>;
  /* The trust check on the intel: hostile verdicts analysts marked FALSE POSITIVE
     in the window (from forcefield.verdict_false_positive learning events), so a
     "confirmed hostile" board's error rate is visible, never taken on faith. */
  verdictFeedback: { falsePositives: number };
  /* What the edge engine did and saw, from the enforcement-era props: blocks vs
     withheld blocks by rule, fast-agent bursts, claimed-vs-verified agent
     identity, the probe labels the engine matched, and the network (ASN) the
     agent traffic came from when the site runs behind Cloudflare. */
  defense: DefenseSignals;
  /* Proven attacks per protected site (live payloads + decoy trips), blocked vs
     report-only, with the control-plane false positive excluded. The top of the
     board. available=false means the read failed, never "zero attacks". */
  proven: ProvenAttacks;
  /** Accountable actions (watch mode): per site, who was accountable for each
   *  state-changing request and what "hold for review" would have held. */
  accountability: AccountableActionsSummary;
}

export interface DefenseSignals {
  enforcement: {
    blocked: number;
    wouldBlock: number;
    /* By the rule that fired (props.reason_kind: payload, decoy, attack_tool, ...). */
    byReason: Array<{ reason: string; blocked: number; wouldBlock: number }>;
  };
  highRate: {
    bursts: number;
    operators: number;
    /* Highest request count seen in one burst window, and that window's length. */
    peakRate: number;
    windowSeconds: number | null;
    /* Bursts counted at the ingest for vendored sites (props.source = "ingest"). */
    fromIngest: number;
  };
  identity: {
    verified: number;
    impersonation: number;
    unverifiable: number;
    signed: number;
    /* Per claimed agent id: how often its identity held up. */
    byAgent: Array<{ agent: string; verified: number; impersonation: number; unverifiable: number; signed: number }>;
  };
  probes: Array<{ probe: string; count: number }>;
  networks: Array<{ asn: string; org: string | null; count: number; hostile: number }>;
}

const EMPTY_DEFENSE: DefenseSignals = {
  enforcement: { blocked: 0, wouldBlock: 0, byReason: [] },
  highRate: { bursts: 0, operators: 0, peakRate: 0, windowSeconds: null, fromIngest: 0 },
  identity: { verified: 0, impersonation: 0, unverifiable: 0, signed: 0, byAgent: [] },
  probes: [],
  networks: [],
};
export function emptyDefenseSignals(): DefenseSignals {
  return JSON.parse(JSON.stringify(EMPTY_DEFENSE)) as DefenseSignals;
}

/** Per-operator principal verdict surfaced to the board. "verified" = the
 *  delegation signature checked out against a registered issuer; "claimed" =
 *  presented but unverifiable. Absent principals are omitted. */
export interface PrincipalSummary {
  status: "verified" | "claimed";
  principal?: string;
  issuer?: string;
  scopes: string[];
  mandateExceeded: boolean;
  violations: string[];
}

/** Clamp the requested window to a sane integer day count. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(days)));
}

/** Attach persisted triage status to each journey (default "new"). Workspace
 *  required; without one (or on a DB hiccup) every finding reads as "new". */
async function attachTriage<T extends { key: string; profile: AgentProfile }>(
  journeys: T[],
  workspaceId?: string,
): Promise<Array<T & { triage: TriageStatus }>> {
  if (!workspaceId || journeys.length === 0) return journeys.map((j) => ({ ...j, triage: "new" as TriageStatus }));
  const states = await getFindingTriage(workspaceId, journeys.map((j) => j.key));
  return journeys.map((j) => ({ ...j, triage: states[j.key]?.status ?? "new" }));
}

/** Operator-level triage, keyed by operatorKey (stored under an "op:" prefix in
 *  the same triage table). Lets an analyst act on a bad actor once. */
async function operatorTriageStates(
  journeys: ReadonlyArray<{ profile: AgentProfile }>,
  workspaceId?: string,
): Promise<Record<string, TriageStatus>> {
  if (!workspaceId || journeys.length === 0) return {};
  const opKeys = Array.from(new Set(journeys.map((j) => j.profile.operatorKey)));
  const states = await getFindingTriage(workspaceId, opKeys.map((k) => `op:${k}`));
  const out: Record<string, TriageStatus> = {};
  for (const k of opKeys) {
    const st = states[`op:${k}`]?.status;
    if (st) out[k] = st;
  }
  return out;
}

/** The journey query's row (props flattened to text by ->>). */
interface JourneyQueryRow {
  event_type: string; path: string | null; created_at: string; sig: string | null; nonce: string | null; agent: string | null;
  attack: string | null; tool: string | null; client_type: string | null; principal_status: string | null; principal: string | null;
  principal_issuer: string | null; principal_scopes: string | null; site: string | null;
  blocked: string | null; would_block: string | null; impersonating: string | null; agent_verification: string | null;
  signed_agent: string | null; probe: string | null; rate: string | null;
}

/**
 * The analyst false-positive count (forcefield.verdict_false_positive learning
 * events) for one workspace over the window. instinct_events' time column is
 * `timestamp`, NOT created_at: the old query named created_at, errored on every
 * call, and safeQuery swallowed it, so the board always read 0. The schema test
 * in __tests__/site-analytics-schema.test.ts now checks every query here against
 * the migrations so that class of bug fails the build.
 */
export async function countVerdictFalsePositives(workspaceId: string, days: number): Promise<number> {
  const r = await safeQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM instinct_events
      WHERE event_type = 'forcefield.verdict_false_positive'
        AND metadata->>'workspace_id' = $1
        AND timestamp > now() - ($2::int * interval '1 day')`,
    [workspaceId, clampDays(days)],
  );
  return r?.rows?.[0] ? Number(r.rows[0].n) : 0;
}

/** A numeric props value as SQL, or NULL when it is not a plain number (never
 *  a cast that can fail the whole query on one malformed row). */
const numProp = (k: string) => `CASE WHEN props->>'${k}' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (props->>'${k}')::numeric END`;

/**
 * The enforcement-era signals, read as plain props so the board renders them
 * whether or not the edge emitting them is the newest engine: blocks vs withheld
 * blocks by rule, fast-agent bursts, claimed-vs-verified identity, the engine's
 * probe labels, and the source network (ASN, Cloudflare sites only). Degrades to
 * empty on any DB error (safeQuery), never throws.
 */
async function getDefenseSignals(sinceClause: string, surfaceClause: string, params: string[]): Promise<DefenseSignals> {
  // The control-plane false positive is not an attack; it never reaches a count.
  const where = `WHERE ${sinceClause}${surfaceClause}${NOT_CONTROL_PLANE_FP}`;
  const [reasons, rate, identity, probes, networks] = await Promise.all([
    safeQuery<{ reason: string; blocked: string; would_block: string }>(
      `SELECT coalesce(props->>'reason_kind', 'unspecified') AS reason,
              count(*) FILTER (WHERE props->>'blocked' = 'true') AS blocked,
              count(*) FILTER (WHERE props->>'would_block' = 'true' AND coalesce(props->>'blocked', '') <> 'true') AS would_block
         FROM site_analytics_events
        ${where} AND (props->>'blocked' = 'true' OR props->>'would_block' = 'true')
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      params,
    ),
    safeQuery<{ bursts: string; operators: string; peak: string | null; window_s: string | null; from_ingest: string }>(
      `SELECT count(*) AS bursts,
              count(DISTINCT coalesce(props->>'fp', props->>'sig')) AS operators,
              max(${numProp("rate")}) AS peak,
              max(${numProp("window_s")}) AS window_s,
              count(*) FILTER (WHERE props->>'source' = 'ingest') AS from_ingest
         FROM site_analytics_events
        ${where} AND event_type = 'site.agent_high_rate'`,
      params,
    ),
    safeQuery<{ agent: string; verified: string; impersonation: string; unverifiable: string; signed: string }>(
      `SELECT coalesce(props->>'impersonating', props->>'agent', 'unidentified') AS agent,
              count(*) FILTER (WHERE props->>'agent_verification' = 'verified') AS verified,
              count(*) FILTER (WHERE props->>'agent_verification' = 'impersonation' OR props->>'impersonating' IS NOT NULL) AS impersonation,
              count(*) FILTER (WHERE props->>'agent_verification' = 'unverifiable') AS unverifiable,
              count(*) FILTER (WHERE props->>'signed_agent' = 'true') AS signed
         FROM site_analytics_events
        ${where} AND (props->>'agent_verification' IS NOT NULL OR props->>'impersonating' IS NOT NULL OR props->>'signed_agent' = 'true')
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      params,
    ),
    safeQuery<{ probe: string; count: string }>(
      `SELECT props->>'probe' AS probe, count(*) AS count
         FROM site_analytics_events
        ${where} AND props->>'probe' IS NOT NULL AND props->>'probe' <> ''
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      params,
    ),
    safeQuery<{ asn: string; org: string | null; count: string; hostile: string }>(
      `SELECT props->>'asn' AS asn, max(props->>'as_org') AS org, count(*) AS count,
              count(*) FILTER (WHERE ${HOSTILE_ROW}) AS hostile
         FROM site_analytics_events
        ${where} AND event_type LIKE 'site.agent_%' AND props->>'asn' IS NOT NULL AND props->>'asn' <> ''
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 15`,
      params,
    ),
  ]);
  const out = emptyDefenseSignals();
  for (const r of reasons.rows) {
    const b = Number(r.blocked), w = Number(r.would_block);
    out.enforcement.blocked += b;
    out.enforcement.wouldBlock += w;
    out.enforcement.byReason.push({ reason: r.reason, blocked: b, wouldBlock: w });
  }
  const hr = rate.rows[0];
  if (hr) {
    out.highRate = {
      bursts: Number(hr.bursts),
      operators: Number(hr.operators),
      peakRate: hr.peak !== null ? Number(hr.peak) : 0,
      windowSeconds: hr.window_s !== null ? Number(hr.window_s) : null,
      fromIngest: Number(hr.from_ingest),
    };
  }
  for (const r of identity.rows) {
    const e = { agent: r.agent, verified: Number(r.verified), impersonation: Number(r.impersonation), unverifiable: Number(r.unverifiable), signed: Number(r.signed) };
    out.identity.verified += e.verified;
    out.identity.impersonation += e.impersonation;
    out.identity.unverifiable += e.unverifiable;
    out.identity.signed += e.signed;
    out.identity.byAgent.push(e);
  }
  out.probes = probes.rows.map((r) => ({ probe: r.probe, count: Number(r.count) }));
  out.networks = networks.rows.map((r) => ({ asn: r.asn, org: r.org ?? null, count: Number(r.count), hostile: Number(r.hostile) }));
  return out;
}

/**
 * Aggregate the last `rangeDays` of site telemetry into the shapes the admin
 * page renders. Pure SQL aggregation; reads only. Degrades to empty arrays when
 * the DB is unavailable (safeQuery), never throws.
 */
export async function getSiteAnalyticsSummary(rangeDays = 30, workspaceId?: string, surface = "all"): Promise<SiteAnalyticsSummary> {
  const days = clampDays(rangeDays);
  const sinceClause = `created_at > now() - ($1 || ' days')::interval`;
  // Per-site filter. Legacy events carry no surface tag, so null coalesces to
  // 'ogiam.com'. When 'all', no extra predicate (the cross-site view). The value
  // is always a bound parameter ($2), never interpolated.
  const filtered = surface !== "all" && surface.length > 0;
  const surfaceClause = filtered ? ` AND coalesce(props->>'site', 'ogiam.com') = $2` : "";
  const params = filtered ? [String(days), surface] : [String(days)];

  // Exclude the page-load asset noise (headless browsers fetching /sw.js, images,
  // css/js, manifest, /_next/*) from AGENT counts, mirroring isStaticAsset() in
  // forcefield-web/observe.ts. The source fix only cleans NEW events; this makes
  // the historical board read right too. Applied to agent-signal queries only -
  // raw traffic totals + page views are left as-is. `/api` stays counted (signal).
  const ap = "coalesce(props->>'path', path)";
  const notAssetFlag =
    ` AND NOT (event_type = 'site.agent_flagged' AND ${ap} NOT LIKE '/api/%' AND (` +
    `${ap} LIKE '/_next/%' OR ${ap} IN ('/sw.js','/manifest.json','/favicon.ico') OR ` +
    `${ap} ~* '\\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|webmanifest)$'))` +
    // Our own edge's control-plane calls, once mis-flagged as CVE-2025-29927
    // (fixed at the source in enforce.ts). The old rows are still in the window
    // and must not count as attacks anywhere on the board.
    NOT_CONTROL_PLANE_FP;

  const [hour, page, country, type, totals, ff, ffAgents, journeyRows, agentOriginRows, payloadRows, surfacesRows, pvExists, learnedSig, agentIntel, defense] = await Promise.all([
    safeQuery<{ hour: number; count: string }>(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type = 'site.page_viewed'
        GROUP BY 1 ORDER BY 1`,
      params,
    ),
    safeQuery<{ path: string; count: string }>(
      `SELECT coalesce(path, '(unknown)') AS path, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type = 'site.page_viewed'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      params,
    ),
    safeQuery<{ country: string; count: string }>(
      `SELECT coalesce(country, '(unknown)') AS country, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type = 'site.page_viewed'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      params,
    ),
    safeQuery<{ event_type: string; count: string }>(
      `SELECT event_type, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}${notAssetFlag}
        GROUP BY 1 ORDER BY count(*) DESC`,
      params,
    ),
    safeQuery<{ page_views: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'site.page_viewed') AS page_views,
         count(*) AS total
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}`,
      params,
    ),
    safeQuery<{ welcomed: string; flagged: string; trapped: string; blocked: string; would_block: string; hostile_operators: string; hostile_events: string }>(
      /* welcomed/flagged/trapped/blocked are event tallies. hostile_operators is
         the number that actually matters: DISTINCT fingerprints that exhibited
         hostile TRADECRAFT (probed a sensitive path, tripped a decoy, sent a
         payload, hit a honeypot). "flagged" is a weak heuristic (unidentified
         automation) and is mostly benign crawlers and first-party traffic, so a
         raw flagged count reads as "thousands of threats" when almost none did
         anything hostile. hostile_operators is the truthful headline. */
      `SELECT
         count(*) FILTER (WHERE event_type = 'site.agent_welcomed')     AS welcomed,
         count(*) FILTER (WHERE event_type = 'site.agent_flagged')      AS flagged,
         count(*) FILTER (WHERE event_type = 'site.agent_trap_tripped') AS trapped,
         count(*) FILTER (WHERE props->>'blocked' = 'true')             AS blocked,
         count(*) FILTER (WHERE props->>'would_block' = 'true' AND coalesce(props->>'blocked', '') <> 'true') AS would_block,
         count(DISTINCT props->>'fp') FILTER (WHERE ${HOSTILE_ROW} AND props->>'fp' IS NOT NULL) AS hostile_operators,
         count(*) FILTER (WHERE ${HOSTILE_ROW}) AS hostile_events
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}${notAssetFlag}`,
      params,
    ),
    safeQuery<{ agent: string; count: string }>(
      `SELECT coalesce(props->>'agent', '(unidentified)') AS agent, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type = 'site.agent_welcomed'
          AND props->>'impersonating' IS NULL AND coalesce(props->>'agent_verification', '') <> 'impersonation'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`,
      params,
    ),
    /* Journey events. A single global LIMIT ordered by time silently starves the
       "all properties" view: the highest-volume site fills the cap and the quieter
       ones (and every RECENT agent) never appear. Instead take the most-recent N
       events PER SITE, so every property is represented and newest agents always
       show, then order ascending for the journey reconstruction. */
    safeQuery<JourneyQueryRow>(
      `SELECT event_type, path, created_at::text AS created_at, sig, nonce, agent, attack, tool, client_type,
              principal_status, principal, principal_issuer, principal_scopes, site,
              blocked, would_block, impersonating, agent_verification, signed_agent, probe, rate
         FROM (
           SELECT event_type, path, created_at,
                  props->>'sig' AS sig, props->>'nonce' AS nonce, props->>'agent' AS agent, props->>'attack' AS attack,
                  props->>'tool' AS tool, props->>'client_type' AS client_type,
                  props->>'principal_status' AS principal_status, props->>'principal' AS principal,
                  props->>'principal_issuer' AS principal_issuer, props->>'principal_scopes' AS principal_scopes,
                  props->>'blocked' AS blocked, props->>'would_block' AS would_block,
                  props->>'impersonating' AS impersonating, props->>'agent_verification' AS agent_verification,
                  props->>'signed_agent' AS signed_agent, props->>'probe' AS probe, props->>'rate' AS rate,
                  coalesce(props->>'site', 'ogiam.com') AS site,
                  ROW_NUMBER() OVER (PARTITION BY coalesce(props->>'site', 'ogiam.com') ORDER BY created_at DESC) AS rn
             FROM site_analytics_events
            WHERE ${sinceClause}${surfaceClause}${notAssetFlag}
              AND (props->>'sig' IS NOT NULL OR props->>'nonce' IS NOT NULL)
         ) t
        WHERE rn <= 1500
        ORDER BY created_at ASC`,
      params,
    ),
    /* Agent provenance by edge country. Only AGENT-signal events (not page
       views), split by how Forcefield handled each, so a hostile cluster from
       one network origin is visible. */
    safeQuery<{ country: string; total: string; welcomed: string; welcomed_verified: string; flagged: string; hostile: string }>(
      `SELECT country,
              count(*) AS total,
              count(*) FILTER (WHERE event_type = 'site.agent_welcomed') AS welcomed,
              count(*) FILTER (WHERE event_type = 'site.agent_welcomed' AND (props->>'verified' = 'true' OR props->>'agent_verification' = 'verified')) AS welcomed_verified,
              count(*) FILTER (WHERE event_type = 'site.agent_flagged')  AS flagged,
              count(*) FILTER (WHERE ${HOSTILE_ROW}) AS hostile
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}${notAssetFlag} AND event_type LIKE 'site.agent_%' AND country IS NOT NULL AND country <> ''
        GROUP BY country ORDER BY count(*) DESC LIMIT 100`,
      params,
    ),
    safeQuery<{ attack: string; count: string }>(
      `SELECT coalesce(props->>'attack', 'unknown') AS attack, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}${NOT_CONTROL_PLANE_FP} AND event_type = 'site.agent_payload_attack'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 20`,
      params,
    ),
    /* The distinct surfaces present in-window - NOT filtered by the selected
       surface, so the picker always lists every property. Legacy events (no tag)
       show as 'ogiam.com'. */
    safeQuery<{ surface: string }>(
      `SELECT DISTINCT coalesce(props->>'site', 'ogiam.com') AS surface
         FROM site_analytics_events
        WHERE ${sinceClause}
        ORDER BY 1`,
      [String(days)],
    ),
    /* Does this property collect page views AT ALL, lifetime (ignore the
       window)? Distinguishes an agent-monitored property that never forwards a
       page view (-> "n/a") from one that simply had none in the window (-> 0).
       Surface filter only; no since clause, so a single bound param at most. */
    safeQuery<{ has_pv: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM site_analytics_events
          WHERE event_type = 'site.page_viewed'${filtered ? ` AND coalesce(props->>'site', 'ogiam.com') = $1` : ""}
       ) AS has_pv`,
      filtered ? [surface] : [],
    ),
    /* Learned hostile-tradecraft signatures, workspace-global (not window/surface
       scoped - a signature is cross-site). Counts by status + total operators
       auto-blocked by an enforcing signature. */
    safeQuery<{ shadow: string; enforcing: string; auto_blocked: string }>(
      `SELECT
         count(*) FILTER (WHERE status = 'shadow')    AS shadow,
         count(*) FILTER (WHERE status = 'enforcing') AS enforcing,
         coalesce(sum(auto_blocked), 0)               AS auto_blocked
         FROM instinct_learned_hostile_signatures
        WHERE workspace_id = $1`,
      [process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default"],
    ),
    // Deeper agent intelligence across the live edge stream (cross-site campaigns,
    // automation/AI/script mix, adaptive reactions). Not a query - a rollup.
    liveAgentIntelligence(days),
    getDefenseSignals(sinceClause, surfaceClause, params),
  ]);

  const surfaces = surfacesRows.rows.map((r) => r.surface).filter((x): x is string => typeof x === "string" && x.length > 0);
  const [proven, accountability] = await Promise.all([
    getProvenAttacks(sinceClause, surfaceClause, params, surfaces),
    getAccountableActions(days, filtered ? surface : "all"),
  ]);
  const t = totals.rows[0];
  const journeys = await attachTriage(
    buildJourneys(
      journeyRows.rows.map((r) => {
        const nonce = r.nonce ?? undefined;
        const key = nonce ?? r.sig ?? "";
        const keyKind: CorrelationKind = nonce ? "nonce" : "fingerprint";
        let principalScopes: string[] | undefined;
        if (r.principal_scopes) {
          try { const parsed = JSON.parse(r.principal_scopes); if (Array.isArray(parsed)) principalScopes = parsed.filter((x): x is string => typeof x === "string"); } catch { /* ignore malformed */ }
        }
        const principalStatus = r.principal_status === "verified" || r.principal_status === "claimed" || r.principal_status === "absent" ? (r.principal_status as "verified" | "claimed" | "absent") : undefined;
        const rate = r.rate !== null && r.rate !== "" && Number.isFinite(Number(r.rate)) ? Number(r.rate) : undefined;
        return {
          key, keyKind, type: r.event_type, path: r.path ?? "", at: r.created_at, nonceLinked: !!nonce,
          agent: r.agent ?? undefined, attack: r.attack ?? undefined, tool: r.tool ?? undefined, clientType: r.client_type ?? undefined,
          principalStatus, principal: r.principal ?? undefined, principalIssuer: r.principal_issuer ?? undefined, principalScopes, site: r.site ?? undefined,
          blocked: r.blocked === "true", wouldBlock: r.would_block === "true" && r.blocked !== "true",
          impersonating: r.impersonating ?? undefined, agentVerification: r.agent_verification ?? undefined,
          signedAgent: r.signed_agent === "true", probe: r.probe ?? undefined, rate,
        };
      }).filter((r) => r.key !== ""),
    ).slice(0, 25).map((j) => ({ ...j, profile: buildAgentProfile(j) })),
    workspaceId,
  );
  const operatorTriage = await operatorTriageStates(journeys, workspaceId);
  const blockedOperators = workspaceId ? Array.from(await listBlockedOperatorKeys(workspaceId)) : [];
  const networkReputation = workspaceId
    ? await getNetworkReputation(workspaceId, Array.from(new Set(journeys.map((j) => j.profile.operatorKey))))
    : {};
  const networkTradecraft = workspaceId ? await getNetworkTradecraft(workspaceId) : [];
  const falsePositives = workspaceId ? await countVerdictFalsePositives(workspaceId, days) : 0;
  // Aggregate the per-session principal verdicts up to the operator. When an
  // operator has multiple sessions, the most security-relevant wins: a mandate
  // violation outranks a bare claimed credential, which outranks a clean verify.
  const principalRank = (e: PrincipalSummary): number => (e.mandateExceeded ? 3 : e.status === "claimed" ? 2 : 1);
  const principalByOperator: Record<string, PrincipalSummary> = {};
  for (const j of journeys) {
    const pv = j.principal;
    if (!pv || pv.status === "absent") continue;
    const exceeded = pv.status === "verified" && j.mandate ? !j.mandate.withinScope : false;
    const entry: PrincipalSummary = {
      status: pv.status === "verified" ? "verified" : "claimed",
      principal: pv.principal,
      issuer: pv.issuer,
      scopes: pv.scopes,
      mandateExceeded: exceeded,
      violations: exceeded ? (j.mandate?.violations ?? []) : [],
    };
    const key = j.profile.operatorKey;
    const cur = principalByOperator[key];
    if (!cur || principalRank(entry) > principalRank(cur)) principalByOperator[key] = entry;
  }

  return {
    rangeDays: days,
    surfaces,
    surface,
    totalPageViews: t ? Number(t.page_views) : 0,
    collectsPageViews: pvExists?.rows?.[0]?.has_pv === true,
    totalEvents: t ? Number(t.total) : 0,
    byHour: hour.rows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) })),
    byPage: page.rows.map((r) => ({ path: r.path, count: Number(r.count) })),
    byCountry: country.rows.map((r) => ({ country: r.country, count: Number(r.count) })),
    byType: type.rows.map((r) => ({ type: r.event_type, count: Number(r.count) })),
    forcefield: {
      welcomed: ff.rows[0] ? Number(ff.rows[0].welcomed) : 0,
      flagged: ff.rows[0] ? Number(ff.rows[0].flagged) : 0,
      trapped: ff.rows[0] ? Number(ff.rows[0].trapped) : 0,
      blocked: ff.rows[0] ? Number(ff.rows[0].blocked) : 0,
      wouldBlock: ff.rows[0] ? Number(ff.rows[0].would_block ?? 0) : 0,
      hostileOperators: ff.rows[0] ? Number(ff.rows[0].hostile_operators) : 0,
      hostileEvents: ff.rows[0] ? Number(ff.rows[0].hostile_events) : 0,
      topAgents: ffAgents.rows.map((r) => ({ agent: r.agent, count: Number(r.count) })),
    },
    learnedSignatures: {
      shadow: learnedSig?.rows?.[0] ? Number(learnedSig.rows[0].shadow) : 0,
      enforcing: learnedSig?.rows?.[0] ? Number(learnedSig.rows[0].enforcing) : 0,
      autoBlocked: learnedSig?.rows?.[0] ? Number(learnedSig.rows[0].auto_blocked) : 0,
    },
    agentIntel,
    journeys,
    operatorTriage,
    blockedOperators,
    networkReputation,
    networkTradecraft,
    verdictFeedback: { falsePositives },
    defense,
    proven,
    accountability,
    principalByOperator,
    agentOrigins: agentOriginRows.rows.map((r) => ({
      country: r.country,
      total: Number(r.total),
      welcomed: Number(r.welcomed),
      welcomedVerified: Number(r.welcomed_verified),
      flagged: Number(r.flagged),
      hostile: Number(r.hostile),
    })),
    probeIntel: summarizeProbeIntel(journeyRows.rows.map((r) => r.path ?? "")),
    payloadIntel: payloadRows.rows.map((r) => ({ attack: r.attack, count: Number(r.count) })),
  };
}
