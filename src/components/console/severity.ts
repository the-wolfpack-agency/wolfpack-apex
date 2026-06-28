/**
 * severity.ts — the one severity / status vocabulary for the command center.
 *
 * Three admin pages (platform-scans, agents list, agent detail) all speak
 * the SAME status language so a "critical" looks identical everywhere and a
 * "resolved" reads the same on every surface. Map a free-form status/severity
 * string to one of the existing --wp-* tokens; never invent a colour.
 *
 * Tone buckets → token:
 *   critical / high / error / failed / blocked   → --wp-error
 *   medium / warning / degraded / pending        → --wp-warning
 *   low / info / queued / running / scanning      → --wp-info
 *   success / resolved / passed / healthy / done  → --wp-success
 *   featured / starred / primary                  → --wp-gold
 *   anything unknown                              → "neutral" (dim text)
 *
 * Pure data — no React, no DOM. Importable from any of the kit components and
 * from the consuming pages so the vocabulary stays single-sourced (DRY).
 */

export type SeverityTone =
  | "error"
  | "warning"
  | "info"
  | "success"
  | "gold"
  | "neutral";

/** CSS custom-property name backing each tone. Used for inline `style`
 *  values so we never hard-code a hex (with the same fallbacks the existing
 *  widgets use, in case the var is somehow unset). */
export const TONE_VAR: Record<SeverityTone, string> = {
  error: "var(--wp-error, #ef4444)",
  warning: "var(--wp-warning, #f97316)",
  info: "var(--wp-info, #3b82f6)",
  success: "var(--wp-success, #22c55e)",
  gold: "var(--wp-gold, #e8b528)",
  neutral: "var(--wp-text-dim, #b4bcc8)",
};

/** Word → tone lookup. Lower-cased keys; the resolver normalises input. */
const WORD_TONE: Record<string, SeverityTone> = {
  // error family
  critical: "error",
  crit: "error",
  high: "error",
  severe: "error",
  error: "error",
  fail: "error",
  failed: "error",
  failure: "error",
  blocked: "error",
  offline: "error",
  down: "error",
  // warning family
  medium: "warning",
  moderate: "warning",
  warn: "warning",
  warning: "warning",
  degraded: "warning",
  pending: "warning",
  paused: "warning",
  stale: "warning",
  // info family
  low: "info",
  info: "info",
  informational: "info",
  queued: "info",
  running: "info",
  scanning: "info",
  active: "info",
  inprogress: "info",
  in_progress: "info",
  // success family
  success: "success",
  succeeded: "success",
  resolved: "success",
  passed: "success",
  pass: "success",
  healthy: "success",
  ok: "success",
  done: "success",
  complete: "success",
  completed: "success",
  online: "success",
  // gold / featured family
  featured: "gold",
  starred: "gold",
  primary: "gold",
  highlight: "gold",
};

/**
 * Resolve a status/severity string to a tone. Case-insensitive, trims, and
 * collapses spaces/hyphens to underscores before lookup. Unknown → "neutral".
 */
export function toneForStatus(status: string | null | undefined): SeverityTone {
  if (!status) return "neutral";
  const key = String(status).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key in WORD_TONE) return WORD_TONE[key];
  // also try the un-underscored form (e.g. "in progress" → "inprogress")
  const compact = key.replace(/_/g, "");
  return WORD_TONE[compact] ?? "neutral";
}

/** Convenience: the CSS colour value for a status string in one call. */
export function colorForStatus(status: string | null | undefined): string {
  return TONE_VAR[toneForStatus(status)];
}
