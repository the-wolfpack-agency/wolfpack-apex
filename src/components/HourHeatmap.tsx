/**
 * HourHeatmap - a 24-cell hour-of-day intensity grid.
 *
 * Extracted from the QR analytics page so it is reused, not repeated: the QR
 * scan analytics and the OGIAM Site Analytics page both render it. Pure +
 * presentational. `testIdPrefix` lets each caller keep stable, distinct test ids
 * (e.g. "qr-hour" -> qr-hour-heatmap / qr-hour-cell).
 */

export function HourHeatmap({
  data,
  testIdPrefix = "hour",
  unitLabel = "event",
}: {
  data: Array<{ hour: number; count: number }>;
  testIdPrefix?: string;
  /** Singular noun for the cell tooltip ("scan", "view"). */
  unitLabel?: string;
}) {
  /* Normalize to 24 buckets so missing hours show empty cells. */
  const buckets: number[] = Array.from({ length: 24 }, () => 0);
  for (const d of data) {
    if (Number.isFinite(d.hour) && d.hour >= 0 && d.hour < 24) {
      buckets[d.hour] = d.count;
    }
  }
  const max = Math.max(1, ...buckets);
  return (
    <div
      data-testid={`${testIdPrefix}-heatmap`}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(24, minmax(0, 1fr))",
        gap: 2,
      }}
    >
      {buckets.map((count, h) => {
        const intensity = count / max; // 0..1
        const bg =
          count === 0
            ? "var(--wp-dark-border)"
            : `rgba(212, 168, 87, ${0.15 + intensity * 0.85})`;
        return (
          <div
            key={h}
            data-testid={`${testIdPrefix}-cell`}
            title={`${h.toString().padStart(2, "0")}:00 - ${count} ${unitLabel}${count === 1 ? "" : "s"}`}
            style={{
              aspectRatio: "1 / 1",
              background: bg,
              borderRadius: 2,
              fontSize: "0.55rem",
              color: "var(--wp-text-dim)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {h % 6 === 0 ? h : ""}
          </div>
        );
      })}
    </div>
  );
}
