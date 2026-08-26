/**
 * Which controls are being shown to people who cannot use them.
 *
 * Reads what fetchWithRefresh records. See ./role-mismatch for why the
 * recording lives at that single chokepoint.
 *
 * RANKED BY REPEAT ATTEMPTS, NOT BY VOLUME, and the distinction is the whole
 * report. One 403 can be a race, a stale tab, or a permission changed a second
 * earlier. The same person clicking the same dead control three times is the
 * product lying to them, and it is the shape that caught the real defect on
 * the Porsche build: one user, three attempts, no complaint.
 *
 * A control here is a fix on the FRONT end. The API is already correct, so
 * there is nothing to harden; the work is taking the control off that role's
 * screen, or granting the capability if it should have been theirs all along.
 * Which of those two it is, is a product decision, and the surface column is
 * what tells you where to make it.
 */
import { query } from "@/lib/db";

export interface RoleMismatch {
  /** The API route, with identifiers collapsed. */
  control: string;
  method: string;
  /** The page the person was on, which is where the control has to be removed. */
  surface: string;
  role: string;
  /** Total refused attempts. */
  attempts: number;
  /** Distinct people who hit it. */
  people: number;
  /**
   * The most attempts by any one person on this control.
   *
   * The ranking key. Somebody trying three times has told us more than three
   * people trying once each, because the repeat is the moment they decided the
   * product was broken rather than that they had mis-clicked.
   */
  worstRepeat: number;
  lastSeen: string;
}

export interface RoleMismatchReport {
  mismatches: RoleMismatch[];
  readable: boolean;
}

export async function getRoleMismatches(days = 30, limit = 25): Promise<RoleMismatchReport> {
  const boundedDays = Math.max(1, Math.min(365, Math.floor(days)));
  const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  try {
    const { rows } = await query<{
      control: string;
      method: string;
      surface: string;
      role: string;
      attempts: string;
      people: string;
      worst_repeat: string;
      last_seen: string;
    }>(
      `WITH per_person AS (
         SELECT metadata->>'control'  AS control,
                metadata->>'method'   AS method,
                metadata->>'surface'  AS surface,
                metadata->>'role'     AS role,
                user_id,
                count(*)::int          AS attempts_by_person,
                max(timestamp)         AS last_seen
           FROM instinct_events
          WHERE event_type = 'ui.role_mismatch_click'
            AND timestamp > NOW() - ($1::int * INTERVAL '1 day')
          GROUP BY 1, 2, 3, 4, 5
       )
       SELECT control, method, surface, role,
              sum(attempts_by_person)::text        AS attempts,
              count(DISTINCT user_id)::text        AS people,
              max(attempts_by_person)::text        AS worst_repeat,
              max(last_seen)::date::text           AS last_seen
         FROM per_person
        WHERE control IS NOT NULL
        GROUP BY 1, 2, 3, 4
        /* Repeat first, then reach. A control one person fought three times
           outranks one thirty people brushed past once. */
        ORDER BY max(attempts_by_person) DESC, sum(attempts_by_person) DESC
        LIMIT $2`,
      [boundedDays, boundedLimit],
    );

    return {
      readable: true,
      mismatches: rows.map((r) => ({
        control: r.control,
        method: r.method,
        surface: r.surface,
        role: r.role,
        attempts: Number(r.attempts),
        people: Number(r.people),
        worstRepeat: Number(r.worst_repeat),
        lastSeen: r.last_seen,
      })),
    };
  } catch (err) {
    /* Unreadable, not empty. An empty list here reads as "no control in the
       product lies to anybody", which is a strong claim to make by accident. */
    console.warn("[role-mismatch]", (err as Error).message);
    return { mismatches: [], readable: false };
  }
}
