/**
 * Goals UI shared view models. These mirror the server lib shapes but
 * keep the UI decoupled from the full backend types so a U3 server-side
 * refactor doesn't ripple through every component.
 */

export interface KrView {
  id: string;
  okr_id: string;
  metric: string;
  current_value: number;
  target_value: number;
  unit: string | null;
  cadence?: string;
  display_order?: number;
}

export interface OkrView {
  id: string;
  quarter: string;
  objective: string;
  status: string;
  // Accept both the U3 `krs` property AND the legacy `key_results` alias
  // so UI components can iterate whichever the upstream returned.
  krs?: KrView[];
  key_results?: KrView[];
}

export interface ContributionView {
  id: string;
  user_id: string;
  kr_id: string;
  source: string;
  description: string;
  committed_for_week: string | null;
  committed_at: string;
  graded_as: "hit" | "miss" | "close" | null;
}

export interface NorthStarView {
  latest: {
    label: string;
    value: number;
    unit: string | null;
    captured_at: string;
  } | null;
  history: Array<{ value: number; captured_at: string }>;
}

/** Convenience: always returns an array of KRs regardless of field name. */
export function krList(okr: OkrView): KrView[] {
  return okr.krs ?? okr.key_results ?? [];
}
