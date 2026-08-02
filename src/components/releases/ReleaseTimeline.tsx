"use client";

/**
 * ReleaseTimeline: the /releases changelog view.
 *
 * Simple to scan and organized by date:
 *   - A year tab bar at the top (All / 2026 / 2025 ...) to filter by year.
 *   - Releases grouped under sticky "Month Year" headers, newest first.
 *   - Each release is an expandable card: date badge, title, summary, and a
 *     plain-English feature breakdown (what changed + how to use it).
 *
 * Pure presentational, takes the releases array and renders. No data fetching
 * here so it is trivially testable.
 */

import { useMemo, useState } from "react";
import type { Release, ReleaseEntry } from "@/lib/releases";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function categoryStyle(category?: string): { label: string; color: string } {
  switch ((category || "").toLowerCase()) {
    case "fix":
      return { label: "Fix", color: "var(--wp-info, #3b82f6)" };
    case "improvement":
      return { label: "Improvement", color: "var(--wp-success, #22c55e)" };
    case "milestone":
      return { label: "Milestone", color: "var(--wp-gold, #e8b528)" };
    default:
      return { label: "Feature", color: "var(--wp-gold, #e8b528)" };
  }
}

/** "2026-07-29" -> { year: 2026, monthIndex: 6, dayLabel: "Jul 29" } */
function parseDate(iso: string): { year: number; monthIndex: number; monthLabel: string; dayLabel: string } {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  const monthIndex = (m || 1) - 1;
  const short = MONTHS[monthIndex]?.slice(0, 3) ?? "";
  return {
    year: y || 0,
    monthIndex,
    monthLabel: `${MONTHS[monthIndex] ?? ""} ${y || ""}`.trim(),
    dayLabel: `${short} ${d || ""}`.trim(),
  };
}

function EntryRow({ entry }: { entry: ReleaseEntry }) {
  const cat = categoryStyle(entry.category);
  return (
    <div
      style={{
        padding: "0.75rem 0",
        borderTop: "1px solid var(--wp-dark-border, #23262e)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: "0.68rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: cat.color,
            border: `1px solid ${cat.color}`,
            borderRadius: 999,
            padding: "0.05rem 0.5rem",
          }}
        >
          {cat.label}
        </span>
        {entry.area ? (
          <span
            style={{
              fontSize: "0.68rem",
              fontWeight: 600,
              color: "var(--wp-text-dim, #9aa0aa)",
              border: "1px solid var(--wp-dark-border, #23262e)",
              borderRadius: 999,
              padding: "0.05rem 0.5rem",
            }}
          >
            {entry.area}
          </span>
        ) : null}
        <span style={{ fontWeight: 700, color: "var(--wp-text, #e8eaed)" }}>
          {entry.title}
        </span>
      </div>
      {entry.description ? (
        <p style={{ margin: "0.4rem 0 0", color: "var(--wp-text-dim, #c2c6cd)", fontSize: "0.9rem", lineHeight: 1.5 }}>
          {entry.description}
        </p>
      ) : null}
      {entry.how_to_use ? (
        <div
          style={{
            marginTop: "0.5rem",
            padding: "0.5rem 0.7rem",
            background: "var(--wp-dark-surface, #16181d)",
            borderLeft: "3px solid var(--wp-gold, #e8b528)",
            borderRadius: "0 6px 6px 0",
          }}
        >
          <span style={{ fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--wp-gold, #e8b528)" }}>
            How to use
          </span>
          <p style={{ margin: "0.2rem 0 0", color: "var(--wp-text, #e8eaed)", fontSize: "0.88rem", lineHeight: 1.5 }}>
            {entry.how_to_use}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ReleaseCard({ release, defaultOpen }: { release: Release; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { dayLabel } = parseDate(release.released_on);
  const entryCount = release.entries.length;

  return (
    <div
      data-testid="release-card"
      style={{
        display: "flex",
        gap: "1rem",
        background: "var(--wp-card, #16181d)",
        border: "1px solid var(--wp-dark-border, #23262e)",
        borderRadius: 12,
        padding: "1rem 1.1rem",
        marginBottom: "0.9rem",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: 58,
          textAlign: "center",
          color: "var(--wp-gold, #e8b528)",
          fontWeight: 700,
          fontSize: "0.8rem",
          lineHeight: 1.2,
          paddingTop: "0.15rem",
        }}
      >
        {dayLabel}
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            width: "100%",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "0.75rem",
          }}
        >
          <span style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--wp-text, #e8eaed)" }}>
            {release.title}
          </span>
          <span style={{ flexShrink: 0, fontSize: "0.78rem", color: "var(--wp-text-dim, #9aa0aa)" }}>
            {entryCount} {entryCount === 1 ? "change" : "changes"} {open ? "▾" : "▸"}
          </span>
        </button>

        {release.summary ? (
          <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim, #c2c6cd)", fontSize: "0.92rem", lineHeight: 1.5 }}>
            {release.summary}
          </p>
        ) : null}

        {open ? (
          <div style={{ marginTop: "0.4rem" }}>
            {entryCount === 0 ? (
              <p style={{ color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.88rem", marginTop: "0.6rem" }}>
                No itemized changes for this release.
              </p>
            ) : (
              release.entries.map((e, i) => <EntryRow key={i} entry={e} />)
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Product-creation milestones are versioned "<area>-created". */
const isMilestone = (r: Release) => r.version.endsWith("-created");
/**
 * A dated measurement of the whole codebase, published by
 * scripts/publish-loc-snapshot.ts. Distinct from a creation milestone: a
 * milestone records what a product was worth at its first commit and never
 * moves again, a snapshot records where everything stands today.
 */
const isLocSnapshot = (r: Release) => r.version.startsWith("loc-snapshot-");

export default function ReleaseTimeline({ releases }: { releases: Release[] }) {
  const [view, setView] = useState<"releases" | "products">("releases");

  // Creation milestones, oldest first, so the Products view reads as the
  // product lineup by create date.
  const milestones = useMemo(
    () =>
      releases
        .filter(isMilestone)
        .slice()
        .sort((a, b) => (a.released_on < b.released_on ? -1 : 1)),
    [releases],
  );

  // Feature releases (everything that is not a creation milestone).
  const regular = useMemo(() => releases.filter((r) => !isMilestone(r)), [releases]);

  // Headline stats for the analytics strip.
  //
  // The tile reads the NEWEST snapshot when one exists, and only falls back to
  // summing creation milestones when none does. Summing milestones was giving a
  // number frozen at each product's first commit, so the headline said 1,802,656
  // while the snapshot published the same day said 1,828,902. Two different
  // numbers for the same thing on one screen is worse than either being wrong,
  // because it makes the reader distrust both.
  const latestSnapshot = useMemo(() => {
    const snaps = releases.filter(isLocSnapshot);
    if (snaps.length === 0) return null;
    return snaps.reduce((newest, r) => (r.released_on > newest.released_on ? r : newest));
  }, [releases]);

  const totalLoc = useMemo(() => {
    if (latestSnapshot) return latestSnapshot.entries.reduce((sum, e) => sum + (e.loc ?? 0), 0);
    return milestones.reduce((sum, m) => sum + (m.entries[0]?.loc ?? 0), 0);
  }, [latestSnapshot, milestones]);

  // A snapshot's rows are measurements, not features. Counting them would say
  // seven things shipped every time the codebase was measured.
  const featureCount = useMemo(
    () => regular.filter((r) => !isLocSnapshot(r)).reduce((sum, r) => sum + r.entries.length, 0),
    [regular],
  );

  // Index feature releases by year -> month so navigation is by-date and you
  // only ever render one month at a time (no long scroll). Newest-first.
  const byYearMonth = useMemo(() => {
    const years = new Map<number, Map<number, Release[]>>();
    for (const r of regular) {
      const { year, monthIndex } = parseDate(r.released_on);
      if (!years.has(year)) years.set(year, new Map());
      const months = years.get(year)!;
      if (!months.has(monthIndex)) months.set(monthIndex, []);
      months.get(monthIndex)!.push(r);
    }
    return years;
  }, [regular]);

  const years = useMemo(
    () => Array.from(byYearMonth.keys()).sort((a, b) => b - a),
    [byYearMonth],
  );

  const [activeYear, setActiveYear] = useState<number | null>(null);
  const [activeMonth, setActiveMonth] = useState<number | null>(null);

  // Default to the newest year + its newest month once data is in.
  const effectiveYear = activeYear ?? years[0] ?? null;
  const monthsForYear = useMemo(
    () =>
      effectiveYear == null
        ? []
        : Array.from(byYearMonth.get(effectiveYear)?.keys() ?? []).sort((a, b) => b - a),
    [byYearMonth, effectiveYear],
  );
  const effectiveMonth =
    activeMonth != null && monthsForYear.includes(activeMonth)
      ? activeMonth
      : monthsForYear[0] ?? null;

  const shown =
    effectiveYear != null && effectiveMonth != null
      ? byYearMonth.get(effectiveYear)?.get(effectiveMonth) ?? []
      : [];

  if (releases.length === 0) {
    return (
      <div
        data-testid="releases-empty"
        style={{
          border: "1px dashed var(--wp-dark-border, #23262e)",
          borderRadius: 12,
          padding: "2.5rem 1rem",
          textAlign: "center",
          color: "var(--wp-text-dim, #9aa0aa)",
        }}
      >
        No releases published yet. New features will show up here as they ship.
      </div>
    );
  }

  const tab = (active: boolean) => ({
    all: "unset" as const,
    cursor: "pointer",
    padding: "0.3rem 0.8rem",
    borderRadius: 999,
    fontSize: "0.82rem",
    fontWeight: 600,
    background: active ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-surface, #16181d)",
    color: active ? "#0b0d11" : "var(--wp-text, #e8eaed)",
    border: `1px solid ${active ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-border, #23262e)"}`,
  });

  const stats: { label: string; value: string }[] = [
    { label: "Products", value: String(milestones.length) },
    {
      label: "Lines of code",
      // No "~" against a snapshot: it is a counted figure, and the tilde
      // invited exactly the mismatch this was reported for.
      value: totalLoc ? `${latestSnapshot ? "" : "~"}${totalLoc.toLocaleString()}` : "0",
    },
    { label: "Releases", value: String(regular.length) },
    { label: "Features shipped", value: String(featureCount) },
  ];

  return (
    <div>
      {/* Analytics strip: at-a-glance totals across all products. */}
      <div
        data-testid="releases-stats"
        style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.4rem" }}
      >
        {stats.map((s) => (
          <div
            key={s.label}
            style={{
              flex: "1 1 130px",
              minWidth: 130,
              background: "var(--wp-card, #16181d)",
              border: "1px solid var(--wp-dark-border, #23262e)",
              borderRadius: 12,
              padding: "0.9rem 1rem",
            }}
          >
            <div
              style={{
                // Responsive so long values (e.g. ~1,826,191) scale down to fit
                // a narrow mobile card instead of overflowing its border.
                fontSize: "clamp(1rem, 4.5vw, 1.45rem)",
                fontWeight: 800,
                color: "var(--wp-gold, #e8b528)",
                lineHeight: 1.15,
                letterSpacing: "-0.01em",
                overflowWrap: "anywhere",
              }}
            >
              {s.value}
            </div>
            <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--wp-text-dim, #9aa0aa)", marginTop: "0.2rem" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>

      {/* View toggle: feature Releases vs the product-creation timeline. */}
      <div
        role="tablist"
        aria-label="Choose view"
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1.1rem" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "releases"}
          data-testid="view-releases"
          onClick={() => setView("releases")}
          style={tab(view === "releases")}
        >
          Releases
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "products"}
          data-testid="view-products"
          onClick={() => setView("products")}
          style={tab(view === "products")}
        >
          Products
        </button>
      </div>

      {view === "products" ? (
        <ol data-testid="products-timeline" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {milestones.map((m) => {
            const d = parseDate(m.released_on);
            const name = m.entries[0]?.area ?? m.title.replace(/ created$/i, "");
            return (
              <li
                key={m.id}
                style={{
                  padding: "0.7rem 0",
                  borderBottom: "1px solid var(--wp-dark-border, #23262e)",
                }}
              >
                {/* Date on its own line, then name + "created" inline, so a long
                    product name never fights a fixed date column on a phone. */}
                <div style={{ color: "var(--wp-gold, #e8b528)", fontWeight: 700, fontSize: "0.78rem", marginBottom: "0.15rem" }}>
                  {d.dayLabel}, {d.year}
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, color: "var(--wp-text, #e8eaed)", fontSize: "0.98rem" }}>{name}</span>
                  <span style={{ color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.78rem" }}>created</span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <>
      {/* Year tabs, only when history spans more than one year. */}
      {years.length > 1 ? (
        <div
          role="tablist"
          aria-label="Filter releases by year"
          style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}
        >
          {years.map((y) => (
            <button
              key={y}
              type="button"
              role="tab"
              aria-selected={y === effectiveYear}
              data-testid={`year-tab-${y}`}
              onClick={() => {
                setActiveYear(y);
                setActiveMonth(null);
              }}
              style={tab(y === effectiveYear)}
            >
              {y}
            </button>
          ))}
        </div>
      ) : null}

      {/* Month tabs: the primary navigation. Pick a month, see just that month. */}
      <div
        role="tablist"
        aria-label="Filter releases by month"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.2rem" }}
      >
        {monthsForYear.map((m) => {
          const count = byYearMonth.get(effectiveYear!)?.get(m)?.length ?? 0;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={m === effectiveMonth}
              data-testid={`month-tab-${m}`}
              onClick={() => setActiveMonth(m)}
              style={tab(m === effectiveMonth)}
            >
              {MONTHS[m].slice(0, 3)}
              <span style={{ opacity: 0.6, marginLeft: "0.35rem", fontWeight: 500 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {shown.map((r, i) => (
        <ReleaseCard key={r.id} release={r} defaultOpen={i === 0} />
      ))}
        </>
      )}
    </div>
  );
}
