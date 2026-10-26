/**
 * at-rest-seal-backfill.ts - seal any value in a sealed-at-rest column that is
 * not sealed yet (QuickBooks tokens, delegation issuer secrets). Driven by
 * scripts/seal-at-rest-secrets.ts; the logic lives here so it is tested
 * against a real Postgres (src/db/__tests__/at-rest-seal-backfill.db.test.ts).
 *
 * The app seals every value it writes and re-seals an unsealed value the first
 * time it reads one. This exists for rows nobody reads, so "every value is
 * sealed" is made true on purpose rather than eventually. Same sealer and
 * reader as the Graph tokens (graph-token-storage.ts).
 *
 * SAFETY
 *   - checkKey refuses unless every value the app ALREADY sealed (this table
 *     and up to 20 per other ROTATION_TARGETS column) opens with this shell's
 *     key. A `vercel env pull` redaction placeholder is refused by name.
 *   - When this shell has a primary key (INSTINCT_SECRET_KEY), --apply also
 *     needs proveAppKey: the deployed app must be using that same key id.
 *   - Every sealed value is opened again and compared before it is written.
 *   - Each UPDATE is conditional on every target column still holding the
 *     value read, so a concurrent app write always wins. Only the target
 *     columns are written (no updated_at).
 *   - Idempotent: a re-run counts sealed rows as already sealed and writes
 *     nothing. Nothing here returns or logs a secret value.
 */

import type { ClientBase } from "pg";
import { checkKey, type KeyCheck } from "@/lib/crypto/graph-token-backfill";
import { openStoredToken, sealStoredToken } from "@/lib/crypto/graph-token-storage";
import { ROTATION_TARGETS, checkRotationKey, proveAppKey } from "@/lib/crypto/secret-key-rotation";

export interface SealTarget {
  table: string;
  pk: string;
  columns: string[];
  /** Non-secret columns copied into the per-row event (which row was sealed). */
  labels: string[];
  event: "security.qbo_token_encrypted" | "security.delegation_secret_encrypted";
}

export const SEAL_TARGETS = {
  qbo_tokens: {
    table: "instinct_qbo_tokens",
    pk: "id",
    columns: ["access_token", "refresh_token"],
    labels: ["realm_id"],
    event: "security.qbo_token_encrypted",
  },
  delegation_issuers: {
    table: "instinct_delegation_issuers",
    pk: "id",
    columns: ["secret"],
    labels: ["workspace_id", "issuer"],
    event: "security.delegation_secret_encrypted",
  },
} as const satisfies Record<string, SealTarget>;

export type SealTargetName = keyof typeof SEAL_TARGETS;

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error("invalid identifier in seal target");
  return s;
}

export type SealKeyCheck =
  | (Extract<KeyCheck, { ok: true }> & { appKey: "stored_value" | "app_event" | "no_primary_in_shell" })
  | Extract<KeyCheck, { ok: false }>
  | { ok: false; reason: "app_key_not_observed" | "app_reports_different_key" };

export interface SealReport {
  table: string;
  /** False when the table does not exist in this database. */
  present: boolean;
  applied: boolean;
  rows: number;
  /** Rows whose every non-empty target value is already sealed. */
  alreadySealed: number;
  /** Rows with no value to protect (e.g. an es256 issuer has no secret). */
  empty: number;
  /** Rows holding at least one value that is not sealed (planned). */
  toSeal: number;
  /** Rows written sealed by this run (0 on a dry run or a refusal). */
  sealed: number;
  /** unreadable + roundTripFailures + skippedConcurrent. */
  failed: number;
  unreadable: number;
  roundTripFailures: number;
  skippedConcurrent: number;
  key: SealKeyCheck;
}

type Row = Record<string, string | null> & { __pk: string };

async function sampleSealedValues(db: ClientBase): Promise<string[]> {
  const out: string[] = [];
  for (const t of ROTATION_TARGETS) {
    for (const c of t.columns) {
      try {
        const { rows } = await db.query<{ v: string }>(
          `SELECT ${ident(c)} AS v FROM ${ident(t.table)} WHERE ${ident(c)} LIKE 'v1.%' LIMIT 20`,
        );
        out.push(...rows.map((r) => r.v));
      } catch {
        /* table or column absent in this environment */
      }
    }
  }
  return out;
}

async function checkShellKey(db: ClientBase, env: NodeJS.ProcessEnv, samples: string[]): Promise<SealKeyCheck> {
  const key = checkKey(env, samples);
  if (!key.ok) return key;
  const primary = checkRotationKey(env);
  if (!primary.ok) return { ...key, appKey: "no_primary_in_shell" };
  const proof = await proveAppKey(db, primary.primaryKid);
  if (!proof.ok) return proof;
  return { ...key, appKey: proof.via };
}

/**
 * Survey (apply=false, read-only) or seal (apply=true) one target. Throws only
 * on a database error.
 */
export async function sealAtRest(
  db: ClientBase,
  target: SealTarget,
  opts: { apply: boolean; env?: NodeJS.ProcessEnv },
): Promise<SealReport> {
  const env = opts.env ?? process.env;
  const report: SealReport = {
    table: target.table,
    present: true,
    applied: false,
    rows: 0,
    alreadySealed: 0,
    empty: 0,
    toSeal: 0,
    sealed: 0,
    failed: 0,
    unreadable: 0,
    roundTripFailures: 0,
    skippedConcurrent: 0,
    key: { ok: false, reason: "no_sealed_sample" },
  };
  const table = ident(target.table);
  const pk = ident(target.pk);
  const cols = target.columns.map(ident);
  const labels = target.labels.map(ident);

  let rows: Row[];
  try {
    rows = (await db.query<Row>(`SELECT ${pk}::text AS __pk, ${[...labels, ...cols].join(", ")} FROM ${table} ORDER BY ${pk}::text`)).rows;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") {
      report.present = false;
      return report;
    }
    throw err;
  }
  report.rows = rows.length;

  const samples = [...rows.flatMap((r) => cols.map((c) => r[c]).filter((v): v is string => !!v)), ...(await sampleSealedValues(db))];
  report.key = await checkShellKey(db, env, samples);

  const planned: { row: Row; next: Record<string, string> }[] = [];
  for (const row of rows) {
    const next: Record<string, string> = {};
    let unreadable = false;
    let present = 0;
    for (const c of cols) {
      const opened = openStoredToken(row[c]);
      if (!opened.ok) {
        unreadable = true;
        break;
      }
      if (opened.format === "empty" || opened.value === null) continue;
      present++;
      if (opened.format === "legacy_plaintext") next[c] = sealStoredToken(opened.value);
    }
    if (unreadable) report.unreadable++;
    else if (present === 0) report.empty++;
    else if (Object.keys(next).length === 0) report.alreadySealed++;
    else planned.push({ row, next });
  }
  report.toSeal = planned.length;

  if (opts.apply && report.key.ok) {
    report.applied = true;
    for (const { row, next } of planned) {
      /* Round-trip proof: each sealed value opens to exactly what was read. */
      const proven = Object.entries(next).every(([c, sealed]) => {
        const before = openStoredToken(row[c]);
        const after = openStoredToken(sealed);
        return before.ok && after.ok && after.format === "sealed" && after.value === before.value;
      });
      if (!proven) {
        report.roundTripFailures++;
        continue;
      }
      const params: (string | null)[] = [];
      const set = Object.entries(next).map(([c, sealed]) => {
        params.push(sealed);
        return `${c} = $${params.length}`;
      });
      params.push(row.__pk);
      const guards = [`${pk}::text = $${params.length}`];
      for (const c of cols) {
        params.push(row[c]);
        guards.push(`${c} IS NOT DISTINCT FROM $${params.length}`);
      }
      const res = await db.query(`UPDATE ${table} SET ${set.join(", ")} WHERE ${guards.join(" AND ")}`, params);
      if ((res.rowCount ?? 0) === 0) {
        report.skippedConcurrent++;
        continue;
      }
      report.sealed++;
      const metadata: Record<string, string | null> = { source: "operator_script" };
      for (const l of labels) metadata[l] = row[l];
      await db
        .query(`INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp) VALUES ($1, 'system', 'system', $2, $3)`, [
          target.event,
          JSON.stringify(metadata),
          new Date().toISOString(),
        ])
        .catch(() => {
          /* the event records the write; it is never a reason to undo it */
        });
    }
  }

  report.failed = report.unreadable + report.roundTripFailures + report.skippedConcurrent;
  return report;
}
