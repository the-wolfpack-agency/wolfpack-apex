/**
 * Bulletin notes — CRUD helpers for `instinct_bulletin_notes`.
 *
 * Notes are sticky-note-style entries pinned to a board. Position +
 * size are stored as percentages (0..100) of the board so the layout
 * survives viewport changes — a note placed in the top-right corner
 * on a 1440px laptop renders in roughly the same place on a 768px
 * tablet.
 *
 * Optional cross-surface association lets a note point at another
 * Instinct entity (a task, a goal, a meeting, a discussion thread, a
 * calendar event). The association is intentionally not a FK — the
 * targets live in different schemas, sometimes get deleted, and we
 * want notes to outlive their referent. Callers render the
 * `association_label` they captured at creation time as the
 * authoritative display string, with the option to follow the
 * `(kind, id)` pair to the live record.
 *
 * Soft-delete via `deleted_at`. The board-page payload only ever
 * includes active notes; a deleted note is gone for all readers.
 */

import { writeQuery, safeQuery } from "@/lib/db";

export type BulletinAssociationKind =
  | "task"
  | "goal"
  | "meeting"
  | "discussion"
  | "calendar_event";

export interface BulletinAssociation {
  kind: BulletinAssociationKind;
  id: string;
  label: string | null;
}

export interface BulletinNotePosition {
  x_pct: number;
  y_pct: number;
  width_pct: number;
  height_pct: number;
  rotation_deg: number;
}

export interface BulletinNote {
  id: string;
  boardId: string;
  body: string;
  color: string;
  x_pct: number;
  y_pct: number;
  width_pct: number;
  height_pct: number;
  rotation_deg: number;
  associationKind: BulletinAssociationKind | null;
  associationId: string | null;
  associationLabel: string | null;
  createdByUserId: string;
  createdByUserRole: string | null;
  createdByUserName: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface BulletinNoteRow {
  id: string;
  board_id: string;
  body: string;
  color: string;
  x_pct: string | number;
  y_pct: string | number;
  width_pct: string | number;
  height_pct: string | number;
  rotation_deg: string | number;
  association_kind: BulletinAssociationKind | null;
  association_id: string | null;
  association_label: string | null;
  created_by_user_id: string;
  created_by_user_role: string | null;
  created_by_user_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const SELECT_COLS =
  "id, board_id, body, color, x_pct, y_pct, width_pct, height_pct, " +
  "rotation_deg, association_kind, association_id, association_label, " +
  "created_by_user_id, created_by_user_role, created_by_user_name, " +
  "created_at, updated_at, deleted_at";

const ALLOWED_KINDS: ReadonlySet<BulletinAssociationKind> = new Set([
  "task",
  "goal",
  "meeting",
  "discussion",
  "calendar_event",
]);

function toNumber(v: string | number): number {
  return typeof v === "number" ? v : Number(v);
}

function rowToNote(row: BulletinNoteRow): BulletinNote {
  return {
    id: row.id,
    boardId: row.board_id,
    body: row.body,
    color: row.color,
    x_pct: toNumber(row.x_pct),
    y_pct: toNumber(row.y_pct),
    width_pct: toNumber(row.width_pct),
    height_pct: toNumber(row.height_pct),
    rotation_deg: toNumber(row.rotation_deg),
    associationKind: row.association_kind,
    associationId: row.association_id,
    associationLabel: row.association_label,
    createdByUserId: row.created_by_user_id,
    createdByUserRole: row.created_by_user_role,
    createdByUserName: row.created_by_user_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function validateAssociation(
  assoc: { kind: string; id: string; label?: string | null } | undefined,
): BulletinAssociation | null {
  if (!assoc) return null;
  if (!ALLOWED_KINDS.has(assoc.kind as BulletinAssociationKind)) {
    throw new Error(
      `association.kind must be one of: ${Array.from(ALLOWED_KINDS).join(", ")}`,
    );
  }
  if (!assoc.id || typeof assoc.id !== "string") {
    throw new Error("association.id is required");
  }
  return {
    kind: assoc.kind as BulletinAssociationKind,
    id: assoc.id,
    label: assoc.label ?? null,
  };
}

/**
 * Throws when the target board is archived. Active notes can only be
 * created/edited on a live (un-archived) board — archived boards are
 * frozen meeting artifacts.
 */
async function assertBoardWritable(boardId: string): Promise<void> {
  const result = await safeQuery<{ archived_at: string | null }>(
    `SELECT archived_at FROM instinct_bulletin_boards WHERE id = $1 LIMIT 1`,
    [boardId],
  );
  if (!result.rows.length) {
    throw new Error("board not found");
  }
  if (result.rows[0].archived_at !== null) {
    throw new Error("board is archived (read-only)");
  }
}

export async function createNote(args: {
  boardId: string;
  body: string;
  color?: string;
  position?: Partial<BulletinNotePosition>;
  association?: { kind: string; id: string; label?: string | null };
  userId: string;
  userRole: string;
  userName?: string | null;
}): Promise<BulletinNote> {
  if (!args.boardId) throw new Error("boardId is required");
  /* Accept empty body — UI drops a blank sticky on the board so the
     user can immediately click in to type. Only reject non-string. */
  if (typeof args.body !== "string") {
    throw new Error("body must be a string");
  }
  if (!args.userId) throw new Error("userId is required");

  await assertBoardWritable(args.boardId);

  const assoc = validateAssociation(args.association);

  const pos: BulletinNotePosition = {
    x_pct: args.position?.x_pct ?? 10,
    y_pct: args.position?.y_pct ?? 10,
    width_pct: args.position?.width_pct ?? 18,
    height_pct: args.position?.height_pct ?? 14,
    rotation_deg: args.position?.rotation_deg ?? 0,
  };

  const result = await writeQuery<BulletinNoteRow>(
    `INSERT INTO instinct_bulletin_notes
       (board_id, body, color, x_pct, y_pct, width_pct, height_pct,
        rotation_deg, association_kind, association_id, association_label,
        created_by_user_id, created_by_user_role, created_by_user_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${SELECT_COLS}`,
    [
      args.boardId,
      args.body,
      args.color ?? "#ffeb3b",
      pos.x_pct,
      pos.y_pct,
      pos.width_pct,
      pos.height_pct,
      pos.rotation_deg,
      assoc?.kind ?? null,
      assoc?.id ?? null,
      assoc?.label ?? null,
      args.userId,
      args.userRole,
      args.userName ?? null,
    ],
    { expectRows: 1 },
  );
  return rowToNote(result.rows[0]);
}

export async function listNotes(
  boardId: string,
  opts?: { limit?: number },
): Promise<BulletinNote[]> {
  if (!boardId) return [];
  /* Cap board page payload at 1000 notes (defensive — the route layer
     adds pagination above this threshold). */
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
  const result = await safeQuery<BulletinNoteRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_bulletin_notes
      WHERE board_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT $2`,
    [boardId, limit],
  );
  return result.rows.map(rowToNote);
}

export async function updateNote(
  id: string,
  patch: {
    body?: string;
    color?: string;
    x_pct?: number;
    y_pct?: number;
    width_pct?: number;
    height_pct?: number;
    rotation_deg?: number;
    association?: { kind: string; id: string; label?: string | null } | null;
  },
): Promise<BulletinNote | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.body !== undefined) {
    if (!patch.body || typeof patch.body !== "string") {
      throw new Error("body must be a non-empty string");
    }
    params.push(patch.body);
    sets.push(`body = $${params.length}`);
  }
  if (patch.color !== undefined) {
    params.push(patch.color);
    sets.push(`color = $${params.length}`);
  }
  for (const field of [
    "x_pct",
    "y_pct",
    "width_pct",
    "height_pct",
    "rotation_deg",
  ] as const) {
    const v = patch[field];
    if (v !== undefined) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`${field} must be a finite number`);
      }
      params.push(v);
      sets.push(`${field} = $${params.length}`);
    }
  }
  if (patch.association !== undefined) {
    if (patch.association === null) {
      sets.push(`association_kind = NULL`);
      sets.push(`association_id = NULL`);
      sets.push(`association_label = NULL`);
    } else {
      const assoc = validateAssociation(patch.association);
      if (assoc) {
        params.push(assoc.kind);
        sets.push(`association_kind = $${params.length}`);
        params.push(assoc.id);
        sets.push(`association_id = $${params.length}`);
        params.push(assoc.label);
        sets.push(`association_label = $${params.length}`);
      }
    }
  }

  if (sets.length === 0) {
    throw new Error("updateNote: patch is empty");
  }

  /* Always bump updated_at. */
  sets.push(`updated_at = NOW()`);
  params.push(id);

  try {
    const result = await writeQuery<BulletinNoteRow>(
      `UPDATE instinct_bulletin_notes
          SET ${sets.join(", ")}
        WHERE id = $${params.length}
          AND deleted_at IS NULL
        RETURNING ${SELECT_COLS}`,
      params,
      { expectRows: 1 },
    );
    return rowToNote(result.rows[0]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/unexpected_row_count|expected.*1.*got.*0/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

export async function deleteNote(id: string): Promise<void> {
  if (!id) return;
  await writeQuery(
    `UPDATE instinct_bulletin_notes
        SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND deleted_at IS NULL`,
    [id],
  );
}

export async function findNotesByAssociation(
  kind: string,
  id: string,
): Promise<BulletinNote[]> {
  if (!kind || !id) return [];
  if (!ALLOWED_KINDS.has(kind as BulletinAssociationKind)) return [];
  const result = await safeQuery<BulletinNoteRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_bulletin_notes
      WHERE association_kind = $1
        AND association_id = $2
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 500`,
    [kind, id],
  );
  return result.rows.map(rowToNote);
}
