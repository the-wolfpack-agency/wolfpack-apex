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
import { slugifyForStore } from "@/lib/principles/parser-slug";

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

export async function getActivePrincipleById(
  id: string,
): Promise<PrincipleRecord | null> {
  if (!id) return null;
  const result = await safeQuery<PrincipleRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_principles
      WHERE id = $1 AND retired_at IS NULL
      LIMIT 1`,
    [id],
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

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

export interface ObservationRecord {
  id: string;
  principleId: string;
  signalId: string | null;
  validatorId: string;
  surface: string;
  surfaceSubtype: string | null;
  subjectUserId: string | null;
  observedAt: string;
  score: number;
  evidenceJsonb: Record<string, unknown>;
}

interface ObservationRow {
  id: string;
  principle_id: string;
  signal_id: string | null;
  validator_id: string;
  surface: string;
  surface_subtype: string | null;
  subject_user_id: string | null;
  observed_at: string;
  score: string;
  evidence_jsonb: Record<string, unknown>;
}

function rowToObservation(row: ObservationRow): ObservationRecord {
  return {
    id: row.id,
    principleId: row.principle_id,
    signalId: row.signal_id,
    validatorId: row.validator_id,
    surface: row.surface,
    surfaceSubtype: row.surface_subtype,
    subjectUserId: row.subject_user_id,
    observedAt: row.observed_at,
    score: Number(row.score),
    evidenceJsonb: row.evidence_jsonb || {},
  };
}

/** Returns true if any observation has been recorded for `validatorId`.
 *  The cron uses this to detect a "first run" and widen the eval window
 *  to 30 days so leadership gets an immediate baseline rather than a
 *  blank scoreboard. */
export async function hasAnyObservationForValidator(
  validatorId: string,
): Promise<boolean> {
  if (!validatorId) return false;
  const result = await safeQuery<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM instinct_principle_observations
        WHERE validator_id = $1
        LIMIT 1
     ) AS exists`,
    [validatorId],
  );
  return Boolean(result.rows[0]?.exists);
}

/** Bulk insert observations (one transaction, one INSERT ... VALUES). */
export async function insertObservations(args: {
  principleId: string;
  signalId: string | null;
  validatorId: string;
  rows: Array<{
    surface: string;
    surfaceSubtype?: string | null;
    subjectUserId?: string | null;
    observedAt: string;
    score: number;
    evidenceJsonb: Record<string, unknown>;
  }>;
}): Promise<number> {
  if (args.rows.length === 0) return 0;
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "insertObservations requires DATABASE_URL",
      "no_database",
    );
  }
  /* In-memory dedupe: when the same evaluation produces two identical
     rows (e.g. multiple signal lines on the same principle binding to
     the same validator), collapse them before the INSERT. Natural key
     mirrors migration 122's UNIQUE index — minute granularity on
     observed_at + the evidence sourceId — so two cron firings within
     the same minute also collapse here. */
  const seenKeys = new Set<string>();
  const dedupedRows: typeof args.rows = [];
  for (const r of args.rows) {
    const observedMinute = (() => {
      const ms = Date.parse(
        typeof r.observedAt === "string" && r.observedAt
          ? r.observedAt
          : new Date().toISOString(),
      );
      if (!Number.isFinite(ms)) return r.observedAt ?? "";
      return new Date(Math.floor(ms / 60000) * 60000).toISOString();
    })();
    const sourceId =
      (r.evidenceJsonb as Record<string, unknown> | undefined)?.["sourceId"] ??
      "";
    const key = [
      args.principleId,
      args.validatorId,
      r.subjectUserId ?? "",
      r.surfaceSubtype ?? "",
      observedMinute,
      String(sourceId),
    ].join("|");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    dedupedRows.push(r);
  }
  args = { ...args, rows: dedupedRows };
  if (args.rows.length === 0) return 0;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  args.rows.forEach((r, i) => {
    const base = i * 9;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::jsonb)`,
    );
    /* Persist the validator's observedAt (e.g. the email's
       sentDateTime) instead of letting the DB default to NOW(). The
       UI displays this column, so showing insert time here was
       misleading — leadership couldn't tell if a 4 PM "drift" row was
       a real after-hours send or just when the cron ran. Fall back to
       NOW()-equivalent (current ISO) when the validator emits a
       blank, so the NOT NULL constraint is satisfied. */
    const observedAt =
      typeof r.observedAt === "string" && r.observedAt
        ? r.observedAt
        : new Date().toISOString();
    values.push(
      args.principleId,
      args.signalId,
      args.validatorId,
      r.surface,
      r.surfaceSubtype ?? null,
      r.subjectUserId ?? null,
      observedAt,
      /* score range is enforced at the DB layer (-1..1); clamp here
         so a buggy validator can't trip the constraint. */
      Math.max(-1, Math.min(1, r.score)),
      JSON.stringify(r.evidenceJsonb || {}),
    );
  });
  /* ON CONFLICT DO NOTHING against migration-122's unique natural-key
     index. Two cron firings (periodic + on-edit re-eval) producing the
     same rollup observation now silently no-op the duplicate — the
     rowCount returned is the count of rows that *actually* inserted. */
  const sql =
    `INSERT INTO instinct_principle_observations
       (principle_id, signal_id, validator_id, surface, surface_subtype,
        subject_user_id, observed_at, score, evidence_jsonb)
     VALUES ${placeholders.join(",")}
     ON CONFLICT DO NOTHING`;
  const result = (await writeQuery(sql, values)) as unknown as {
    rowCount?: number;
  };
  return result.rowCount ?? args.rows.length;
}

/** Read observations scoped to a subject user. Used by /api/principles/me
 *  for member self-views (subjectUserId === caller.id). */
export async function listObservationsForSubject(
  subjectUserId: string,
  opts: { sinceISO?: string; limit?: number } = {},
): Promise<ObservationRecord[]> {
  if (!subjectUserId) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const params: unknown[] = [subjectUserId];
  let where = "subject_user_id = $1";
  if (opts.sinceISO) {
    params.push(opts.sinceISO);
    where += ` AND observed_at >= $${params.length}`;
  }
  params.push(limit);
  const result = await safeQuery<ObservationRow>(
    `SELECT id, principle_id, signal_id, validator_id, surface,
            surface_subtype, subject_user_id, observed_at, score,
            evidence_jsonb
       FROM instinct_principle_observations
      WHERE ${where}
      ORDER BY observed_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToObservation);
}

/** Read all observations (leadership-only — caller must enforce). */
export async function listAllObservations(opts: {
  sinceISO?: string;
  limit?: number;
} = {}): Promise<ObservationRecord[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const params: unknown[] = [];
  let where = "TRUE";
  if (opts.sinceISO) {
    params.push(opts.sinceISO);
    where = `observed_at >= $1`;
  }
  params.push(limit);
  const result = await safeQuery<ObservationRow>(
    `SELECT id, principle_id, signal_id, validator_id, surface,
            surface_subtype, subject_user_id, observed_at, score,
            evidence_jsonb
       FROM instinct_principle_observations
      WHERE ${where}
      ORDER BY observed_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToObservation);
}

/* ------------------------------------------------------------------ */
/* Native CRUD                                                         */
/*                                                                     */
/* Lets leadership create / edit / retire principles directly in the   */
/* UI instead of round-tripping through SharePoint. The sync flow      */
/* (syncPrinciplesFromParsed) still works for orgs that prefer to      */
/* mirror an existing doc — these helpers operate on the same tables   */
/* and respect the same retired_at soft-delete contract.               */
/* ------------------------------------------------------------------ */

export interface NativePrincipleInput {
  title: string;
  domains: string[];
  owner: string | null;
  bodyMd: string;
  scoreboardWeight: number;
  effectiveAt: string | null;
  signals: string[];
  counterSignals: string[];
}

export interface NativePrinciplePatch {
  id: string;
  title?: string;
  domains?: string[];
  owner?: string | null;
  bodyMd?: string;
  scoreboardWeight?: number;
  effectiveAt?: string | null;
  /** When provided, all signals/counter-signals for the principle are
   *  replaced. To leave them untouched, omit the field entirely. */
  signals?: string[];
  counterSignals?: string[];
}

/** Insert a brand-new principle. Throws when an active row with the
 *  same slug already exists. */
export async function createPrincipleNative(
  input: NativePrincipleInput,
): Promise<PrincipleRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "createPrincipleNative requires DATABASE_URL",
      "no_database",
    );
  }
  const title = input.title.trim();
  if (!title) {
    throw new Error("title required");
  }
  const slug = slugifyForStore(title);
  if (!slug) {
    throw new Error("title must produce a non-empty slug");
  }
  const domains = (input.domains || []).map((d) => d.trim()).filter(Boolean);
  const signals = (input.signals || []).map((s) => s.trim()).filter(Boolean);
  const counterSignals = (input.counterSignals || [])
    .map((s) => s.trim())
    .filter(Boolean);
  const weight = Number.isFinite(input.scoreboardWeight)
    ? input.scoreboardWeight
    : 1;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dup = await client.query(
      `SELECT id FROM instinct_principles
        WHERE slug = $1 AND retired_at IS NULL
        LIMIT 1`,
      [slug],
    );
    if (dup.rows.length > 0) {
      throw new Error(`principle with slug "${slug}" already exists`);
    }
    const ins = await client.query<PrincipleRow>(
      `INSERT INTO instinct_principles
         (slug, title, domains, owner, body_md, scoreboard_weight,
          source_url, source_doc_hash, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7)
       RETURNING ${SELECT_COLS}`,
      [
        slug,
        title,
        domains,
        input.owner,
        input.bodyMd || "",
        weight,
        input.effectiveAt,
      ],
    );
    const row = ins.rows[0];
    for (const desc of signals) {
      await client.query(
        `INSERT INTO instinct_principle_signals
           (principle_id, kind, description)
         VALUES ($1, 'signal', $2)`,
        [row.id, desc],
      );
    }
    for (const desc of counterSignals) {
      await client.query(
        `INSERT INTO instinct_principle_signals
           (principle_id, kind, description)
         VALUES ($1, 'counter', $2)`,
        [row.id, desc],
      );
    }
    await client.query("COMMIT");
    return rowToPrinciple(row);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Update an existing principle in-place. Only fields present on the
 *  patch are touched. If signals or counterSignals is provided, ALL
 *  signal rows for the principle are replaced atomically. */
export async function patchPrincipleNative(
  patch: NativePrinciplePatch,
): Promise<PrincipleRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "patchPrincipleNative requires DATABASE_URL",
      "no_database",
    );
  }
  if (!patch.id) {
    throw new Error("id required");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  function add(col: string, value: unknown) {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("title cannot be empty");
    add("title", title);
    const slug = slugifyForStore(title);
    if (!slug) throw new Error("title must produce a non-empty slug");
    add("slug", slug);
  }
  if (patch.domains !== undefined) {
    add(
      "domains",
      patch.domains.map((d) => d.trim()).filter(Boolean),
    );
  }
  if (patch.owner !== undefined) add("owner", patch.owner);
  if (patch.bodyMd !== undefined) add("body_md", patch.bodyMd);
  if (patch.scoreboardWeight !== undefined) {
    add(
      "scoreboard_weight",
      Number.isFinite(patch.scoreboardWeight) ? patch.scoreboardWeight : 1,
    );
  }
  if (patch.effectiveAt !== undefined) add("effective_at", patch.effectiveAt);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Slug-uniqueness guard when title changes — make sure another
       active row hasn't already claimed the new slug. */
    if (patch.title !== undefined) {
      const newSlug = slugifyForStore(patch.title.trim());
      const dup = await client.query(
        `SELECT id FROM instinct_principles
          WHERE slug = $1 AND retired_at IS NULL AND id <> $2
          LIMIT 1`,
        [newSlug, patch.id],
      );
      if (dup.rows.length > 0) {
        throw new Error(`principle with slug "${newSlug}" already exists`);
      }
    }

    let row: PrincipleRow;
    if (sets.length > 0) {
      sets.push("updated_at = NOW()");
      params.push(patch.id);
      const sql = `UPDATE instinct_principles
                      SET ${sets.join(", ")}
                    WHERE id = $${params.length} AND retired_at IS NULL
                    RETURNING ${SELECT_COLS}`;
      const res = await client.query<PrincipleRow>(sql, params);
      if (res.rows.length === 0) {
        throw new Error("principle not found or already retired");
      }
      row = res.rows[0];
    } else {
      const res = await client.query<PrincipleRow>(
        `SELECT ${SELECT_COLS} FROM instinct_principles
          WHERE id = $1 AND retired_at IS NULL
          LIMIT 1`,
        [patch.id],
      );
      if (res.rows.length === 0) {
        throw new Error("principle not found or already retired");
      }
      row = res.rows[0];
    }

    if (patch.signals !== undefined || patch.counterSignals !== undefined) {
      await client.query(
        `DELETE FROM instinct_principle_signals WHERE principle_id = $1`,
        [row.id],
      );
      const sigs = (patch.signals || [])
        .map((s) => s.trim())
        .filter(Boolean);
      const counters = (patch.counterSignals || [])
        .map((s) => s.trim())
        .filter(Boolean);
      for (const desc of sigs) {
        await client.query(
          `INSERT INTO instinct_principle_signals
             (principle_id, kind, description)
           VALUES ($1, 'signal', $2)`,
          [row.id, desc],
        );
      }
      for (const desc of counters) {
        await client.query(
          `INSERT INTO instinct_principle_signals
             (principle_id, kind, description)
           VALUES ($1, 'counter', $2)`,
          [row.id, desc],
        );
      }
    }

    await client.query("COMMIT");
    return rowToPrinciple(row);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Soft-delete a principle. Existing observations stay so the
 *  scoreboard keeps history. Reversible only by inserting a new row
 *  with the same slug. */
export async function retirePrincipleNative(id: string): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "retirePrincipleNative requires DATABASE_URL",
      "no_database",
    );
  }
  if (!id) throw new Error("id required");
  await writeQuery(
    `UPDATE instinct_principles
        SET retired_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND retired_at IS NULL`,
    [id],
  );
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
