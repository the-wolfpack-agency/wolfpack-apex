/**
 * How many requests one site_analytics_events row stands for. A collapsed decoy / honeytoken row
 * (recordSiteEvent folds repeats from one source into the first row of a 10-minute window) carries
 * props.repeat_count; every other row is 1. Sum this, not count(*), wherever attempts are reported.
 * Guarded: a malformed repeat_count counts as 1 instead of failing the whole query.
 */
export const EVENT_WEIGHT_SQL = "CASE WHEN props->>'repeat_count' ~ '^[0-9]{1,9}$' THEN (props->>'repeat_count')::int ELSE 1 END";

/**
 * Who an event's SOURCE is, for counting sources and operators (never for blocking). props.fp is
 * the edge's operator fingerprint: the header-ORDER shape plus the client type (fingerprint.ts),
 * a deliberate tool shape that admin blocks key on. As an identity it is too coarse: on
 * 2026-11-12 one fp value held verified Googlebot, verified ClaudeBot and verified Applebot traffic
 * and unidentified traffic from dozens of countries, so "distinct fingerprints" undercounted
 * sources and the operator analysis classed a real AI crawler's traffic as unknown. The actor is:
 *   - a verified or signed agent: the agent it proved it is ("agent:ClaudeBot");
 *   - anything else: the fingerprint (else the session key) with its country and network type,
 *     so the same tool shape from different places is counted as different actors.
 */
export const ACTOR_KEY_SQL = "CASE WHEN props->>'agent_verification' = 'verified' OR props->>'signed_agent' = 'true' THEN 'agent:' || coalesce(nullif(props->>'agent', ''), 'signed') ELSE coalesce(nullif(props->>'fp', ''), props->>'sig', '') || '|' || coalesce(country, '') || '|' || coalesce(props->>'hosting', '') END";
