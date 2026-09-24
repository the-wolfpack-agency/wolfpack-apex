/**
 * Agent operators store + rollup - persist sightings and reconstruct the
 * operators board over time.
 *
 * A single probe run is a snapshot; persisting sightings turns it into an
 * operator HISTORY, which is the heart of attribution. Each sighting is stored
 * under its durable operator key (scaffolding + toolset fingerprint, non-PII);
 * the board groups a consistent operator across visits and surfaces and rebuilds
 * a fused dossier per operator. Reads fail open (empty) so the board degrades
 * rather than throwing.
 */
import { query, safeQuery } from "@/lib/db";
import { operatorKeyFor, buildDossiers, buildDossier, type Sighting, type AttributionDossier } from "@/lib/agent-dossier";
import { buildJourneys, type AgentJourney, type CorrelationKind } from "@/lib/agent-behavior";
import { liveSightingFor } from "@/lib/agent-profile";
import { analyzeAgent, type AgentIntelEvent } from "@/lib/forcefield/agent-intelligence";
import type { ScaffoldingSignature } from "@/lib/agent-probe";
import type { ToolCompositionReport } from "@/lib/agent-tool-composition";

/** Persist one sighting. Best effort: no DATABASE_URL -> skip; never throws so
 *  a storage hiccup cannot break the probe response. Returns the operator key. */
export async function recordSighting(input: { workspaceId: string; sighting: Sighting }): Promise<string | null> {
  const { workspaceId, sighting } = input;
  const operatorKey = operatorKeyFor(sighting.scaffolding, sighting.tools);
  if (!process.env.DATABASE_URL) return operatorKey;
  // Single-sighting threat, so the row carries a scannable level without a rebuild.
  const threat = buildDossier([sighting]).threatLevel;
  try {
    await query(
      `INSERT INTO instinct_agent_sightings
         (workspace_id, operator_key, surface, seen_at, behavior_class, behavior_confidence, threat_level, journey, scaffolding, tools)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        workspaceId, operatorKey, sighting.surface, sighting.at,
        sighting.journey.behaviorClass, sighting.journey.confidence, threat,
        JSON.stringify(sighting.journey), JSON.stringify(sighting.scaffolding), JSON.stringify(sighting.tools),
      ],
    );
  } catch (err) {
    console.warn("[agent-operators] recordSighting failed:", (err as Error).message);
  }
  return operatorKey;
}

interface SightingRow {
  surface: string;
  seen_at: string;
  journey: AgentJourney;
  scaffolding: ScaffoldingSignature;
  tools: ToolCompositionReport;
}

/** Clamp a day window into [1, 365]. */
function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(365, Math.trunc(days)));
}

/** Read stored sightings for a workspace over the window, newest first. */
export async function listSightings(workspaceId: string, rangeDays = 30, limit = 2000): Promise<Sighting[]> {
  const days = clampDays(rangeDays);
  const cap = Math.max(1, Math.min(limit, 5000));
  const { rows } = await safeQuery<SightingRow>(
    `SELECT surface, seen_at::text AS seen_at, journey, scaffolding, tools
       FROM instinct_agent_sightings
      WHERE workspace_id = $1
        AND seen_at > now() - ($2 || ' days')::interval
      ORDER BY seen_at DESC
      LIMIT ${cap}`,
    [workspaceId, String(days)],
  );
  return rows.map((r) => ({ surface: r.surface, at: r.seen_at, journey: r.journey, scaffolding: r.scaffolding, tools: r.tools }));
}

export type OperatorEntry = AttributionDossier & { blocked: boolean };

/** The operators board: stored sightings, grouped into per-operator dossiers
 *  (most-recent first), each annotated with whether it is on the blocklist. */
export async function getOperators(workspaceId: string, rangeDays = 30): Promise<OperatorEntry[]> {
  const [sightings, blocked] = await Promise.all([
    listSightings(workspaceId, rangeDays),
    listBlockedOperatorKeys(workspaceId),
  ]);
  return buildDossiers(sightings).map((d) => ({ ...d, blocked: blocked.has(d.operatorKey) }));
}

/**
 * Operator dossiers built from the LIVE edge stream (site_analytics_events), the
 * same source the /admin/site-analytics board reads - NOT the instinct_agent_
 * sightings table (which only the public harness writes). The edge shim records
 * agent activity as site.agent_* events, so any consumer that wants the real
 * inbound operators (e.g. the learned-signature miner) must reconstruct dossiers
 * here rather than from getOperators. Reconstructs journeys exactly as the board
 * does (buildJourneys) and reuses liveSightingFor so the operator key matches the
 * one autoBlockOperator resolves. Fail-safe: empty on any error / no DB.
 */
export async function liveOperatorDossiers(rangeDays = 30): Promise<AttributionDossier[]> {
  if (!process.env.DATABASE_URL) return [];
  const days = clampDays(rangeDays);
  try {
    const { rows } = await safeQuery<{ event_type: string; path: string | null; created_at: string; sig: string | null; nonce: string | null; agent: string | null; attack: string | null; tool: string | null; client_type: string | null; site: string | null }>(
      `SELECT event_type, path, created_at::text AS created_at,
              props->>'sig' AS sig, props->>'nonce' AS nonce, props->>'agent' AS agent, props->>'attack' AS attack,
              props->>'tool' AS tool, props->>'client_type' AS client_type, coalesce(props->>'site', 'ogiam.com') AS site
         FROM site_analytics_events
        WHERE created_at > now() - ($1 || ' days')::interval
          AND (props->>'sig' IS NOT NULL OR props->>'nonce' IS NOT NULL)
        ORDER BY created_at ASC
        LIMIT 5000`,
      [String(days)],
    );
    const siteByKey = new Map<string, string>();
    const jrows = rows.map((r) => {
      const nonce = r.nonce ?? undefined;
      const key = nonce ?? r.sig ?? "";
      if (key && r.site) siteByKey.set(key, r.site);
      return { key, keyKind: (nonce ? "nonce" : "fingerprint") as CorrelationKind, type: r.event_type, path: r.path ?? "", at: r.created_at, nonceLinked: !!nonce, agent: r.agent ?? undefined, attack: r.attack ?? undefined, tool: r.tool ?? undefined, clientType: r.client_type ?? undefined };
    }).filter((r) => r.key !== "");
    const journeys = buildJourneys(jrows);
    const sightings = journeys.map((j) => liveSightingFor(j, siteByKey.get(j.key) ?? "edge"));
    return buildDossiers(sightings);
  } catch (err) {
    console.warn("[agent-operators] liveOperatorDossiers failed:", (err as Error).message);
    return [];
  }
}

/** Block an operator by its durable fingerprint. Idempotent (upsert). No-op
 *  without a DB. */
export async function blockOperator(input: { workspaceId: string; operatorKey: string; reason?: string; blockedBy?: string }): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(
      `INSERT INTO instinct_agent_operator_blocklist (workspace_id, operator_key, reason, blocked_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, operator_key)
       DO UPDATE SET reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by, blocked_at = now()`,
      [input.workspaceId, input.operatorKey, input.reason ?? null, input.blockedBy ?? null],
    );
  } catch (err) {
    console.warn("[agent-operators] blockOperator failed:", (err as Error).message);
  }
}

/** Remove an operator from the blocklist. */
export async function unblockOperator(workspaceId: string, operatorKey: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(`DELETE FROM instinct_agent_operator_blocklist WHERE workspace_id = $1 AND operator_key = $2`, [workspaceId, operatorKey]);
  } catch (err) {
    console.warn("[agent-operators] unblockOperator failed:", (err as Error).message);
  }
}

/** The set of blocked operator keys for a workspace. Fail-open (empty). */
export async function listBlockedOperatorKeys(workspaceId: string): Promise<Set<string>> {
  const { rows } = await safeQuery<{ operator_key: string }>(
    `SELECT operator_key FROM instinct_agent_operator_blocklist WHERE workspace_id = $1`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.operator_key));
}

/** True when an operator is blocked - the hook a probe run / edge integration
 *  uses to deny a known-hostile operator on sight. */
export async function isOperatorBlocked(workspaceId: string, operatorKey: string): Promise<boolean> {
  return (await listBlockedOperatorKeys(workspaceId)).has(operatorKey);
}

/** The event_type -> structural signal map, for the intelligence rollup. */
const INTEL_SIGNAL_OF: Record<string, string> = {
  "site.agent_probed_sensitive": "probed_sensitive",
  "site.agent_trap_tripped": "tripped_decoy",
  "site.agent_payload_attack": "payload_attack",
  "site.agent_read_robots": "read_robots",
  "site.agent_read_sitemap": "read_sitemap",
  "site.agent_high_rate": "high_rate",
  "site.agent_form_honeypot": "form_honeypot",
  "site.agent_form_too_fast": "form_too_fast",
};

export interface AgentIntelSummary {
  operators: number;
  campaigns: number; // one operator active on >1 property
  automationFleet: number; // headless / framework operators
  aiAgents: number;
  scripts: number;
  datacenterOperators: number; // operators whose traffic came from a datacenter/cloud network
  persistedAfterBlock: number; // kept going after we turned it away
  escalatedAfterBlock: number; // brought a NEW hostile technique after a block
  /** A few notable cross-site campaigns to show, most-sites-first. */
  topCampaigns: Array<{ fp: string; sites: string[]; clientClass: string; rhythm: string }>;
}

const EMPTY_INTEL: AgentIntelSummary = { operators: 0, campaigns: 0, automationFleet: 0, aiAgents: 0, scripts: 0, datacenterOperators: 0, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] };

/**
 * Deeper agent intelligence rolled up across the LIVE edge stream: cross-site
 * campaigns, automation/AI/script mix, and who adapted after being blocked.
 * Groups events by the stable edge fingerprint and runs the pure analyzeAgent
 * on each. Fail-safe: empty on any error / no DB.
 */
export async function liveAgentIntelligence(rangeDays = 7): Promise<AgentIntelSummary> {
  if (!process.env.DATABASE_URL) return EMPTY_INTEL;
  const days = clampDays(rangeDays);
  try {
    // Cross-site by design: NOT scoped to a surface (a campaign spans properties),
    // so the site is selected raw and coalesced in JS rather than in SQL.
    const { rows } = await safeQuery<{ at: string; site: string | null; fp: string; blocked: boolean | null; tool: string | null; ctype: string | null; hosting: string | null; event_type: string }>(
      `SELECT created_at::text AS at, props->>'site' AS site, props->>'fp' AS fp,
              (props->>'blocked')::boolean AS blocked, props->>'tool' AS tool, props->>'client_type' AS ctype,
              props->>'hosting' AS hosting, event_type
         FROM site_analytics_events
        WHERE created_at > now() - ($1 || ' days')::interval
          AND event_type LIKE 'site.agent_%'
          AND props->>'fp' IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 20000`,
      [String(days)],
    );
    const byFp = new Map<string, AgentIntelEvent[]>();
    for (const r of rows) {
      let arr = byFp.get(r.fp);
      if (!arr) byFp.set(r.fp, (arr = []));
      const sig = INTEL_SIGNAL_OF[r.event_type];
      arr.push({ at: r.at, site: r.site ?? "ogiam.com", blocked: r.blocked === true, tool: r.tool ?? undefined, clientType: r.ctype ?? undefined, hosting: r.hosting ?? undefined, signals: sig ? [sig] : [] });
    }
    const out = { ...EMPTY_INTEL, operators: byFp.size, topCampaigns: [] as AgentIntelSummary["topCampaigns"] };
    const campaigns: AgentIntelSummary["topCampaigns"] = [];
    for (const [fp, events] of byFp) {
      const a = analyzeAgent(events);
      if (a.crossSite.campaign) { out.campaigns++; campaigns.push({ fp: fp.slice(0, 10), sites: a.crossSite.sites, clientClass: a.client.clientClass, rhythm: a.cadence.rhythm }); }
      if (a.client.clientClass === "automation_framework") out.automationFleet++;
      else if (a.client.clientClass === "ai_agent") out.aiAgents++;
      else if (a.client.clientClass === "script") out.scripts++;
      if (a.adaptive.reaction === "persisted") out.persistedAfterBlock++;
      else if (a.adaptive.reaction === "escalated") out.escalatedAfterBlock++;
      if (events.some((e) => e.hosting === "datacenter")) out.datacenterOperators++;
    }
    out.topCampaigns = campaigns.sort((x, y) => y.sites.length - x.sites.length).slice(0, 6);
    return out;
  } catch (err) {
    console.warn("[agent-operators] liveAgentIntelligence failed:", (err as Error).message);
    return EMPTY_INTEL;
  }
}
