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
import { listBlockedOperatorKeys } from "@/lib/agent-operators";

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
] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];

export function isSiteEventType(v: unknown): v is SiteEventType {
  return typeof v === "string" && (SITE_EVENT_TYPES as readonly string[]).includes(v);
}

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
}

/** Persist one site event. Best effort: no DATABASE_URL -> no-op; never throws,
 *  so analytics can never break the ingest request. */
export async function recordSiteEvent(input: RecordSiteEventInput): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO site_analytics_events (event_type, path, country, referrer_host, props)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.eventType,
        input.path ?? null,
        input.country ?? null,
        input.referrerHost ?? null,
        JSON.stringify(input.props ?? {}),
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
  totalEvents: number;
  /** 0..23 buckets of page views by hour of day (UTC), for the heatmap. */
  byHour: Array<{ hour: number; count: number }>;
  byPage: Array<{ path: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  /* Forcefield for the Web: how ogiam.com handled agent traffic. welcomed =
     identified good agents given the welcome lane; flagged = unidentified
     automation; trapped = scrapers that tripped the honeypot. Watch-first, so
     these are observed, not blocked. */
  forcefield: {
    welcomed: number;
    flagged: number;
    trapped: number;
    topAgents: Array<{ agent: string; count: number }>;
  };
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

  const [hour, page, country, type, totals, ff, ffAgents, journeyRows, agentOriginRows, payloadRows, surfacesRows] = await Promise.all([
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
        WHERE ${sinceClause}${surfaceClause}
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
    safeQuery<{ welcomed: string; flagged: string; trapped: string }>(
      `SELECT
         count(*) FILTER (WHERE event_type = 'site.agent_welcomed')     AS welcomed,
         count(*) FILTER (WHERE event_type = 'site.agent_flagged')      AS flagged,
         count(*) FILTER (WHERE event_type = 'site.agent_trap_tripped') AS trapped
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}`,
      params,
    ),
    safeQuery<{ agent: string; count: string }>(
      `SELECT coalesce(props->>'agent', '(unidentified)') AS agent, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type = 'site.agent_welcomed'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`,
      params,
    ),
    safeQuery<{ event_type: string; path: string | null; created_at: string; sig: string | null; nonce: string | null; agent: string | null; attack: string | null; tool: string | null; client_type: string | null; principal_status: string | null; principal: string | null; principal_issuer: string | null; principal_scopes: string | null }>(
      `SELECT event_type, path, created_at::text AS created_at,
              props->>'sig' AS sig, props->>'nonce' AS nonce, props->>'agent' AS agent, props->>'attack' AS attack,
              props->>'tool' AS tool, props->>'client_type' AS client_type,
              props->>'principal_status' AS principal_status, props->>'principal' AS principal,
              props->>'principal_issuer' AS principal_issuer, props->>'principal_scopes' AS principal_scopes
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause}
          AND (props->>'sig' IS NOT NULL OR props->>'nonce' IS NOT NULL)
        ORDER BY created_at
        LIMIT 2000`,
      params,
    ),
    /* Agent provenance by edge country. Only AGENT-signal events (not page
       views), split by how Forcefield handled each, so a hostile cluster from
       one network origin is visible. */
    safeQuery<{ country: string; total: string; welcomed: string; welcomed_verified: string; flagged: string; hostile: string }>(
      `SELECT country,
              count(*) AS total,
              count(*) FILTER (WHERE event_type = 'site.agent_welcomed') AS welcomed,
              count(*) FILTER (WHERE event_type = 'site.agent_welcomed' AND props->>'verified' = 'true') AS welcomed_verified,
              count(*) FILTER (WHERE event_type = 'site.agent_flagged')  AS flagged,
              count(*) FILTER (WHERE event_type IN ('site.agent_trap_tripped', 'site.agent_probed_sensitive', 'site.agent_form_honeypot', 'site.agent_form_too_fast')) AS hostile
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type LIKE 'site.agent_%' AND country IS NOT NULL AND country <> ''
        GROUP BY country ORDER BY count(*) DESC LIMIT 100`,
      params,
    ),
    safeQuery<{ attack: string; count: string }>(
      `SELECT coalesce(props->>'attack', 'unknown') AS attack, count(*) AS count
         FROM site_analytics_events
        WHERE ${sinceClause}${surfaceClause} AND event_type = 'site.agent_payload_attack'
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
        const principalStatus = r.principal_status === "verified" || r.principal_status === "claimed" || r.principal_status === "absent" ? r.principal_status : undefined;
        return { key, keyKind, type: r.event_type, path: r.path ?? "", at: r.created_at, nonceLinked: !!nonce, agent: r.agent ?? undefined, attack: r.attack ?? undefined, tool: r.tool ?? undefined, clientType: r.client_type ?? undefined, principalStatus, principal: r.principal ?? undefined, principalIssuer: r.principal_issuer ?? undefined, principalScopes };
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
    surfaces: surfacesRows.rows.map((r) => r.surface).filter((x): x is string => typeof x === "string" && x.length > 0),
    surface,
    totalPageViews: t ? Number(t.page_views) : 0,
    totalEvents: t ? Number(t.total) : 0,
    byHour: hour.rows.map((r) => ({ hour: Number(r.hour), count: Number(r.count) })),
    byPage: page.rows.map((r) => ({ path: r.path, count: Number(r.count) })),
    byCountry: country.rows.map((r) => ({ country: r.country, count: Number(r.count) })),
    byType: type.rows.map((r) => ({ type: r.event_type, count: Number(r.count) })),
    forcefield: {
      welcomed: ff.rows[0] ? Number(ff.rows[0].welcomed) : 0,
      flagged: ff.rows[0] ? Number(ff.rows[0].flagged) : 0,
      trapped: ff.rows[0] ? Number(ff.rows[0].trapped) : 0,
      topAgents: ffAgents.rows.map((r) => ({ agent: r.agent, count: Number(r.count) })),
    },
    journeys,
    operatorTriage,
    blockedOperators,
    networkReputation,
    networkTradecraft,
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
