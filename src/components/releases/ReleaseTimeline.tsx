"use client";

/**
 * ReleaseTimeline — the /releases changelog view.
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

export default function ReleaseTimeline({ releases }: { releases: Release[] }) {
  // Year tabs, derived from the data, newest first, with an "All" option.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of releases) set.add(parseDate(r.released_on).year);
    return Array.from(set).sort((a, b) => b - a);
  }, [releases]);

  const [activeYear, setActiveYear] = useState<number | "all">("all");

  const visible = useMemo(
    () =>
      activeYear === "all"
        ? releases
        : releases.filter((r) => parseDate(r.released_on).year === activeYear),
    [releases, activeYear],
  );

  // Group the visible releases under "Month Year" headers, newest first.
  const groups = useMemo(() => {
    const map = new Map<string, Release[]>();
    for (const r of visible) {
      const { monthLabel } = parseDate(r.released_on);
      const arr = map.get(monthLabel) ?? [];
      arr.push(r);
      map.set(monthLabel, arr);
    }
    return Array.from(map.entries()); // insertion order = newest first (releases already sorted)
  }, [visible]);

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

  const tabBase = {
    all: "unset" as const,
    cursor: "pointer",
    padding: "0.35rem 0.85rem",
    borderRadius: 999,
    fontSize: "0.85rem",
    fontWeight: 600,
  };

  return (
    <div>
      {/* Year tabs, view changes by date */}
      <div
        role="tablist"
        aria-label="Filter releases by year"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.1rem" }}
      >
        {(["all", ...years] as const).map((y) => {
          const active = activeYear === y;
          return (
            <button
              key={String(y)}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`year-tab-${y}`}
              onClick={() => setActiveYear(y as number | "all")}
              style={{
                ...tabBase,
                background: active ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-surface, #16181d)",
                color: active ? "#0b0d11" : "var(--wp-text, #e8eaed)",
                border: `1px solid ${active ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-border, #23262e)"}`,
              }}
            >
              {y === "all" ? "All" : y}
            </button>
          );
        })}
      </div>

      {groups.map(([monthLabel, rels], gi) => (
        <section key={monthLabel} style={{ marginBottom: "1.4rem" }}>
          <h2
            style={{
              position: "sticky",
              top: 0,
              zIndex: 1,
              margin: "0 0 0.7rem",
              padding: "0.35rem 0",
              fontSize: "0.8rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--wp-text-dim, #9aa0aa)",
              background: "var(--wp-bg, #0b0d11)",
            }}
          >
            {monthLabel}
          </h2>
          {rels.map((r, ri) => (
            <ReleaseCard key={r.id} release={r} defaultOpen={gi === 0 && ri === 0} />
          ))}
        </section>
      ))}
    </div>
  );
}
