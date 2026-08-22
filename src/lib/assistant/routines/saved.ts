/**
 * Chains people kept.
 *
 * The built-in catalogue is three routines written by us. This is where the
 * ones somebody saved from their own described day live, and the reason the
 * offer at the end of a plan leads anywhere.
 *
 * VALIDATED ON THE WAY OUT, NOT ONLY ON THE WAY IN
 *
 * A row is JSON written by a previous deploy. Trusting it because it was
 * trustworthy when written is how a shape change turns into a runner crash on
 * somebody's Monday morning. Every routine read back is re-checked, and one
 * that no longer makes sense is dropped rather than repaired: a half-understood
 * chain that runs is worse than one that does not appear.
 */
import { BUILT_IN_ROUTINES } from "./catalogue";
import type { Routine, RoutineStep } from "./types";

export interface SavedRoutineOwner {
  workspaceId: string;
  userId: string;
}

/** Commands nobody may take, because they already mean something. */
export function isReservedCommand(command: string): boolean {
  return BUILT_IN_ROUTINES.some((r) => r.command === command.trim().toLowerCase());
}

/**
 * Is this step shape one the runner can still execute?
 *
 * Deliberately strict. Anything unrecognised makes the whole routine
 * unreadable rather than being skipped, because a chain silently missing its
 * third step still runs, still reports success, and quietly stopped doing part
 * of somebody's job.
 */
function validStep(v: unknown): v is RoutineStep {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  if (typeof s.label !== "string" || s.label.length === 0) return false;
  if (s.kind === "human") return s.action === undefined || s.action === "do" || s.action === "review";
  if (s.kind === "tool") return typeof s.tool === "string" && s.tool.length > 0 && typeof s.params === "object";
  if (s.kind === "model") return typeof s.prompt === "string" && s.prompt.length > 0;
  return false;
}

/** A stored row turned back into a routine, or null when it no longer parses. */
export function rowToRoutine(row: {
  id: string;
  command: string;
  description: string;
  steps: unknown;
}): Routine | null {
  const raw = typeof row.steps === "string" ? safeParse(row.steps) : row.steps;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every(validStep)) return null;
  return {
    id: row.id,
    command: row.command,
    description: row.description,
    audience: "anyone",
    steps: raw as RoutineStep[],
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Keep a routine for somebody.
 *
 * Returns a plain reason on refusal rather than throwing, because the caller is
 * a sentence in a chat window and every refusal here is something the person
 * can fix by saying something different.
 */
export async function saveRoutine(
  owner: SavedRoutineOwner,
  routine: Routine,
  origin: "proposed" | "authored" = "proposed",
): Promise<{ ok: true; command: string } | { ok: false; reason: string }> {
  const command = routine.command.trim().toLowerCase();
  if (command.length < 3) return { ok: false, reason: "that command is too short to be memorable" };
  if (isReservedCommand(command)) {
    return {
      ok: false,
      reason: `"${command}" is already one of the built-in routines, so I would be shadowing it`,
    };
  }
  if (!routine.steps.every(validStep)) {
    return { ok: false, reason: "one of the steps is not something I can run" };
  }
  if (!process.env.DATABASE_URL) return { ok: false, reason: "routines cannot be saved in this environment" };

  try {
    const { query } = await import("@/lib/db");
    /* A second save of the same command REPLACES the first. The alternative is
       a duplicate that shadows it forever, and somebody wondering why editing
       their routine changed nothing. */
    await query(
      `INSERT INTO assistant_saved_routines
         (id, workspace_id, user_id, command, description, steps, origin)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (workspace_id, user_id, command) WHERE active
       DO UPDATE SET description = EXCLUDED.description,
                     steps       = EXCLUDED.steps,
                     origin      = EXCLUDED.origin`,
      [
        `${owner.workspaceId}:${owner.userId}:${command}`,
        owner.workspaceId,
        owner.userId,
        command,
        routine.description,
        JSON.stringify(routine.steps),
        origin,
      ],
    );
    return { ok: true, command };
  } catch {
    return { ok: false, reason: "the routine could not be written just now" };
  }
}

/** Everything this person saved, newest first. Never throws. */
export async function listSavedRoutines(owner: SavedRoutineOwner): Promise<Routine[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<{ id: string; command: string; description: string; steps: unknown }>(
      `SELECT id, command, description, steps
         FROM assistant_saved_routines
        WHERE workspace_id = $1 AND user_id = $2 AND active
        ORDER BY created_at DESC
        LIMIT 50`,
      [owner.workspaceId, owner.userId],
    );
    return rows.map(rowToRoutine).filter((r): r is Routine => r !== null);
  } catch {
    return [];
  }
}

/**
 * The saved routine this message names, if any.
 *
 * Built-ins are matched first by the caller, so this only ever sees messages
 * that were not one of ours. Exact match, same as the catalogue: a chain that
 * fires because somebody's sentence resembled its name is worse than one that
 * did not recognise itself.
 */
export async function matchSavedRoutine(
  owner: SavedRoutineOwner,
  message: string,
): Promise<Routine | null> {
  if (message.length > 120) return null;
  const text = normalise(message);
  if (!text) return null;
  const saved = await listSavedRoutines(owner);
  return saved.find((r) => r.command === text) ?? null;
}

/** Same normalisation the catalogue uses, and linear for the same reason. */
function normalise(message: string): string {
  let text = message.trim().toLowerCase();
  for (const prefix of ["please ", "can you ", "could you "]) {
    while (text.startsWith(prefix)) text = text.slice(prefix.length).trimStart();
  }
  let end = text.length;
  while (end > 0 && (text[end - 1] === "." || text[end - 1] === "!" || text[end - 1] === "?")) end -= 1;
  return text.slice(0, end).trim();
}
