/**
 * Bulletin boards — CRUD helpers for `instinct_bulletin_boards`.
 *
 * Boards are the top-level container for sticky notes. They are
 * org-shared by default: every Wolfpack member sees every board, so
 * the read paths intentionally do NOT scope by `owner_user_id`.
 * `owner_user_id` is recorded purely for audit / "who created it"
 * UI badges.
 *
 * `archived_at` flips the board into a frozen, read-only meeting
 * artifact. The lib does not enforce read-only here (callers / route
 * handlers do); this file just exposes `archiveBoard`. Notes APIs
 * (`src/lib/bulletin/notes.ts`) reject writes against archived boards.
 */

import { writeQuery, safeQuery } from "@/lib/db";

export interface BulletinBoard {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  ownerUserRole: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BulletinBoardRow {
  id: string;
  title: string;
  description: string | null;
  owner_user_id: string | null;
  owner_user_role: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBoard(row: BulletinBoardRow): BulletinBoard {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerUserRole: row.owner_user_role,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS =
  "id, title, description, owner_user_id, owner_user_role, " +
  "archived_at, created_at, updated_at";

export async function createBoard(args: {
  title: string;
  description?: string | null;
  userId: string;
  userRole: string;
}): Promise<BulletinBoard> {
  if (!args.title || typeof args.title !== "string") {
    throw new Error("title is required");
  }
  const result = await writeQuery<BulletinBoardRow>(
    `INSERT INTO instinct_bulletin_boards
       (title, description, owner_user_id, owner_user_role)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SELECT_COLS}`,
    [args.title, args.description ?? null, args.userId, args.userRole],
    { expectRows: 1 },
  );
  return rowToBoard(result.rows[0]);
}

export async function getBoard(id: string): Promise<BulletinBoard | null> {
  if (!id) return null;
  const result = await safeQuery<BulletinBoardRow>(
    `SELECT ${SELECT_COLS} FROM instinct_bulletin_boards WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ? rowToBoard(result.rows[0]) : null;
}

export async function listBoards(opts?: {
  limit?: number;
  includeArchived?: boolean;
}): Promise<BulletinBoard[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const where = opts?.includeArchived ? "" : "WHERE archived_at IS NULL";
  const result = await safeQuery<BulletinBoardRow>(
    `SELECT ${SELECT_COLS}
       FROM instinct_bulletin_boards
       ${where}
       ORDER BY created_at DESC
       LIMIT $1`,
    [limit],
  );
  return result.rows.map(rowToBoard);
}

export async function updateBoard(
  id: string,
  patch: { title?: string; description?: string | null },
): Promise<BulletinBoard | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    if (!patch.title || typeof patch.title !== "string") {
      throw new Error("title must be a non-empty string");
    }
    params.push(patch.title);
    sets.push(`title = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }

  if (sets.length === 0) {
    throw new Error("updateBoard: patch is empty");
  }

  /* Always bump updated_at so audit dashboards can sort by recency. */
  sets.push(`updated_at = NOW()`);
  params.push(id);

  try {
    const result = await writeQuery<BulletinBoardRow>(
      `UPDATE instinct_bulletin_boards
          SET ${sets.join(", ")}
        WHERE id = $${params.length}
        RETURNING ${SELECT_COLS}`,
      params,
      { expectRows: 1 },
    );
    return rowToBoard(result.rows[0]);
  } catch (err) {
    /* writeQuery throws on row-count mismatch when the id doesn't
       exist. Surface that as a `null` so callers can map to 404
       cleanly without needing to introspect WriteQueryError. */
    const msg = (err as Error).message ?? "";
    if (/unexpected_row_count|expected.*1.*got.*0/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

export async function archiveBoard(id: string): Promise<void> {
  if (!id) return;
  await writeQuery(
    `UPDATE instinct_bulletin_boards
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id],
  );
}
