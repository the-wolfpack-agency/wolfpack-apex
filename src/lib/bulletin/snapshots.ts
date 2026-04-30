/**
 * Bulletin snapshots — CRUD helpers for `instinct_bulletin_snapshots`.
 *
 * A snapshot is a "frozen PNG" of a board, captured client-side
 * (e.g. via `html2canvas`) and POSTed up as base64. The bytes are
 * stored inline as BYTEA — boards are small enough at agency scale
 * (a few KB to a few hundred KB per snapshot) that running blob
 * storage end-to-end is overkill.
 *
 * Snapshots can carry the same optional cross-surface association
 * shape as notes — when set, the snapshot becomes a meeting artifact
 * / task attachment / goal milestone proof that other Instinct
 * surfaces can render via `findSnapshotsByAssociation`.
 *
 * The snapshot interface intentionally OMITS `pngBytes` — meta-only
 * lists never load the bytes (cheaper queries, no accidental memory
 * blow-ups). The bytes are streamed via `getSnapshotPng` only.
 */

import { writeQuery, safeQuery } from "@/lib/db";

export type BulletinAssociationKind =
  | "task"
  | "goal"
  | "meeting"
  | "discussion"
  | "calendar_event";

export interface BulletinSnapshot {
  id: string;
  boardId: string;
  associationKind: BulletinAssociationKind | null;
  associationId: string | null;
  associationLabel: string | null;
  createdByUserId: string;
  createdAt: string;
}

interface BulletinSnapshotRow {
  id: string;
  board_id: string;
  association_kind: BulletinAssociationKind | null;
  association_id: string | null;
  association_label: string | null;
  created_by_user_id: string;
  created_at: string;
}

const META_COLS =
  "id, board_id, association_kind, association_id, association_label, " +
  "created_by_user_id, created_at";

const ALLOWED_KINDS: ReadonlySet<BulletinAssociationKind> = new Set([
  "task",
  "goal",
  "meeting",
  "discussion",
  "calendar_event",
]);

function rowToMeta(row: BulletinSnapshotRow): BulletinSnapshot {
  return {
    id: row.id,
    boardId: row.board_id,
    associationKind: row.association_kind,
    associationId: row.association_id,
    associationLabel: row.association_label,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

function validateKind(kind: string): BulletinAssociationKind {
  if (!ALLOWED_KINDS.has(kind as BulletinAssociationKind)) {
    throw new Error(
      `association.kind must be one of: ${Array.from(ALLOWED_KINDS).join(", ")}`,
    );
  }
  return kind as BulletinAssociationKind;
}

export async function saveSnapshot(args: {
  boardId: string;
  pngBytes: Uint8Array;
  association?: { kind: string; id: string; label?: string | null };
  userId: string;
}): Promise<BulletinSnapshot> {
  if (!args.boardId) throw new Error("boardId is required");
  if (!args.userId) throw new Error("userId is required");
  if (!args.pngBytes || args.pngBytes.length === 0) {
    throw new Error("pngBytes is required");
  }

  let kind: BulletinAssociationKind | null = null;
  let assocId: string | null = null;
  let assocLabel: string | null = null;
  if (args.association) {
    kind = validateKind(args.association.kind);
    if (!args.association.id || typeof args.association.id !== "string") {
      throw new Error("association.id is required");
    }
    assocId = args.association.id;
    assocLabel = args.association.label ?? null;
  }

  /* pg's BYTEA bind expects a Buffer. Wrap the Uint8Array — same
     underlying memory, no copy. */
  const buf = Buffer.from(
    args.pngBytes.buffer,
    args.pngBytes.byteOffset,
    args.pngBytes.byteLength,
  );

  const result = await writeQuery<BulletinSnapshotRow>(
    `INSERT INTO instinct_bulletin_snapshots
       (board_id, png_bytes, association_kind, association_id,
        association_label, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${META_COLS}`,
    [args.boardId, buf, kind, assocId, assocLabel, args.userId],
    { expectRows: 1 },
  );
  return rowToMeta(result.rows[0]);
}

export async function listSnapshots(
  boardId: string,
): Promise<BulletinSnapshot[]> {
  if (!boardId) return [];
  const result = await safeQuery<BulletinSnapshotRow>(
    `SELECT ${META_COLS}
       FROM instinct_bulletin_snapshots
      WHERE board_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [boardId],
  );
  return result.rows.map(rowToMeta);
}

export async function getSnapshotPng(
  id: string,
): Promise<{ bytes: Uint8Array; createdAt: string } | null> {
  if (!id) return null;
  const result = await safeQuery<{
    png_bytes: Buffer | Uint8Array | null;
    created_at: string;
  }>(
    `SELECT png_bytes, created_at
       FROM instinct_bulletin_snapshots
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row || !row.png_bytes) return null;
  /* pg returns Buffer for BYTEA. Cast/copy into a Uint8Array view so
     callers don't depend on Node-specific Buffer in their types. */
  const bytes =
    row.png_bytes instanceof Uint8Array
      ? row.png_bytes
      : new Uint8Array(row.png_bytes as ArrayBufferLike);
  return { bytes, createdAt: row.created_at };
}

export async function findSnapshotsByAssociation(
  kind: string,
  id: string,
): Promise<BulletinSnapshot[]> {
  if (!kind || !id) return [];
  if (!ALLOWED_KINDS.has(kind as BulletinAssociationKind)) return [];
  const result = await safeQuery<BulletinSnapshotRow>(
    `SELECT ${META_COLS}
       FROM instinct_bulletin_snapshots
      WHERE association_kind = $1
        AND association_id = $2
      ORDER BY created_at DESC
      LIMIT 200`,
    [kind, id],
  );
  return result.rows.map(rowToMeta);
}
