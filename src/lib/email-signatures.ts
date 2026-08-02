/**
 * Email signatures — per-user CRUD against `instinct_email_signatures`.
 *
 * Used by the /emails composer to:
 *   - Pre-fill a fresh email with the user's default signature.
 *   - Insert a chosen signature at the cursor position when the user
 *     clicks the "Signature" dropdown in the toolbar.
 *   - Insert a signature ABOVE the quoted-original block on a reply or
 *     forward (so the signature is part of the user's new content, not
 *     of the message they're replying to).
 *
 * Persistence rules:
 *   - At most ONE row per user_id may have is_default=TRUE. Enforced at
 *     the DB layer via the partial unique index `uq_email_signatures_one_default_per_user`.
 *   - createSignature() with isDefault=true demotes the prior default
 *     atomically inside a transaction so concurrent writers can't end
 *     up with two defaults.
 *   - updateSignature() and deleteSignature() are scoped by user_id so a
 *     user cannot mutate another user's signatures.
 *
 * Shadow mode: when DATABASE_URL is unset, list/getDefault return empty
 * results; create/update/delete throw via writeQuery (writes require a
 * real database — silent shadow-mode writes have caused data-loss bugs
 * in this codebase before, see feedback_no_silent_data_loss).
 */

import { activePool, safeQuery, writeQuery, WriteQueryError } from "@/lib/db";
import type { PoolClient } from "pg";

export type SignatureBodyFormat = "text" | "html";

export interface EmailSignature {
  id: string;
  userId: string;
  label: string;
  body: string;
  bodyFormat: SignatureBodyFormat;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface EmailSignatureRow {
  id: string;
  user_id: string;
  label: string;
  body: string;
  body_format: SignatureBodyFormat;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS =
  "id, user_id, label, body, body_format, is_default, created_at, updated_at";

function rowToSignature(row: EmailSignatureRow): EmailSignature {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    body: row.body,
    /* Older rows pre-migration 114 had no body_format column. The
       SELECT will return undefined for those; default to 'text' so
       the composer keeps treating them as plain text. */
    bodyFormat: row.body_format === "html" ? "html" : "text",
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const LABEL_MAX = 80;
/* 200KB ceiling. HTML signatures with inlined data: URIs (logo +
   social icons base64 embedded) routinely run 30–80KB; 200KB gives
   headroom for retina logos. The DB column is plain TEXT so this is
   purely a validation guard against runaway input. */
const BODY_MAX = 200_000;

export function validateSignatureInput(input: {
  label?: unknown;
  body?: unknown;
  bodyFormat?: unknown;
}): { label: string; body: string; bodyFormat: SignatureBodyFormat } {
  if (typeof input.label !== "string" || !input.label.trim()) {
    throw new Error("label is required");
  }
  if (typeof input.body !== "string" || !input.body.trim()) {
    throw new Error("body is required");
  }
  const label = input.label.trim();
  const body = input.body.trim();
  if (label.length > LABEL_MAX) {
    throw new Error(`label is too long (max ${LABEL_MAX})`);
  }
  if (body.length > BODY_MAX) {
    throw new Error(`body is too long (max ${BODY_MAX})`);
  }
  let bodyFormat: SignatureBodyFormat = "text";
  if (input.bodyFormat === "html") bodyFormat = "html";
  else if (input.bodyFormat === "text" || input.bodyFormat === undefined)
    bodyFormat = "text";
  else throw new Error("bodyFormat must be 'text' or 'html'");
  return { label, body, bodyFormat };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listSignatures(userId: string): Promise<EmailSignature[]> {
  if (!userId) return [];
  const result = await safeQuery<EmailSignatureRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_email_signatures
      WHERE user_id = $1
      ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return result.rows.map(rowToSignature);
}

export async function getDefaultSignature(
  userId: string,
): Promise<EmailSignature | null> {
  if (!userId) return null;
  const result = await safeQuery<EmailSignatureRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_email_signatures
      WHERE user_id = $1 AND is_default = TRUE
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? rowToSignature(result.rows[0]) : null;
}

export async function getSignatureById(
  id: string,
  userId: string,
): Promise<EmailSignature | null> {
  if (!id || !userId) return null;
  const result = await safeQuery<EmailSignatureRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_email_signatures
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [id, userId],
  );
  return result.rows[0] ? rowToSignature(result.rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Demote any existing default for `userId` to `is_default=FALSE` inside
 * an open transaction. Used by createSignature and updateSignature when
 * the caller is promoting a row to default.
 */
async function demoteDefaultsTx(
  client: PoolClient,
  userId: string,
  exceptId: string | null,
): Promise<void> {
  if (exceptId) {
    await client.query(
      `UPDATE instinct_email_signatures
          SET is_default = FALSE, updated_at = NOW()
        WHERE user_id = $1 AND is_default = TRUE AND id <> $2`,
      [userId, exceptId],
    );
  } else {
    await client.query(
      `UPDATE instinct_email_signatures
          SET is_default = FALSE, updated_at = NOW()
        WHERE user_id = $1 AND is_default = TRUE`,
      [userId],
    );
  }
}

export async function createSignature(args: {
  userId: string;
  label: string;
  body: string;
  bodyFormat?: SignatureBodyFormat;
  isDefault?: boolean;
}): Promise<EmailSignature> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "createSignature requires DATABASE_URL",
      "no_database",
    );
  }
  if (!args.userId) throw new Error("userId is required");
  const { label, body, bodyFormat } = validateSignatureInput(args);
  const isDefault = !!args.isDefault;

  const client = await activePool().connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await demoteDefaultsTx(client, args.userId, null);
    }
    const result = await client.query<EmailSignatureRow>(
      `INSERT INTO instinct_email_signatures
         (user_id, label, body, body_format, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLS}`,
      [args.userId, label, body, bodyFormat, isDefault],
    );
    await client.query("COMMIT");
    return rowToSignature(result.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function updateSignature(
  id: string,
  userId: string,
  patch: {
    label?: string;
    body?: string;
    bodyFormat?: SignatureBodyFormat;
    isDefault?: boolean;
  },
): Promise<EmailSignature> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "updateSignature requires DATABASE_URL",
      "no_database",
    );
  }
  if (!id || !userId) throw new Error("id and userId are required");

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || !patch.label.trim()) {
      throw new Error("label is required");
    }
    if (patch.label.trim().length > LABEL_MAX) {
      throw new Error(`label is too long (max ${LABEL_MAX})`);
    }
    params.push(patch.label.trim());
    sets.push(`label = $${params.length}`);
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== "string" || !patch.body.trim()) {
      throw new Error("body is required");
    }
    if (patch.body.trim().length > BODY_MAX) {
      throw new Error(`body is too long (max ${BODY_MAX})`);
    }
    params.push(patch.body.trim());
    sets.push(`body = $${params.length}`);
  }
  if (patch.bodyFormat !== undefined) {
    if (patch.bodyFormat !== "text" && patch.bodyFormat !== "html") {
      throw new Error("bodyFormat must be 'text' or 'html'");
    }
    params.push(patch.bodyFormat);
    sets.push(`body_format = $${params.length}`);
  }

  const promoteToDefault = patch.isDefault === true;
  const demoteFromDefault = patch.isDefault === false;
  if (promoteToDefault || demoteFromDefault) {
    params.push(promoteToDefault);
    sets.push(`is_default = $${params.length}`);
  }

  if (sets.length === 0) {
    throw new Error("updateSignature: patch is empty");
  }

  sets.push(`updated_at = NOW()`);
  params.push(id);
  const idIdx = params.length;
  params.push(userId);
  const userIdx = params.length;

  const client = await activePool().connect();
  try {
    await client.query("BEGIN");
    if (promoteToDefault) {
      await demoteDefaultsTx(client, userId, id);
    }
    const result = await client.query<EmailSignatureRow>(
      `UPDATE instinct_email_signatures
          SET ${sets.join(", ")}
        WHERE id = $${idIdx} AND user_id = $${userIdx}
        RETURNING ${SELECT_COLS}`,
      params,
    );
    if (result.rows.length !== 1) {
      await client.query("ROLLBACK");
      throw new WriteQueryError(
        `updateSignature row-count mismatch: expected 1, got ${result.rows.length}`,
        "unexpected_row_count",
        { expected: 1, actual: result.rows.length },
      );
    }
    await client.query("COMMIT");
    return rowToSignature(result.rows[0]);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteSignature(
  id: string,
  userId: string,
): Promise<{ deleted: boolean }> {
  if (!id || !userId) throw new Error("id and userId are required");
  const result = await writeQuery<EmailSignatureRow>(
    `DELETE FROM instinct_email_signatures
      WHERE id = $1 AND user_id = $2
      RETURNING ${SELECT_COLS}`,
    [id, userId],
  );
  return { deleted: result.rows.length === 1 };
}

/* ------------------------------------------------------------------ */
/* Composer helpers (pure functions — used by the React composer)      */
/* ------------------------------------------------------------------ */

/**
 * Insert `signatureBody` into `bodyText` at position `cursorPos`. If the
 * cursor is null/undefined, append two newlines + the signature to the
 * end (the typical "no cursor known" default — fresh-email mount, etc.)
 *
 * Pure function. No DOM access. Safe to use in tests.
 */
export function insertSignatureAtCursor(
  bodyText: string,
  cursorPos: number | null | undefined,
  signatureBody: string,
): string {
  const sig = signatureBody.trim();
  if (!sig) return bodyText;
  if (
    cursorPos === null ||
    cursorPos === undefined ||
    cursorPos < 0 ||
    cursorPos > bodyText.length
  ) {
    /* Append. Two newlines so the signature is visually separated. */
    if (!bodyText) return `\n\n${sig}`;
    return `${bodyText.replace(/\s+$/, "")}\n\n${sig}`;
  }
  const before = bodyText.slice(0, cursorPos);
  const after = bodyText.slice(cursorPos);
  return `${before}${sig}${after}`;
}

/**
 * Insert `signatureBody` ABOVE a quoted-original block in `bodyText`.
 * The quoted block is identified by a leading "On <date>, <name> wrote:"
 * marker (Outlook + Gmail conventions) or by a sequence of lines all
 * starting with "> " (RFC-style email quoting).
 *
 * If no quoted block is found, falls back to insertSignatureAtCursor
 * with cursor=null (i.e. append).
 *
 * Pure function — used by replies and forwards in EmailReader.
 */
export function insertSignatureAboveQuotedBlock(
  bodyText: string,
  signatureBody: string,
): string {
  const sig = signatureBody.trim();
  if (!sig) return bodyText;

  /* Pattern 1: "On <date>, <name> wrote:" — Outlook/Gmail conventions. */
  const wroteRe = /^On .{1,200} wrote:$/m;
  /* Pattern 2: "From: ..." block — Outlook reply/forward header. */
  const fromHeaderRe = /^From: .{1,200}$/m;
  /* Pattern 3: "> " quoted lines — RFC-style. */
  const quotedRe = /^> /m;

  let quoteIdx = -1;
  for (const re of [wroteRe, fromHeaderRe, quotedRe]) {
    const m = re.exec(bodyText);
    if (m && m.index !== undefined) {
      if (quoteIdx === -1 || m.index < quoteIdx) {
        quoteIdx = m.index;
      }
    }
  }

  if (quoteIdx === -1) {
    return insertSignatureAtCursor(bodyText, null, sig);
  }

  const before = bodyText.slice(0, quoteIdx).replace(/\s+$/, "");
  const after = bodyText.slice(quoteIdx);
  /* Two newlines on each side so the signature is visually separated
     from both the user's reply text and the quoted block. */
  if (!before) return `${sig}\n\n${after}`;
  return `${before}\n\n${sig}\n\n${after}`;
}
