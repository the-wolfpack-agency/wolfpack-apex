/**
 * Calendar provider — 30-day window centered on today (7 days back,
 * 23 forward). Matches event subject, attendee names, and location.
 */

import { fetchCalendarEvents } from "@/lib/microsoft-graph";
import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { matches } from "./util";

async function search(
  query: string,
  perTypeLimit: number,
  ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  const end = new Date(now);
  end.setDate(end.getDate() + 23);
  const events = await fetchCalendarEvents(
    ctx.userId,
    start.toISOString(),
    end.toISOString(),
  );
  const out: SearchResult[] = [];
  for (const ev of events) {
    const attendees = ev.attendees.join(", ");
    if (matches(ev.subject, query) || matches(attendees, query) || matches(ev.location, query)) {
      out.push({
        type: "calendar",
        id: ev.id,
        title: ev.subject || "(no subject)",
        snippet: [ev.location, attendees ? `with ${attendees}` : ""]
          .filter(Boolean)
          .join(" · "),
        timestamp: ev.start,
        url: ev.webLink || `/calendar?event=${encodeURIComponent(ev.id)}`,
      });
      if (out.length >= perTypeLimit) break;
    }
  }
  return out;
}

export const calendarProvider: SearchProvider = {
  type: "calendar",
  name: "Outlook calendar",
  countKey: "calendar",
  isEnabled: () => true,
  search,
};
