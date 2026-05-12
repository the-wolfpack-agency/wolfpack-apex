/**
 * Relationship-strength scoring for a contact.
 *
 * Composite score across:
 *   1. Sent-mail volume from Stream A's instinct_sent_mail (if table exists)
 *   2. Calendar attendance from Stream A's instinct_calendar_events (if exists)
 *   3. File shares where the contact's email is referenced in the share's
 *      before/after audit state (best-effort; future work: explicit recipient
 *      tracking).
 *
 * If Stream A tables don't exist yet, those components contribute 0 and
 * the function returns a partial score flagged in `components`.
 */

 

import { safeQuery } from "@/lib/db";

export interface RelationshipStrength {
  userId: string;
  contactEmail: string;
  /** 0..1 composite score. */
  score: number;
  /** Breakdown — callers can display "partial" if flags.sentMailAvailable is false. */
  components: {
    sentMailCount: number;
    sentMailAvailable: boolean;
    meetingCount: number;
    meetingDataAvailable: boolean;
    shareCount: number;
  };
  windowDays: number;
}

async function tableExists(tableName: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { rows } = await safeQuery<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = $1
       ) AS exists`,
      [tableName],
    );
    return rows[0]?.exists === true;
  } catch {
    return false;
  }
}

/**
 * Compute a 0..1 relationship strength for (userId, contactEmail) over
 * the last `windowDays` days. Handles missing Stream A tables gracefully.
 */
export async function getRelationshipStrength(
  userId: string,
  contactEmail: string,
  windowDays = 90,
): Promise<RelationshipStrength> {
  const cappedWindow = Math.max(1, Math.min(365, windowDays));
  const email = (contactEmail ?? "").trim().toLowerCase();
  if (!email) {
    return {
      userId,
      contactEmail,
      score: 0,
      components: {
        sentMailCount: 0,
        sentMailAvailable: false,
        meetingCount: 0,
        meetingDataAvailable: false,
        shareCount: 0,
      },
      windowDays: cappedWindow,
    };
  }

  // --- Sent mail (Stream A table) ------------------------------------------------
  let sentMailCount = 0;
  const sentMailAvailable = await tableExists("instinct_sent_mail");
  if (sentMailAvailable) {
    try {
      const { rows } = await safeQuery<any>(
        `SELECT COUNT(*)::int AS c
         FROM instinct_sent_mail
         WHERE user_id = $1
           AND sent_at >= NOW() - INTERVAL '1 day' * $2
           AND to_recipients::text ILIKE $3`,
        [userId, cappedWindow, `%${email}%`],
      );
      sentMailCount = Number(rows[0]?.c ?? 0);
    } catch {
      sentMailCount = 0;
    }
  }

  // --- Calendar attendance (Stream A table) ------------------------------------
  let meetingCount = 0;
  const meetingDataAvailable = await tableExists("instinct_calendar_events");
  if (meetingDataAvailable) {
    try {
      const { rows } = await safeQuery<any>(
        `SELECT COUNT(*)::int AS c
         FROM instinct_calendar_events
         WHERE user_id = $1
           AND start_at >= NOW() - INTERVAL '1 day' * $2
           AND attendees::text ILIKE $3`,
        [userId, cappedWindow, `%${email}%`],
      );
      meetingCount = Number(rows[0]?.c ?? 0);
    } catch {
      meetingCount = 0;
    }
  }

  // --- Shares — best-effort audit-log scan ----------------------------------------
  let shareCount = 0;
  try {
    const { rows } = await safeQuery<any>(
      `SELECT COUNT(*)::int AS c
       FROM instinct_audit_log
       WHERE action = 'files.share_created'
         AND actor_user_id = $1
         AND ts >= NOW() - INTERVAL '1 day' * $2
         AND (after_state::text ILIKE $3)`,
      [userId, cappedWindow, `%${email}%`],
    );
    shareCount = Number(rows[0]?.c ?? 0);
  } catch {
    shareCount = 0;
  }

  // --- Composite score -----------------------------------------------------------
  // Each component saturates around its "strong signal" threshold; we sum
  // weighted contributions and clamp to 1.
  const mailSig = Math.min(1, sentMailCount / 20);          // 20+ mails = strong
  const meetingSig = Math.min(1, meetingCount / 5);          // 5+ meetings = strong
  const shareSig = Math.min(1, shareCount / 3);              // 3+ shares = strong
  const weights = {
    mail: sentMailAvailable ? 0.5 : 0,
    meeting: meetingDataAvailable ? 0.3 : 0,
    share: 0.2,
  };
  const totalWeight = weights.mail + weights.meeting + weights.share;
  const raw = weights.mail * mailSig + weights.meeting * meetingSig + weights.share * shareSig;
  const score = totalWeight > 0 ? Math.min(1, raw / totalWeight) : 0;

  return {
    userId,
    contactEmail,
    score,
    components: {
      sentMailCount,
      sentMailAvailable,
      meetingCount,
      meetingDataAvailable,
      shareCount,
    },
    windowDays: cappedWindow,
  };
}
