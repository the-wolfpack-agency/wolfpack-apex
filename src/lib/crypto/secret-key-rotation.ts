/**
 * secret-key-rotation.ts - survey and re-encrypt at-rest secrets under the
 * primary key (INSTINCT_SECRET_KEY). The operator script
 * scripts/rotate-secret-key.ts does the connecting and printing; this file
 * decides and writes, so both are tested against a real Postgres
 * (src/db/__tests__/secret-key-rotation.db.test.ts).
 *
 * SAFETY
 *   - checkRotationKey refuses unless THIS shell has a valid primary key. A
 *     `vercel env pull` redaction placeholder is refused by name.
 *   - proveAppKey refuses --apply unless the shell's primary key id is the one
 *     the deployed app is using: either a stored value already carries that
 *     key id and opens, or the app has reported it
 *     (security.secret_key_primary_active). Rotating under a key the app does
 *     not hold would make every rotated value unreadable to it.
 *   - Every value is decrypted, re-encrypted with the primary key, and the new
 *     token is decrypted again and compared before it is written.
 *   - Each UPDATE is conditional on the column still holding the exact value
 *     read, so a concurrent write by the app always wins.
 *   - Small transactions. A crash loses at most the batch in flight, and a
 *     re-run picks up whatever is still not under the primary key, so the
 *     backfill is idempotent and resumable by construction.
 *   - Nothing here returns or logs plaintext, ciphertext or key material.
 */

import type { ClientBase } from "pg";
import {
  decryptSecretWithInfo,
  encryptSecretWithPrimary,
  parseSecretKeyMaterial,
  secretKeyId,
} from "@/lib/crypto/secret-storage";

export interface RotationTarget {
  table: string;
  /** Primary key column (cast to text for the update guard). */
  pk: string;
  columns: string[];
}

/** Every column written through encryptSecret / sealGraphToken (sealStoredToken). */
export const ROTATION_TARGETS: RotationTarget[] = [
  { table: "instinct_connector_credentials", pk: "id", columns: ["auth_header_enc", "refresh_token_enc"] },
  { table: "instinct_ms_tokens", pk: "id", columns: ["access_token", "refresh_token"] },
  { table: "instinct_qbo_tokens", pk: "id", columns: ["access_token", "refresh_token"] },
  { table: "instinct_delegation_issuers", pk: "id", columns: ["secret"] },
  { table: "instinct_admin_mfa", pk: "id", columns: ["encrypted_secret"] },
  { table: "instinct_workspace_model_keys", pk: "id", columns: ["encrypted_key"] },
  { table: "instinct_tenant_registry", pk: "tenant_id", columns: ["db_url_encrypted"] },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;

function assertIdent(s: string): string {
  if (!IDENT.test(s)) throw new Error(`invalid identifier in rotation target`);
  return s;
}

export type ValueClass = "primary" | "previous" | "legacy" | "plaintext" | "unreadable";

export interface ColumnCounts {
  table: string;
  column: string;
  /** False when the table or column does not exist in this database. */
  present: boolean;
  primary: number;
  previous: number;
  legacy: number;
  plaintext: number;
  unreadable: number;
}

export function classifyValue(stored: string): ValueClass {
  const r = decryptSecretWithInfo(stored);
  if (!r.ok) return "unreadable";
  if (r.format !== "v1") return "plaintext";
  return r.keyClass;
}

export type RotationKeyCheck =
  | { ok: true; primaryKid: string }
  | { ok: false; reason: "no_primary_key" | "redacted_placeholder" | "invalid_primary_key" };

/** Is there a usable primary key in THIS environment? */
export function checkRotationKey(env: NodeJS.ProcessEnv): RotationKeyCheck {
  const raw = env.INSTINCT_SECRET_KEY;
  if (!raw) return { ok: false, reason: "no_primary_key" };
  if (/SENSITIVE|REDACTED|^\s*\[.*\]\s*$/i.test(raw)) return { ok: false, reason: "redacted_placeholder" };
  const key = parseSecretKeyMaterial(raw);
  if (!key) return { ok: false, reason: "invalid_primary_key" };
  return { ok: true, primaryKid: secretKeyId(key) };
}

interface Row {
  pk: string;
  v: string;
}

async function readColumn(db: ClientBase, t: RotationTarget, column: string): Promise<Row[] | null> {
  const table = assertIdent(t.table);
  const pk = assertIdent(t.pk);
  const col = assertIdent(column);
  try {
    const { rows } = await db.query<Row>(
      `SELECT ${pk}::text AS pk, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY ${pk}::text`,
    );
    return rows;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "42P01" || code === "42703") return null; // table / column absent here
    throw err;
  }
}

/** Count values per table.column by which key opens them. Read-only. */
export async function surveySecrets(db: ClientBase, targets: RotationTarget[] = ROTATION_TARGETS): Promise<ColumnCounts[]> {
  const out: ColumnCounts[] = [];
  for (const t of targets) {
    for (const column of t.columns) {
      const counts: ColumnCounts = { table: t.table, column, present: true, primary: 0, previous: 0, legacy: 0, plaintext: 0, unreadable: 0 };
      const rows = await readColumn(db, t, column);
      if (rows === null) {
        counts.present = false;
      } else {
        for (const r of rows) counts[classifyValue(r.v)]++;
      }
      out.push(counts);
    }
  }
  return out;
}

export type AppKeyProof =
  | { ok: true; via: "stored_value" | "app_event" }
  | { ok: false; reason: "app_key_not_observed" | "app_reports_different_key" };

/**
 * Prove the deployed app encrypts with the same primary key as this shell.
 * A stored value carrying the shell's key id that opens is proof; so is the
 * app's own security.secret_key_primary_active report naming that id.
 */
export async function proveAppKey(
  db: ClientBase,
  primaryKid: string,
  targets: RotationTarget[] = ROTATION_TARGETS,
): Promise<AppKeyProof> {
  for (const t of targets) {
    for (const column of t.columns) {
      const rows = await readColumn(db, t, column);
      for (const r of rows ?? []) {
        if (!r.v.startsWith(`v1.${primaryKid}.`)) continue;
        const opened = decryptSecretWithInfo(r.v);
        if (opened.ok && opened.format === "v1" && opened.keyClass === "primary") return { ok: true, via: "stored_value" };
      }
    }
  }
  try {
    const { rows } = await db.query<{ kid: string | null }>(
      `SELECT metadata->>'primary_kid' AS kid FROM instinct_events
        WHERE event_type = 'security.secret_key_primary_active'
        ORDER BY timestamp DESC LIMIT 1`,
    );
    if (rows.length > 0) {
      return rows[0].kid === primaryKid ? { ok: true, via: "app_event" } : { ok: false, reason: "app_reports_different_key" };
    }
  } catch {
    /* no events table in this environment */
  }
  return { ok: false, reason: "app_key_not_observed" };
}

export interface RotationResult {
  rotated: number;
  /** Rows whose value changed between read and write (the app won). */
  skippedConcurrent: number;
  /** Values that could not be opened with any key; left untouched. */
  unreadable: number;
  /** Values whose re-encryption failed the round-trip proof; left untouched. */
  roundTripFailures: number;
  perColumn: { table: string; column: string; rotated: number }[];
}

export interface RotateOptions {
  batchSize?: number;
  /** Test seam: called before each batch commits; a throw aborts the run there. */
  beforeCommit?: (batchIndex: number) => void | Promise<void>;
}

/**
 * Re-encrypt every legacy- or previous-key value under the primary key.
 * Plaintext values are reported by surveySecrets and left alone (they have
 * their own sealing paths). Throws only on a database error or a beforeCommit
 * abort, after rolling back the batch in flight.
 */
export async function rotateSecrets(
  db: ClientBase,
  targets: RotationTarget[] = ROTATION_TARGETS,
  opts: RotateOptions = {},
): Promise<RotationResult> {
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 25, 500));
  const result: RotationResult = { rotated: 0, skippedConcurrent: 0, unreadable: 0, roundTripFailures: 0, perColumn: [] };
  let batchIndex = 0;

  for (const t of targets) {
    for (const column of t.columns) {
      const rows = await readColumn(db, t, column);
      const col = { table: t.table, column, rotated: 0 };
      result.perColumn.push(col);
      if (!rows) continue;

      const planned: { pk: string; prev: string; next: string }[] = [];
      for (const r of rows) {
        const opened = decryptSecretWithInfo(r.v);
        if (!opened.ok) {
          result.unreadable++;
          continue;
        }
        if (opened.format !== "v1" || opened.keyClass === "primary") continue;
        const next = encryptSecretWithPrimary(opened.value);
        const proof = decryptSecretWithInfo(next);
        if (!proof.ok || proof.format !== "v1" || proof.keyClass !== "primary" || proof.value !== opened.value) {
          result.roundTripFailures++;
          continue;
        }
        planned.push({ pk: r.pk, prev: r.v, next });
      }

      const table = assertIdent(t.table);
      const pk = assertIdent(t.pk);
      const c = assertIdent(column);
      for (let i = 0; i < planned.length; i += batchSize) {
        const batch = planned.slice(i, i + batchSize);
        await db.query("BEGIN");
        try {
          let n = 0;
          for (const u of batch) {
            const res = await db.query(`UPDATE ${table} SET ${c} = $1 WHERE ${pk}::text = $2 AND ${c} = $3`, [u.next, u.pk, u.prev]);
            if ((res.rowCount ?? 0) > 0) n++;
            else result.skippedConcurrent++;
          }
          if (opts.beforeCommit) await opts.beforeCommit(batchIndex);
          await db.query("COMMIT");
          col.rotated += n;
          result.rotated += n;
        } catch (err) {
          await db.query("ROLLBACK").catch(() => {});
          throw err;
        }
        batchIndex++;
      }
    }
  }
  return result;
}

/** Totals across columns, for the "is rotation finished" check. */
export function totals(counts: ColumnCounts[]): Omit<ColumnCounts, "table" | "column" | "present"> {
  const t = { primary: 0, previous: 0, legacy: 0, plaintext: 0, unreadable: 0 };
  for (const c of counts) {
    t.primary += c.primary;
    t.previous += c.previous;
    t.legacy += c.legacy;
    t.plaintext += c.plaintext;
    t.unreadable += c.unreadable;
  }
  return t;
}
