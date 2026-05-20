/**
 * Job-codes domain types.
 *
 * One source of truth: the Wolfpack Job Codes xlsx in SharePoint. This
 * module describes the shape every downstream surface (page, API,
 * TimeLogWidget autocomplete) sees, regardless of how the codes were
 * sourced (live Graph pull vs cached row).
 */

export interface JobCode {
  code: string;
  description: string;
  /** Source workbook sheet — useful for grouping in the UI. */
  sheetName: string;
  /** False when the code disappeared from the source workbook on the
   *  last refresh. Kept for historical attribution but hidden from
   *  selection surfaces. */
  active: boolean;
  /** ISO timestamp when the refresh process last observed this code
   *  in the source workbook. */
  lastSeenAt: string;
}

/** Provenance + freshness metadata returned alongside any code list. */
export interface JobCodesSourceInfo {
  driveId: string | null;
  itemId: string | null;
  webUrl: string | null;
  sheetName: string | null;
  /** ISO timestamp of the most recent SUCCESSFUL refresh, or null if
   *  the cache has never been populated. */
  lastRefreshedAt: string | null;
  /** ISO timestamp of the most recent refresh ATTEMPT (success or
   *  fail) — useful for "we last tried at X, served stale because Y." */
  lastAttemptedAt: string | null;
  lastAttemptStatus: JobCodesRefreshStatus | null;
  lastAttemptError: string | null;
}

export type JobCodesRefreshStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "served_stale";

export type JobCodesRefreshSource = "manual" | "auto_stale" | "scheduled";

/** Discriminated-result for any layer that fetches/parses codes. */
export type JobCodesErrorCode =
  | "not_configured"        // missing app-only Graph credentials
  | "source_file_not_found" // search returned no matching xlsx
  | "graph_unavailable"     // Graph 5xx / network error
  | "graph_forbidden"       // missing application permission
  | "rate_limited"          // Graph 429
  | "parse_failed"          // workbook structure not what we expected
  | "no_codes_found"        // workbook present but empty / wrong shape
  | "internal";

export interface JobCodesError {
  code: JobCodesErrorCode;
  detail: string;
  retryAfter?: number;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: JobCodesError };

/** What sharepoint-source returns when it successfully pulls codes. */
export interface JobCodesFetchValue {
  rows: JobCode[];
  driveId: string;
  itemId: string;
  webUrl: string;
  sheetName: string;
}

/** Refresh outcome — what the resolver reports back to API callers. */
export interface JobCodesRefreshOutcome {
  status: JobCodesRefreshStatus;
  source: JobCodesRefreshSource;
  rowsSeen: number;
  rowsAdded: number;
  rowsUpdated: number;
  rowsDeactivated: number;
  startedAt: string;
  finishedAt: string;
  error?: JobCodesError;
}
