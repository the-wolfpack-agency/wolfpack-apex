/**
 * Personalized Quick Actions ranker — turns 30 days of `system.page_viewed`
 * events into the user's top-4 most-used pages on the dashboard.
 *
 * Algorithm (codified from product spec — do not invent):
 *
 *   1. Look back 30 days of the calling user's page-view events.
 *   2. Score each event with exponential decay:
 *
 *        score(event) = 0.5 ** (age_days / HALF_LIFE_DAYS)
 *
 *      so a 14-day-old event counts half. Half-life = 14 days. This
 *      is the "half-life" mechanism the user asked for.
 *   3. Group by route, sum scores per route, take top 4.
 *   4. Filter routes the user can't act on (the dashboard itself,
 *      /login, error routes).
 *   5. If fewer than MIN_PERSONALIZED routes score above MIN_SCORE,
 *      return the static fallback. Cold-start protection — a brand-new
 *      user shouldn't see a half-empty card.
 *
 * Pure functions only — no DB, no fetch, no clock except via injected
 * `now`. Makes the unit tests deterministic and zero-cost.
 */

/** Half-life in days. A 14-day-old click counts half a fresh click. */
export const HALF_LIFE_DAYS = 14;

/** Minimum decayed score for a route to be considered "personalized". */
export const MIN_SCORE = 0.5;

/**
 * Minimum number of personalized routes above MIN_SCORE before we'll
 * show personalized actions. Below this we fall back to the static
 * four — better to look identical to today than to look broken.
 */
export const MIN_PERSONALIZED = 3;

/** Final number of tiles shown in the card. */
export const ACTION_COUNT = 4;

/** Routes that must never appear as a Quick Action. */
const BLOCKED_PATHS = new Set<string>([
  "/",
  "/login",
  "/logout",
  "/error",
  "/404",
  "/500",
  "/_error",
  "/dashboard",
]);

/**
 * Pretty-print mapping for known routes. Anything not in this table
 * falls back to titlecasing the route's last segment.
 */
const ROUTE_LABELS: Record<string, string> = {
  "/messages": "Messages",
  "/emails": "Emails",
  "/calendar": "Calendar",
  "/meetings": "Meetings",
  "/tasks": "Tasks",
  "/planner": "Planner",
  "/notifications": "Notifications",
  "/knowledge": "Ask a Question",
  "/discussions": "Discussions",
  "/features": "Feature Requests",
  "/journal": "Journal",
  "/clients": "Clients",
  "/directory": "Directory",
  "/people": "People",
  "/hr": "HR",
  "/financials": "Financials",
  "/goals": "Goals",
  "/sites": "Sites",
  "/docs": "Documents",
  "/reports": "Reports",
  "/analytics": "Analytics",
  "/brain": "Central Brain",
  "/assistant": "Assistant",
  "/automations": "Automations",
  "/search": "Search",
  "/settings": "Settings",
  "/tools": "Tools",
  "/admin": "Admin",
  "/support": "Support",
  "/meetings/upcoming": "Upcoming Meetings",
};

/** Static cold-start fallback — same four tiles the dashboard ships today. */
export const FALLBACK_ACTIONS: ReadonlyArray<{ label: string; href: string }> =
  [
    { label: "Ask a Question", href: "/knowledge" },
    { label: "Create Discussion", href: "/discussions" },
    { label: "Submit Feature", href: "/features" },
    { label: "View Journal", href: "/journal" },
  ] as const;

export interface PageViewEvent {
  /** Path the user landed on (`/calendar`, `/messages`, etc.). */
  path: string;
  /** ISO timestamp. */
  timestamp: string;
}

export interface QuickAction {
  label: string;
  href: string;
  /** Decayed-score for personalized items, 0 for fallback items. */
  score: number;
  source: "personalized" | "fallback";
}

/**
 * Titlecase the last segment of a route as a humane fallback when
 * we don't have an explicit ROUTE_LABELS entry. Drops query/hash and
 * splits hyphens/underscores so `/foo/bar-baz` → "Bar Baz".
 */
export function titlecaseSegment(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const trimmed = clean.replace(/\/+$/, "");
  if (!trimmed) return "Home";
  const segments = trimmed.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  if (!last) return "Home";
  return last
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Resolve a label for a route. Prefers ROUTE_LABELS, falls back to a
 * titlecased last segment.
 */
export function labelForPath(path: string): string {
  if (ROUTE_LABELS[path]) return ROUTE_LABELS[path];
  // Try the parent route too — `/calendar/abc-123` should still
  // surface as "Calendar" rather than "Abc 123".
  const parent = "/" + (path.split("/").filter(Boolean)[0] ?? "");
  if (ROUTE_LABELS[parent]) return ROUTE_LABELS[parent];
  return titlecaseSegment(path);
}

/**
 * Strip query/hash and trailing slash so `/calendar?day=1` and
 * `/calendar/` both bucket into `/calendar`.
 */
export function normalizePath(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const noQuery = raw.split(/[?#]/, 1)[0] ?? raw;
  const trimmed = noQuery.replace(/\/+$/, "");
  if (!trimmed) return "/";
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

/**
 * Decayed score for a single event, given a fixed "now". Pure.
 *
 * Future events (clock skew) clamp to score=1 instead of >1 to keep
 * the ranking stable across slightly-skewed clients.
 */
export function decayedScore(
  event: PageViewEvent,
  now: Date = new Date(),
  halfLifeDays: number = HALF_LIFE_DAYS,
): number {
  const eventTime = new Date(event.timestamp).getTime();
  if (Number.isNaN(eventTime)) return 0;
  const ageMs = now.getTime() - eventTime;
  if (ageMs < 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

interface RouteAggregate {
  path: string;
  score: number;
}

/**
 * Aggregate a stream of page-view events into a ranked list of
 * `(path, score)` tuples, highest score first. Filters blocked paths
 * and normalizes routes. Pure — pass in the events + now.
 */
export function aggregateScores(
  events: PageViewEvent[],
  now: Date = new Date(),
): RouteAggregate[] {
  const totals = new Map<string, number>();
  for (const ev of events) {
    const path = normalizePath(ev.path);
    if (!path) continue;
    if (BLOCKED_PATHS.has(path)) continue;
    const score = decayedScore(ev, now);
    if (score <= 0) continue;
    totals.set(path, (totals.get(path) ?? 0) + score);
  }
  return Array.from(totals.entries())
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Build the final list of tiles the dashboard renders. Returns
 * exactly ACTION_COUNT items, blended with fallback if personalized
 * data is too thin.
 */
export function buildQuickActions(
  events: PageViewEvent[],
  now: Date = new Date(),
): QuickAction[] {
  const ranked = aggregateScores(events, now);
  const strong = ranked.filter((r) => r.score >= MIN_SCORE);

  if (strong.length < MIN_PERSONALIZED) {
    return FALLBACK_ACTIONS.map((a) => ({
      label: a.label,
      href: a.href,
      score: 0,
      source: "fallback" as const,
    }));
  }

  const personalized: QuickAction[] = strong
    .slice(0, ACTION_COUNT)
    .map((r) => ({
      label: labelForPath(r.path),
      href: r.path,
      score: Math.round(r.score * 1000) / 1000,
      source: "personalized" as const,
    }));

  // Top up with fallback items if the user has 3 strong routes but
  // not 4. Don't duplicate hrefs already in the personalized slice.
  if (personalized.length < ACTION_COUNT) {
    const seen = new Set(personalized.map((p) => p.href));
    for (const f of FALLBACK_ACTIONS) {
      if (personalized.length >= ACTION_COUNT) break;
      if (seen.has(f.href)) continue;
      personalized.push({
        label: f.label,
        href: f.href,
        score: 0,
        source: "fallback",
      });
      seen.add(f.href);
    }
  }

  return personalized.slice(0, ACTION_COUNT);
}
