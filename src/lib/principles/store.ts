/**
 * Principles store — Postgres CRUD for the platform tables.
 *
 * Strict reads (safeQuery) for list/get; transactional writes via
 * pool.connect for the sync job's upsert + retire flow so a partial
 * failure can't leave principles half-rotated. Shadow-mode (no
 * DATABASE_URL) returns empty arrays from reads and throws from writes
 * — same contract as the rest of the lib.
 */

import { pool, safeQuery, writeQuery, WriteQueryError } from "@/lib/db";
import type { ParsedPrinciple } from "@/lib/principles/parser";

export type SignalKind = "signal" | "counter";

export interface PrincipleRecord {
  id: string;
  slug: string;
  title: string;
  domains: string[];
  owner: string | null;
  bodyMd: string;
  scoreboardWeight: number;
  sourceUrl: string | null;
  sourceDocHash: string | null;
  effectiveAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrincipleSignalRecord {
  id: string;
  principleId: string;
  kind: SignalKind;
  description: string;
  validatorId: string | null;
  createdAt: string;
}

interface PrincipleRow {
  id: string;
  slug: string;
  title: string;
  domains: string[];
  owner: string | null;
  body_md: string;
  scoreboard_weight: number;
  source_url: string | null;
  source_doc_hash: string | null;
  effective_at: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SignalRow {
  id: string;
  principle_id: string;
  kind: SignalKind;
  description: string;
  validator_id: string | null;
  created_at: string;
}

const SELECT_COLS =
  "id, slug, title, domains, owner, body_md, scoreboard_weight, source_url, " +
  "source_doc_hash, effective_at, retired_at, created_at, updated_at";

function rowToPrinciple(row: PrincipleRow): PrincipleRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    domains: Array.isArray(row.domains) ? row.domains : [],
    owner: row.owner,
    bodyMd: row.body_md,
    scoreboardWeight: row.scoreboard_weight,
    sourceUrl: row.source_url,
    sourceDocHash: row.source_doc_hash,
    effectiveAt: row.effective_at,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSignal(row: SignalRow): PrincipleSignalRecord {
  return {
    id: row.id,
    principleId: row.principle_id,
    kind: row.kind,
    description: row.description,
    validatorId: row.validator_id,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listActivePrinciples(): Promise<PrincipleRecord[]> {
  const result = await safeQuery<PrincipleRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_principles
      WHERE retired_at IS NULL
      ORDER BY scoreboard_weight DESC, title ASC`,
    [],
  );
  return result.rows.map(rowToPrinciple);
}

export async function getActivePrincipleBySlug(
  slug: string,
): Promise<PrincipleRecord | null> {
  if (!slug) return null;
  const result = await safeQuery<PrincipleRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_principles
      WHERE slug = $1 AND retired_at IS NULL
      LIMIT 1`,
    [slug],
  );
  return result.rows[0] ? rowToPrinciple(result.rows[0]) : null;
}

export async function listSignalsForPrinciple(
  principleId: string,
): Promise<PrincipleSignalRecord[]> {
  if (!principleId) return [];
  const result = await safeQuery<SignalRow>(
    `SELECT id, principle_id, kind, description, validator_id, created_at
       FROM instinct_principle_signals
      WHERE principle_id = $1
      ORDER BY kind ASC, created_at ASC`,
    [principleId],
  );
  return result.rows.map(rowToSignal);
}

/* ------------------------------------------------------------------ */
/* Sync (transactional upsert + retire)                                */
/* ------------------------------------------------------------------ */

export interface SyncOutcome {
  /** principles inserted (new slug or replacing prior). */
  inserted: PrincipleRecord[];
  /** principles updated in place because content matched the existing
   *  active row's hash + body — no new version row created. */
  unchanged: PrincipleRecord[];
  /** principles whose active row was retired because they no longer
   *  exist in the parsed doc. */
  retired: PrincipleRecord[];
}

/**
 * Reconcile the parsed-doc state with the active principles in the DB.
 *
 * Algorithm (one Postgres transaction):
 *   1. Load all currently-active principles by slug.
 *   2. For each parsed principle:
 *      - If no active row with that slug exists → INSERT new row +
 *        INSERT signals. Track in `inserted`.
 *      - If active row exists and source_doc_hash matches → no-op,
 *        track in `unchanged` (saves write churn).
 *      - If active row exists but content differs → set retired_at on
 *        the prior row, INSERT new row + signals, track in `inserted`.
 *   3. For each active row whose slug no longer appears in the parsed
 *      set → set retired_at, track in `retired`.
 *
 * Caller maps SyncOutcome → analytics events (principle.added/
 * .updated / .retired) so the learning loop sees policy churn.
 */
export async function syncPrinciplesFromParsed(args: {
  parsed: ParsedPrinciple[];
  sourceUrl: string;
  sourceDocHash: string;
}): Promise<SyncOutcome> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "syncPrinciplesFromParsed requires DATABASE_URL",
      "no_database",
    );
  }
  const { parsed, sourceUrl, sourceDocHash } = args;
  const inserted: PrincipleRecord[] = [];
  const unchanged: PrincipleRecord[] = [];
  const retired: PrincipleRecord[] = [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Step 1 — load active state. */
    const activeRes = await client.query<PrincipleRow>(
      `SELECT ${SELECT_COLS}
         FROM instinct_principles
        WHERE retired_at IS NULL`,
    );
    const activeBySlug = new Map<string, PrincipleRow>();
    for (const r of activeRes.rows) activeBySlug.set(r.slug, r);

    const parsedSlugs = new Set(parsed.map((p) => p.slug));

    /* Step 2 — insert / update / no-op per parsed principle. */
    for (const p of parsed) {
      const active = activeBySlug.get(p.slug);
      if (active && active.source_doc_hash === sourceDocHash) {
        unchanged.push(rowToPrinciple(active));
        continue;
      }

      if (active) {
        await client.query(
          `UPDATE instinct_principles
              SET retired_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [active.id],
        );
      }

      const ins = await client.query<PrincipleRow>(
        `INSERT INTO instinct_principles
           (slug, title, domains, owner, body_md, scoreboard_weight,
            source_url, source_doc_hash, effective_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${SELECT_COLS}`,
        [
          p.slug,
          p.title,
          p.domains,
          p.owner,
          p.bodyMd,
          p.scoreboardWeight,
          sourceUrl,
          sourceDocHash,
          p.effectiveAt,
        ],
      );
      const newRow = ins.rows[0];
      inserted.push(rowToPrinciple(newRow));

      /* Signals: emit one row per signal/counter-signal. validator_id
         is left null at insert time; a separate registry pass maps
         descriptions to validator ids in the framework layer. */
      for (const desc of p.signals) {
        await client.query(
          `INSERT INTO instinct_principle_signals
             (principle_id, kind, description)
           VALUES ($1, 'signal', $2)`,
          [newRow.id, desc],
        );
      }
      for (const desc of p.counterSignals) {
        await client.query(
          `INSERT INTO instinct_principle_signals
             (principle_id, kind, description)
           VALUES ($1, 'counter', $2)`,
          [newRow.id, desc],
        );
      }
    }

    /* Step 3 — retire principles whose slug disappeared from the doc. */
    for (const [slug, row] of activeBySlug) {
      if (parsedSlugs.has(slug)) continue;
      await client.query(
        `UPDATE instinct_principles
            SET retired_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [row.id],
      );
      retired.push(rowToPrinciple({ ...row, retired_at: new Date().toISOString() }));
    }

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  return { inserted, unchanged, retired };
}

/* ------------------------------------------------------------------ */
/* Doc-version history                                                 */
/* ------------------------------------------------------------------ */

export interface DocVersionRecord {
  id: string;
  sourceUrl: string;
  docHash: string;
  fetchedAt: string;
  parsedPrincipleCount: number;
  parseWarnings: string[];
  triggeredBy: "cron" | "manual";
}

interface DocVersionRow {
  id: string;
  source_url: string;
  doc_hash: string;
  fetched_at: string;
  parsed_principle_count: number;
  parse_warnings_jsonb: string[];
  triggered_by: "cron" | "manual";
}

function rowToDocVersion(row: DocVersionRow): DocVersionRecord {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    docHash: row.doc_hash,
    fetchedAt: row.fetched_at,
    parsedPrincipleCount: row.parsed_principle_count,
    parseWarnings: Array.isArray(row.parse_warnings_jsonb)
      ? row.parse_warnings_jsonb
      : [],
    triggeredBy: row.triggered_by,
  };
}

export async function getLatestDocVersion(
  sourceUrl: string,
): Promise<DocVersionRecord | null> {
  if (!sourceUrl) return null;
  const result = await safeQuery<DocVersionRow>(
    `SELECT id, source_url, doc_hash, fetched_at, parsed_principle_count,
            parse_warnings_jsonb, triggered_by
       FROM instinct_principle_doc_versions
      WHERE source_url = $1
      ORDER BY fetched_at DESC
      LIMIT 1`,
    [sourceUrl],
  );
  return result.rows[0] ? rowToDocVersion(result.rows[0]) : null;
}

export async function recordDocVersion(args: {
  sourceUrl: string;
  docHash: string;
  parsedPrincipleCount: number;
  parseWarnings: string[];
  triggeredBy: "cron" | "manual";
}): Promise<DocVersionRecord> {
  const result = await writeQuery<DocVersionRow>(
    `INSERT INTO instinct_principle_doc_versions
       (source_url, doc_hash, parsed_principle_count,
        parse_warnings_jsonb, triggered_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id, source_url, doc_hash, fetched_at, parsed_principle_count,
               parse_warnings_jsonb, triggered_by`,
    [
      args.sourceUrl,
      args.docHash,
      args.parsedPrincipleCount,
      JSON.stringify(args.parseWarnings),
      args.triggeredBy,
    ],
  );
  return rowToDocVersion(result.rows[0]);
}
