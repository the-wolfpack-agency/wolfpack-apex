"use client";

/**
 * KrProgress — a single KR row with metric label + progress bar.
 *
 * The progress is clamped to [0, 100]% so over-achievement still renders
 * as a full bar with a clearly-labelled "X% of target" number (e.g.
 * 130% lands at a solid 100% bar with "130% of target" in the meta
 * text).
 */

export interface KrProgressProps {
  id: string;
  metric: string;
  current_value: number;
  target_value: number;
  unit: string | null;
  /** Optional inline-edit callback. If set the row renders a small pencil. */
  onEdit?: (kr_id: string) => void;
}

export default function KrProgress(props: KrProgressProps) {
  const { metric, current_value, target_value, unit, onEdit, id } = props;
  const raw = target_value === 0 ? 0 : (current_value / target_value) * 100;
  const pct = Math.max(0, Math.min(100, raw));
  const color =
    raw >= 100 ? "var(--wp-success)" : raw >= 60 ? "var(--wp-gold)" : "var(--wp-info)";

  return (
    <div data-testid={`kr-${id}`} className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm" style={{ color: "var(--wp-text)" }}>
          {metric}
        </span>
        <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
          {formatNum(current_value)} / {formatNum(target_value)}
          {unit ? ` ${unit}` : ""} · {Math.round(raw)}%
        </span>
      </div>
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: "var(--wp-dark-surface2)" }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      {onEdit && (
        <button
          onClick={() => onEdit(id)}
          className="text-xs"
          style={{ color: "var(--wp-text-muted)" }}
        >
          Update current value
        </button>
      )}
    </div>
  );
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return `${n}`;
  return n.toFixed(1);
}
