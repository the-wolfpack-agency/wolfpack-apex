/**
 * Timezone helpers for Microsoft Graph dates and "today" windows.
 *
 * Two timezone bugs the CEO reported both trace back here:
 *
 *   1. The dashboard combined days (yesterday's meetings shown as today's).
 *      Cause: "today" was computed as the UTC date, and the Graph window was a
 *      24h UTC slice. For a US user that slice spans roughly [yesterday 7pm,
 *      today 7pm] local, so two local days land in one bucket. Fix:
 *      dayWindowInTimeZone() computes the user's LOCAL day as UTC instants.
 *
 *   2. Out-of-office showed a teammate out a day early. Cause: Graph returns
 *      automaticRepliesSetting scheduledStart/End as a naive wall-clock string
 *      plus a SEPARATE timeZone field (often a Windows zone like "Eastern
 *      Standard Time"), and the old code dropped the timeZone and parsed the
 *      naive string as if it were UTC. Fix: normalizeGraphDateTime() honors the
 *      timeZone and converts the wall clock to a true UTC instant.
 *
 * No new runtime dependency: all zone math uses the built-in Intl API. Windows
 * zone names (Graph's default for mailbox settings) are mapped to IANA first,
 * since Intl only understands IANA.
 */

/**
 * Minimal Windows-to-IANA timezone map. Covers the zones our team and most
 * North American + Western European clients actually use. An unmapped Windows
 * zone falls through to "leave the value as-is", which is no worse than the
 * pre-fix behavior (and is logged by callers if they choose).
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "Dateline Standard Time": "Etc/GMT+12",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Central America Standard Time": "America/Guatemala",
  "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "Atlantic Standard Time": "America/Halifax",
  "SA Pacific Standard Time": "America/Bogota",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "GTB Standard Time": "Europe/Bucharest",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
};

/** True when the string already carries a UTC Z or a numeric +/-hh:mm offset. */
function hasOffset(dateTime: string): boolean {
  return /[Zz]$/.test(dateTime) || /[+-]\d{2}:\d{2}$/.test(dateTime);
}

/** Looks like an IANA zone id ("America/New_York", "UTC", "Europe/Paris"). */
function looksLikeIana(zone: string): boolean {
  return zone === "UTC" || /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(zone);
}

/** Resolve a Graph timeZone string (Windows name or IANA) to an IANA id. */
export function resolveIanaZone(zone: string | undefined | null): string | null {
  if (!zone) return null;
  const trimmed = zone.trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase() === "UTC") return "UTC";
  if (WINDOWS_TO_IANA[trimmed]) return WINDOWS_TO_IANA[trimmed];
  if (looksLikeIana(trimmed)) return trimmed;
  return null;
}

/**
 * Offset in milliseconds (local minus UTC) for an IANA zone at a given UTC
 * instant. Positive east of UTC. Uses Intl so DST is handled correctly.
 */
function zoneOffsetMs(ianaZone: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  // hour can come back as "24" at midnight in some engines; normalize to 0.
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const wallAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return wallAsUtc - utcMs;
}

/**
 * Convert a wall-clock time IN an IANA zone to the UTC epoch ms it represents.
 * Two-pass to settle DST transitions (the offset at the naive guess can differ
 * from the offset at the resolved instant near a DST boundary).
 */
export function zonedWallClockToUtcMs(
  year: number,
  month1: number, // 1-based month
  day: number,
  hour: number,
  minute: number,
  second: number,
  ianaZone: string,
): number {
  const naiveUtc = Date.UTC(year, month1 - 1, day, hour, minute, second);
  const offset1 = zoneOffsetMs(ianaZone, naiveUtc);
  let utc = naiveUtc - offset1;
  const offset2 = zoneOffsetMs(ianaZone, utc);
  if (offset2 !== offset1) utc = naiveUtc - offset2;
  return utc;
}

/** Parse a naive "YYYY-MM-DDTHH:mm:ss(.fff)" into numeric parts. */
function parseNaiveParts(dateTime: string): {
  year: number;
  month1: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const m = dateTime.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) return null;
  return {
    year: Number(m[1]),
    month1: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
  };
}

/**
 * Normalize a Microsoft Graph dateTime + timeZone pair into a UTC ISO string
 * with a Z, so JS Date() interprets it as the correct instant.
 *
 *   - Already has Z or a numeric offset: returned unchanged.
 *   - timeZone is UTC: the naive string is UTC, so append Z.
 *   - timeZone is a known Windows or IANA zone: the naive string is wall-clock
 *     in that zone, so convert to the real UTC instant.
 *   - Unknown zone or unparseable string: returned unchanged (no worse than
 *     before; avoids inventing a wrong instant).
 */
export function normalizeGraphDateTime(
  dateTime: string,
  timeZone: string | undefined | null,
): string {
  if (!dateTime) return dateTime;
  if (hasOffset(dateTime)) return dateTime;

  const iana = resolveIanaZone(timeZone);
  if (!iana) return dateTime;
  if (iana === "UTC") return dateTime + "Z";

  const parts = parseNaiveParts(dateTime);
  if (!parts) return dateTime;
  const utcMs = zonedWallClockToUtcMs(
    parts.year,
    parts.month1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    iana,
  );
  /* Totality guard: this runs on EVERY calendar/mailbox datetime. If the zone
     math ever yields a non-finite instant, return the original string unchanged
     rather than throwing "Invalid time value" out of new Date().toISOString().
     A single bad event must never blank the whole calendar. */
  if (!Number.isFinite(utcMs)) return dateTime;
  return new Date(utcMs).toISOString();
}

export interface DayWindow {
  /** UTC ISO instant for the start of the local day (00:00:00 in the zone). */
  startUtcIso: string;
  /** UTC ISO instant for the start of the NEXT local day (exclusive end). */
  endUtcIso: string;
  /** The local calendar date the window covers, as YYYY-MM-DD. */
  localDate: string;
}

/**
 * Compute the [start, end) UTC instants for the local calendar day that
 * contains `refMs` in `timeZone`. Falls back to UTC when the zone is unknown.
 *
 * Example: for America/New_York on 2026-06-23, returns
 * 2026-06-23T04:00:00Z .. 2026-06-24T04:00:00Z (EDT, UTC-4).
 */
export function dayWindowInTimeZone(
  timeZone: string | undefined | null,
  refMs: number,
): DayWindow {
  const iana = resolveIanaZone(timeZone) ?? "UTC";

  // Local calendar date for the reference instant.
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dmap: Record<string, string> = {};
  for (const p of dateFmt.formatToParts(new Date(refMs))) dmap[p.type] = p.value;
  const year = Number(dmap.year);
  const month1 = Number(dmap.month);
  const day = Number(dmap.day);

  const startMs =
    iana === "UTC"
      ? Date.UTC(year, month1 - 1, day, 0, 0, 0)
      : zonedWallClockToUtcMs(year, month1, day, 0, 0, 0, iana);
  // Next local midnight. Date.UTC normalizes day+1 across month/year ends.
  const endMs =
    iana === "UTC"
      ? Date.UTC(year, month1 - 1, day + 1, 0, 0, 0)
      : zonedWallClockToUtcMs(year, month1, day + 1, 0, 0, 0, iana);

  const localDate = `${dmap.year}-${dmap.month}-${dmap.day}`;
  /* Totality guard: if the zoned math ever yields a non-finite instant, fall
     back to the plain UTC calendar day rather than throwing out of toISOString()
     and collapsing the whole calendar fetch to "no meetings". */
  const safeStartMs = Number.isFinite(startMs)
    ? startMs
    : Date.UTC(year, month1 - 1, day, 0, 0, 0);
  const safeEndMs = Number.isFinite(endMs)
    ? endMs
    : Date.UTC(year, month1 - 1, day + 1, 0, 0, 0);
  return {
    startUtcIso: new Date(safeStartMs).toISOString(),
    endUtcIso: new Date(safeEndMs).toISOString(),
    localDate,
  };
}

/** True when a UTC instant falls on the given local calendar day in a zone. */
export function isSameLocalDay(
  utcIso: string,
  timeZone: string | undefined | null,
  refMs: number,
): boolean {
  const t = Date.parse(utcIso);
  if (Number.isNaN(t)) return false;
  const win = dayWindowInTimeZone(timeZone, refMs);
  return t >= Date.parse(win.startUtcIso) && t < Date.parse(win.endUtcIso);
}
