/**
 * Instinct L3 — MS Graph auto-tag rule engine.
 *
 * Reads (NEVER writes) from the L1 canonical table `instinct_ms_events` (owned
 * by U1 stream, migration 077) and writes polymorphic L3 tags describing
 * the shape of each event. Pure rule-based — zero tokens.
 *
 * Rules implemented in this file:
 *   1. Domain-match    — if any attendee email domain matches a known
 *                         client domain, tag (ms_event, id, "client_domain",
 *                         "<domain>", auto=true). One tag per matched
 *                         domain, so multi-client meetings get multiple tags.
 *   2. Meeting-type    — subject keywords classify the meeting type.
 *                         "demo" | "discovery" | "qbr"  → meeting_type=pipeline
 *                         "standup" | "retro"           → meeting_type=internal
 *                         (case-insensitive, whole-word match to avoid
 *                         "retrofit" matching "retro")
 *
 * Idempotency: applyTag() uses ON CONFLICT DO NOTHING against the composite
 * unique index, so re-running an auto-tag batch is a no-op for rows that
 * already have the same (entity_type, entity_id, tag_key, tag_value,
 * auto_applied=true) tuple. The rule engine COUNTS the no-ops via a
 * pre-check SELECT so the `entity.auto_tag_run` analytics event can report
 * scanned / applied / skipped_duplicate honestly.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { applyTag, getTags } from "@/lib/entity-tags";

/** Shape we need from L1. Intentionally subset — we do NOT import U1's types. */
export interface MsEventRow {
  id: string;
  subject: string | null;
  attendees: unknown; // JSONB array from L1
  start_time: string | null;
}

export interface AutoTagRunOptions {
  /** Only scan events with start_time >= this ISO timestamp. */
  since?: string;
  /**
   * Known client email domains. The default source is DB-backed (see
   * loadClientDomains), but callers can inject for tests.
   */
  clientDomains?: Set<string>;
  /** Inject MS events directly (tests). When given, DB is NOT queried. */
  events?: MsEventRow[];
  /** Skip the analytics event (tests). */
  skipAnalytics?: boolean;
}

export interface AutoTagRunResult {
  scanned: number;
  applied: number;
  skipped_duplicate: number;
}

const KW_PIPELINE = ["demo", "discovery", "qbr"];
const KW_INTERNAL = ["standup", "retro"];

export function extractDomains(attendees: unknown): string[] {
  if (!Array.isArray(attendees)) return [];
  const out = new Set<string>();
  for (const a of attendees) {
    if (!a || typeof a !== "object") continue;
    // MS Graph attendee shape: { emailAddress: { address: "x@y.com" } }
    const maybeEmail =
      (a as { emailAddress?: { address?: string } }).emailAddress?.address ??
      (a as { address?: string }).address ??
      (a as { email?: string }).email ??
      null;
    if (typeof maybeEmail !== "string") continue;
    const at = maybeEmail.lastIndexOf("@");
    if (at < 0 || at === maybeEmail.length - 1) continue;
    out.add(maybeEmail.slice(at + 1).toLowerCase().trim());
  }
  return [...out];
}

/**
 * Whole-word, case-insensitive keyword matcher. Avoids "retrofit" → "retro".
 * Exported for testability.
 */
export function subjectHasKeyword(subject: string | null, kw: string): boolean {
  if (!subject) return false;
  const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(subject);
}

export function classifyMeetingType(subject: string | null): string | null {
  if (!subject) return null;
  if (KW_PIPELINE.some((k) => subjectHasKeyword(subject, k))) return "pipeline";
  if (KW_INTERNAL.some((k) => subjectHasKeyword(subject, k))) return "internal";
  return null;
}

async function loadClientDomains(): Promise<Set<string>> {
  // Best-effort: read from a settings table if present; otherwise empty.
  // We deliberately don't join against a specific table here — the
  // canonical client-domain surface is owned elsewhere. Injection via
  // opts.clientDomains is the preferred path.
  const { rows } = await safeQuery<{ domain: string }>(
    `SELECT DISTINCT lower(domain) AS domain
       FROM instinct_client_domains
      WHERE domain IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.domain.trim()).filter(Boolean));
}

async function loadEventsForScan(since?: string): Promise<MsEventRow[]> {
  const params: unknown[] = [];
  let sql = `SELECT id, subject, attendees, start_time FROM instinct_ms_events`;
  if (since) {
    params.push(since);
    sql += ` WHERE start_time >= $${params.length}`;
  }
  sql += ` ORDER BY start_time DESC NULLS LAST LIMIT 1000`;
  const { rows } = await safeQuery<MsEventRow>(sql, params);
  return rows;
}

/**
 * Scan recent MS events and apply auto-tag rules. Safe to re-run — rows
 * whose auto-tag already exists are counted as skipped_duplicate.
 *
 * Emits:
 *   entity.auto_tag_run { scanned, applied, skipped_duplicate }
 *   entity.tag_applied { entity_type, tag_key, auto }  (per new row, via applyTag)
 */
export async function applyAutoTagsToEvents(
  userId: string,
  opts: AutoTagRunOptions = {},
): Promise<AutoTagRunResult> {
  const clientDomains =
    opts.clientDomains ?? (await loadClientDomains());

  const events = opts.events ?? (await loadEventsForScan(opts.since));

  let scanned = 0;
  let applied = 0;
  let skipped_duplicate = 0;

  for (const ev of events) {
    scanned += 1;
    const existing = await getTags("ms_event", ev.id);
    const existingKeys = new Set(
      existing
        .filter((t) => t.auto_applied)
        .map((t) => `${t.tag_key}::${t.tag_value}`),
    );

    // Rule 1: domain-match → one tag per unique matched domain.
    const domains = extractDomains(ev.attendees);
    for (const d of domains) {
      if (!clientDomains.has(d)) continue;
      const key = `client_domain::${d}`;
      if (existingKeys.has(key)) {
        skipped_duplicate += 1;
        continue;
      }
      await applyTag("ms_event", ev.id, "client_domain", d, {
        auto: true,
        userId: null,
      });
      applied += 1;
      existingKeys.add(key);
    }

    // Rule 2: meeting-type from subject keywords.
    const mt = classifyMeetingType(ev.subject);
    if (mt) {
      const key = `meeting_type::${mt}`;
      if (existingKeys.has(key)) {
        skipped_duplicate += 1;
      } else {
        await applyTag("ms_event", ev.id, "meeting_type", mt, {
          auto: true,
          userId: null,
        });
        applied += 1;
        existingKeys.add(key);
      }
    }
  }

  if (!opts.skipAnalytics) {
    trackEvent("entity.auto_tag_run", userId, "system", {
      scanned,
      applied,
      skipped_duplicate,
    });
  }

  return { scanned, applied, skipped_duplicate };
}
