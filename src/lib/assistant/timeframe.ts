/**
 * Deterministic timeframe-token → [startMs, endMs] resolver.
 * No LLM required — called from every calendar / finance / brain tool
 * so the assistant interprets "this afternoon" consistently everywhere.
 */

const MS_HOUR = 3600_000;
const MS_DAY = 24 * MS_HOUR;

export interface TimeRange {
  startMs: number;
  endMs: number;
  label: string;
}

function dayBounds(nowMs: number): { startMs: number; endMs: number } {
  const d = new Date(nowMs);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { startMs, endMs: startMs + MS_DAY - 1 };
}

export function resolveTimeframe(token: string | undefined, nowMs = Date.now()): TimeRange {
  const today = dayBounds(nowMs);
  switch (token) {
    case "morning_today":
      return { startMs: today.startMs, endMs: today.startMs + 12 * MS_HOUR - 1, label: "this morning" };
    case "afternoon_today":
      return { startMs: today.startMs + 12 * MS_HOUR, endMs: today.startMs + 18 * MS_HOUR - 1, label: "this afternoon" };
    case "evening_today":
      return { startMs: today.startMs + 18 * MS_HOUR, endMs: today.endMs, label: "this evening" };
    case "tomorrow": {
      const s = today.startMs + MS_DAY;
      return { startMs: s, endMs: s + MS_DAY - 1, label: "tomorrow" };
    }
    case "this_week": {
      const d = new Date(nowMs);
      const dow = d.getUTCDay();
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
      return { startMs: s, endMs: s + 7 * MS_DAY - 1, label: "this week" };
    }
    case "next_week": {
      const d = new Date(nowMs);
      const dow = d.getUTCDay();
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 7);
      return { startMs: s, endMs: s + 7 * MS_DAY - 1, label: "next week" };
    }
    case "this_month": {
      const d = new Date(nowMs);
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
      return { startMs: s, endMs: e, label: "this month" };
    }
    case "last_month": {
      const d = new Date(nowMs);
      const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
      const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 1;
      return { startMs: s, endMs: e, label: "last month" };
    }
    case "this_quarter": {
      const d = new Date(nowMs);
      const q = Math.floor(d.getUTCMonth() / 3);
      const s = Date.UTC(d.getUTCFullYear(), q * 3, 1);
      const e = Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1) - 1;
      return { startMs: s, endMs: e, label: "this quarter" };
    }
    case "last_quarter": {
      const d = new Date(nowMs);
      const q = Math.floor(d.getUTCMonth() / 3) - 1;
      const yr = q < 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
      const qq = ((q % 4) + 4) % 4;
      const s = Date.UTC(yr, qq * 3, 1);
      const e = Date.UTC(yr, qq * 3 + 3, 1) - 1;
      return { startMs: s, endMs: e, label: "last quarter" };
    }
    case "this_year": {
      const d = new Date(nowMs);
      return {
        startMs: Date.UTC(d.getUTCFullYear(), 0, 1),
        endMs: Date.UTC(d.getUTCFullYear() + 1, 0, 1) - 1,
        label: "this year",
      };
    }
    case "last_year": {
      const d = new Date(nowMs);
      return {
        startMs: Date.UTC(d.getUTCFullYear() - 1, 0, 1),
        endMs: Date.UTC(d.getUTCFullYear(), 0, 1) - 1,
        label: "last year",
      };
    }
    case "today":
    default:
      return { ...today, label: "today" };
  }
}
