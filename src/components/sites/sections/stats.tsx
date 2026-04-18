/**
 * Stats section — grid of big numbers with label + optional prefix/suffix.
 * Matches template's CountUp layout (auto-fit grid, label above value).
 * Preview does not animate the count — the user sees the target value
 * immediately, which is what they want to verify.
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface StatsSectionProps {
  section: BriefSection;
}

function formatValue(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  // Compact number formatting keeps wide stat grids readable on mobile.
  return value.toLocaleString();
}

export function StatsSection({ section }: StatsSectionProps) {
  const { heading, items } = section;
  const stats = items ?? [];

  return (
    <section
      data-testid="stats-section"
      data-section-type="stats"
      className="mx-auto w-full max-w-6xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-5 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}

      {stats.length === 0 ? (
        <div
          data-testid="stats-empty"
          className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500"
        >
          No stats yet — add items in the editor.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {stats.map((stat, idx) => (
            <div
              key={idx}
              data-testid="stats-item"
              className="flex flex-col items-center gap-1 rounded-lg border border-neutral-200 bg-white px-4 py-6 text-center shadow-sm"
            >
              <div className="text-3xl font-bold tracking-tight text-neutral-900 md:text-4xl">
                {stat.prefix ?? ""}
                {formatValue(stat.value)}
                {stat.suffix ?? ""}
              </div>
              {stat.label ? (
                <div className="text-xs uppercase tracking-wider text-neutral-500">
                  {stat.label}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default StatsSection;
