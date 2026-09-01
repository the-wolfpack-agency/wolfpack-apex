/**
 * How a week is actually spent, from the synced calendar.
 *
 *   npm run insights:calendar-load
 *   npm run insights:calendar-load -- --days 30
 */
import "./load-env";

import { query } from "@/lib/db";
import { summarizeLoad, describeLoad, type LoadEvent } from "@/lib/insights/calendar-load";

async function main() {
  const i = process.argv.indexOf("--days");
  const days = i > -1 ? Number(process.argv[i + 1]) || 90 : 90;

  const { rows } = await query<{
    person: string;
    subject: string | null;
    start_at: string | null;
    end_at: string | null;
    attendees: string;
    organizer_email: string | null;
  }>(
    `SELECT user_id AS person, subject, start_at::text, end_at::text, organizer_email,
            jsonb_array_length(coalesce(attendees, '[]'::jsonb))::text AS attendees
       FROM instinct_ms_events
      WHERE deleted_at IS NULL
        AND start_at >= now() - ($1 || ' days')::interval
        AND start_at < now()`,
    [String(days)],
  );

  const events: LoadEvent[] = rows.map((r) => ({
    person: r.person,
    subject: r.subject,
    startAt: r.start_at,
    endAt: r.end_at,
    attendeeCount: Number(r.attendees),
    organizer: r.organizer_email,
  }));

  console.log(describeLoad(summarizeLoad(events, days)));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
