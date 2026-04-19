/**
 * Team Journal — Daily context capture per team member.
 *
 * Every team member gets one journal per day (auto-created).
 * Auto-context captures calendar events, questions asked, and actions taken.
 * CTO view aggregates all team journals for a given date.
 */

import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface JournalEntry {
  id: string;
  user_id: string;
  date: string;
  content: string;
  auto_context: Record<string, unknown>;
  mood: string | null;
  highlights: string[];
  blockers: string[];
  created_at: string;
  updated_at: string;
}

export interface JournalUpdate {
  content?: string;
  mood?: string;
  highlights?: string[];
  blockers?: string[];
}

// ---------------------------------------------------------------------------
// Shadow mode demo data
// ---------------------------------------------------------------------------
function demoJournal(userId: string, date: string): JournalEntry {
  return {
    id: `demo-j-${userId}-${date}`,
    user_id: userId,
    date,
    content: "Shadow mode journal entry. Connect a database to persist entries.",
    auto_context: { events: [], questions: [], actions: [] },
    mood: "productive",
    highlights: ["Explored the Instinct platform"],
    blockers: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// getOrCreateJournal — UPSERT for today
// ---------------------------------------------------------------------------
export async function getOrCreateJournal(
  userId: string,
  date?: string,
): Promise<JournalEntry> {
  const targetDate = date ?? todayStr();

  if (!process.env.DATABASE_URL) {
    return demoJournal(userId, targetDate);
  }

  try {
    const result = await query<Record<string, unknown>>(
      `INSERT INTO instinct_journals (user_id, date)
       VALUES ($1, $2)
       ON CONFLICT (user_id, date) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [userId, targetDate],
    );

    trackEvent("journal.entry_created", userId, "dev", { date: targetDate });
    return rowToJournal(result.rows[0]);
  } catch (err) {
    console.error("[journal] getOrCreateJournal error:", (err as Error).message);
    return demoJournal(userId, targetDate);
  }
}

// ---------------------------------------------------------------------------
// updateJournal
// ---------------------------------------------------------------------------
export async function updateJournal(
  journalId: string,
  userId: string,
  updates: JournalUpdate,
): Promise<JournalEntry | null> {
  trackEvent("journal.entry_updated", userId, "dev", {
    journal_id: journalId,
    fields_updated: Object.keys(updates).join(","),
  });

  if (!process.env.DATABASE_URL) {
    return {
      ...demoJournal(userId, todayStr()),
      id: journalId,
      ...updates,
      mood: updates.mood ?? "productive",
      highlights: updates.highlights ?? [],
      blockers: updates.blockers ?? [],
    };
  }

  try {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.content !== undefined) {
      setClauses.push(`content = $${idx++}`);
      params.push(updates.content);
    }
    if (updates.mood !== undefined) {
      setClauses.push(`mood = $${idx++}`);
      params.push(updates.mood);
    }
    if (updates.highlights !== undefined) {
      setClauses.push(`highlights = $${idx++}`);
      params.push(updates.highlights);
    }
    if (updates.blockers !== undefined) {
      setClauses.push(`blockers = $${idx++}`);
      params.push(updates.blockers);
    }

    if (setClauses.length === 0) return null;

    setClauses.push(`updated_at = NOW()`);
    params.push(journalId, userId);

    const result = await query<Record<string, unknown>>(
      `UPDATE instinct_journals SET ${setClauses.join(", ")}
       WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING *`,
      params,
    );

    return result.rows.length > 0 ? rowToJournal(result.rows[0]) : null;
  } catch (err) {
    console.error("[journal] updateJournal error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// addAutoContext — Append to auto_context JSONB
// ---------------------------------------------------------------------------
export async function addAutoContext(
  userId: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  trackEvent("journal.context_added", userId, "dev", {
    context_type: Object.keys(context).join(","),
  });

  if (!process.env.DATABASE_URL) return true;

  try {
    const targetDate = todayStr();
    // Ensure journal exists first
    await query(
      `INSERT INTO instinct_journals (user_id, date)
       VALUES ($1, $2)
       ON CONFLICT (user_id, date) DO NOTHING`,
      [userId, targetDate],
    );

    // Merge context into auto_context JSONB
    await query(
      `UPDATE instinct_journals
       SET auto_context = auto_context || $1, updated_at = NOW()
       WHERE user_id = $2 AND date = $3`,
      [JSON.stringify(context), userId, targetDate],
    );

    return true;
  } catch (err) {
    console.error("[journal] addAutoContext error:", (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// getJournalHistory
// ---------------------------------------------------------------------------
export async function getJournalHistory(
  userId: string,
  days: number = 7,
): Promise<JournalEntry[]> {
  if (!process.env.DATABASE_URL) {
    return [demoJournal(userId, todayStr())];
  }

  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_journals
     WHERE user_id = $1 AND date >= CURRENT_DATE - $2::int
     ORDER BY date DESC`,
    [userId, days],
  );
  return rows.map(rowToJournal);
}

// ---------------------------------------------------------------------------
// getTeamJournals — CTO view
// ---------------------------------------------------------------------------
export async function getTeamJournals(date?: string): Promise<JournalEntry[]> {
  const targetDate = date ?? todayStr();

  if (!process.env.DATABASE_URL) {
    return [
      demoJournal("demo-cto", targetDate),
      demoJournal("demo-dev", targetDate),
    ];
  }

  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_journals WHERE date = $1 ORDER BY updated_at DESC`,
    [targetDate],
  );
  return rows.map(rowToJournal);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rowToJournal(row: Record<string, unknown>): JournalEntry {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    date: String(row.date),
    content: (row.content as string) ?? "",
    auto_context: (row.auto_context as Record<string, unknown>) ?? {},
    mood: (row.mood as string) ?? null,
    highlights: (row.highlights as string[]) ?? [],
    blockers: (row.blockers as string[]) ?? [],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
