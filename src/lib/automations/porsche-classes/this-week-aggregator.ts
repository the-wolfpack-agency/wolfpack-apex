/**
 * "This week" aggregator for the porsche-classes automation.
 *
 * Powers the /automations/porsche-classes dashboard: one row per
 * active class in the registry's `active_window_days` range with a
 * traffic-light status that tells the program owner at a glance whether
 * the class is ready to ship to SharePoint.
 *
 * Status rules (deterministic, tested in __tests__/this-week-aggregator.test.ts):
 *   READY            — all four expected sources are present
 *                      (porsche_xlsx + cognito_coordinator
 *                       + cognito_instructor + survey)
 *   NEEDS_ATTENTION  — open exception touching this class, OR the latest
 *                      survey snapshot has unmatched_respondents in its
 *                      source_payload (data loss risk: respondent didn't
 *                      match a roster).
 *   WAITING          — otherwise (still gathering inputs).
 *
 * Same architectural rules as summary-assembler.ts:
 *   - Pure-ish: query runner is injectable for unit tests (no Postgres).
 *   - class_match override graph is walked so manually-merged keys are
 *     collapsed into a single row.
 *   - We pull the LATEST snapshot per source_type per merged class.
 *
 * The route (`/api/automations/[automationId]/this-week`) maps the rows
 * here onto its JSON contract; this module owns the SQL + the projection.
 */

import {
  expandClassKeyEquivalence,
  type QueryRunner,
} from "./summary-assembler";
import type {
  AutomationId,
  AutomationSourceType,
  ClassKey,
  CourseType,
} from "../types";
import { query as defaultQuery } from "@/lib/db";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type ThisWeekStatus = "ready" | "waiting" | "needs_attention";

/** Sources we expect for a class to be "ready to ship". */
export const EXPECTED_SOURCES: ReadonlyArray<AutomationSourceType> = [
  "porsche_xlsx",
  "cognito_coordinator",
  "cognito_instructor",
  "survey",
];

export interface ThisWeekClassRow {
  class_key: ClassKey;
  course_type: CourseType;
  class_date: string;
  location: string;
  /** Sources we already have for this class (deduped, sorted by EXPECTED order). */
  sources_present: AutomationSourceType[];
  /** Sources we expect but don't have yet. */
  sources_missing: AutomationSourceType[];
  status: ThisWeekStatus;
  /** Plain-language reason when status === "needs_attention". */
  attention_reason?: string;
  /** ISO timestamp of the most recent successful SharePoint upload, if any. */
  sharepoint_uploaded_at: string | null;
  /** ISO timestamp of the latest snapshot's captured_at across all sources. */
  last_activity_at: string;
  /** Open exceptions referencing this class. */
  open_exception_count: number;
}

export interface ListThisWeekArgs {
  automationId: AutomationId;
  windowMinDays: number; // negative = past, positive = future
  windowMaxDays: number;
}

export interface ListThisWeekOptions {
  /** Inject a custom query runner — defaults to `query` from @/lib/db. */
  query?: QueryRunner;
  /** Override the "now" timestamp used in window math (for tests). */
  now?: () => Date;
}

/* ------------------------------------------------------------------ */
/* SQL fragments                                                       */
/* ------------------------------------------------------------------ */

/**
 * For every class_key with at least one snapshot in the active window,
 * pull the LATEST row per (class_key, source_type). The window is
 * computed in JS rather than `CURRENT_DATE` so the test harness can
 * pin "now" without depending on Postgres clock alignment — this query
 * also runs against the fake QueryRunner in unit tests.
 *
 * `participants` and `source_payload` are returned only on the latest
 * row of each source_type (the merge happens in JS to keep this query
 * O(rows-in-window) rather than a self-join).
 */
const LATEST_SNAPSHOTS_IN_WINDOW_SQL = `
  SELECT DISTINCT ON (class_key, source_type)
    class_key,
    source_type,
    course_type,
    class_date::text   AS class_date,
    location,
    captured_at::text  AS captured_at,
    participants,
    source_payload
  FROM instinct_automation_porsche_snapshots
  WHERE class_date BETWEEN $1::date AND $2::date
  ORDER BY class_key, source_type, captured_at DESC
`;

/** Open exception count per class_key (matches assembler's open-exceptions logic). */
const OPEN_EXCEPTIONS_BY_CLASS_SQL = `
  SELECT s.class_key, e.id AS exception_id
    FROM instinct_automation_porsche_exceptions e
    LEFT JOIN instinct_automation_porsche_snapshots s
      ON s.source_artifact_id = e.artifact_id
   WHERE e.automation_id = $1
     AND e.status = 'open'
`;

const CLASS_MATCH_SQL = `
  SELECT from_value, to_value
    FROM instinct_automation_porsche_overrides
   WHERE automation_id = $1
     AND kind = 'class_match'
`;

/**
 * Latest "succeeded" SharePoint upload per class_key, read out of the
 * analytics event log. We use timestamps from `instinct_events` rather
 * than maintaining a side table because every upload route already
 * emits `automations.sharepoint_upload_succeeded` and the data is
 * authoritative there (no dual-write drift to worry about).
 *
 * `metadata` is jsonb — pull `class_key` out and group by it.
 */
const LATEST_UPLOAD_BY_CLASS_SQL = `
  SELECT metadata->>'class_key' AS class_key,
         MAX(timestamp)::text   AS uploaded_at
    FROM instinct_events
   WHERE event_type = 'automations.sharepoint_upload_succeeded'
     AND metadata->>'automation_id' = $1
     AND metadata ? 'class_key'
   GROUP BY metadata->>'class_key'
`;

/* ------------------------------------------------------------------ */
/* Row shapes returned by the SQL above                                */
/* ------------------------------------------------------------------ */

interface SnapshotWindowRow extends Record<string, unknown> {
  class_key: ClassKey;
  source_type: AutomationSourceType;
  course_type: CourseType;
  class_date: string;
  location: string;
  captured_at: string;
  participants: string[] | null;
  source_payload: Record<string, unknown> | null;
}

interface ExceptionScopeRow extends Record<string, unknown> {
  class_key: ClassKey | null;
  exception_id: string;
}

interface MergeRow extends Record<string, unknown> {
  from_value: string;
  to_value: string;
}

interface UploadRow extends Record<string, unknown> {
  class_key: ClassKey;
  uploaded_at: string;
}

/* ------------------------------------------------------------------ */
/* Public entrypoint                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the "this week" view for one automation. Returns rows sorted
 * by class_date ascending (earliest upcoming first). Empty array when
 * no classes fall in the window — the route turns that into the page's
 * "no active classes this week" empty state.
 */
export async function listThisWeekClasses(
  args: ListThisWeekArgs,
  opts: ListThisWeekOptions = {},
): Promise<ThisWeekClassRow[]> {
  const q: QueryRunner = (opts.query ??
    (defaultQuery as unknown as QueryRunner));
  const now = (opts.now ?? (() => new Date()))();

  const fromDate = isoDate(addDays(now, args.windowMinDays));
  const toDate = isoDate(addDays(now, args.windowMaxDays));

  const [snapshotsRes, exceptionsRes, mergeRes, uploadsRes] = await Promise.all([
    q<SnapshotWindowRow>(LATEST_SNAPSHOTS_IN_WINDOW_SQL, [fromDate, toDate]),
    q<ExceptionScopeRow>(OPEN_EXCEPTIONS_BY_CLASS_SQL, [args.automationId]),
    q<MergeRow>(CLASS_MATCH_SQL, [args.automationId]),
    q<UploadRow>(LATEST_UPLOAD_BY_CLASS_SQL, [args.automationId]),
  ]);

  return projectThisWeekRows({
    snapshots: snapshotsRes.rows,
    exceptions: exceptionsRes.rows,
    merges: mergeRes.rows,
    uploads: uploadsRes.rows,
  });
}

/* ------------------------------------------------------------------ */
/* Pure projection — exported so tests can hit it without I/O          */
/* ------------------------------------------------------------------ */

export interface ProjectThisWeekArgs {
  snapshots: SnapshotWindowRow[];
  exceptions: ExceptionScopeRow[];
  merges: MergeRow[];
  uploads: UploadRow[];
}

export function projectThisWeekRows(
  input: ProjectThisWeekArgs,
): ThisWeekClassRow[] {
  /* 1. Group snapshots by canonical class_key (after class_match merge).
        We pick the lexicographically smallest key in the equivalence
        class as the canonical id — deterministic and stable across runs. */
  const canonical = new Map<ClassKey, ClassKey>();
  const snapshotsByCanonical = new Map<ClassKey, SnapshotWindowRow[]>();

  function canonicalize(key: ClassKey): ClassKey {
    const cached = canonical.get(key);
    if (cached !== undefined) return cached;
    const eq = expandClassKeyEquivalence(key, input.merges).slice().sort();
    const root = eq[0];
    for (const k of eq) canonical.set(k, root);
    return root;
  }

  for (const row of input.snapshots) {
    const root = canonicalize(row.class_key);
    const list = snapshotsByCanonical.get(root) ?? [];
    list.push(row);
    snapshotsByCanonical.set(root, list);
  }

  /* 2. Index open exceptions by canonical class_key. An exception with
        no snapshot link (e.g. parse_failure on an artifact that never
        produced a snapshot) is unattributable here and intentionally
        skipped — it surfaces in the global exceptions queue. */
  const exceptionsByCanonical = new Map<ClassKey, number>();
  for (const e of input.exceptions) {
    if (!e.class_key) continue;
    const root = canonicalize(e.class_key);
    exceptionsByCanonical.set(
      root,
      (exceptionsByCanonical.get(root) ?? 0) + 1,
    );
  }

  /* 3. Index uploads by canonical key — keep MAX timestamp across the
        equivalence class so a merge after upload doesn't lose history. */
  const uploadsByCanonical = new Map<ClassKey, string>();
  for (const u of input.uploads) {
    if (!u.class_key) continue;
    const root = canonicalize(u.class_key);
    const cur = uploadsByCanonical.get(root);
    if (!cur || u.uploaded_at > cur) {
      uploadsByCanonical.set(root, u.uploaded_at);
    }
  }

  /* 4. Project one row per canonical class. */
  const rows: ThisWeekClassRow[] = [];
  for (const [classKey, snaps] of snapshotsByCanonical.entries()) {
    if (snaps.length === 0) continue;

    /* Pick the latest snapshot per source_type (the SQL already did this
       per (class_key, source_type) but the merge step may have put two
       different physical class_keys into the same canonical bucket). */
    const latestPerSource = new Map<AutomationSourceType, SnapshotWindowRow>();
    for (const s of snaps) {
      const cur = latestPerSource.get(s.source_type);
      if (!cur || s.captured_at > cur.captured_at) {
        latestPerSource.set(s.source_type, s);
      }
    }

    const sources_present = EXPECTED_SOURCES.filter((t) =>
      latestPerSource.has(t),
    );
    const sources_missing = EXPECTED_SOURCES.filter(
      (t) => !latestPerSource.has(t),
    );

    /* Identity columns — prefer the xlsx snapshot (canonical roster);
       fall back to whichever source we DO have. The earliest-shipped
       parser is allowed to seed identity. */
    const identity =
      latestPerSource.get("porsche_xlsx") ??
      latestPerSource.get("cognito_coordinator") ??
      latestPerSource.get("cognito_instructor") ??
      latestPerSource.get("survey") ??
      snaps[0];

    const last_activity_at = snaps.reduce(
      (acc, s) => (s.captured_at > acc ? s.captured_at : acc),
      snaps[0].captured_at,
    );

    const open_exception_count = exceptionsByCanonical.get(classKey) ?? 0;
    const sharepoint_uploaded_at = uploadsByCanonical.get(classKey) ?? null;

    /* Detect unmatched survey respondents — the parser writes them onto
       the FIRST emitted snapshot's source_payload.unmatched_respondents.
       Surfacing this in `needs_attention` keeps the
       feedback_no_silent_data_loss invariant: respondent who failed to
       match a roster never quietly disappears from the dashboard. */
    const surveyRow = latestPerSource.get("survey");
    const unmatched =
      surveyRow && Array.isArray(
        (surveyRow.source_payload as Record<string, unknown> | null)?.unmatched_respondents,
      )
        ? ((surveyRow.source_payload as Record<string, unknown>)
            .unmatched_respondents as unknown[])
        : [];
    const hasUnmatched = unmatched.length > 0;

    let status: ThisWeekStatus;
    let attention_reason: string | undefined;

    if (open_exception_count > 0 || hasUnmatched) {
      status = "needs_attention";
      const reasons: string[] = [];
      if (open_exception_count > 0) {
        reasons.push(
          open_exception_count === 1
            ? "1 open issue needs review"
            : `${open_exception_count} open issues need review`,
        );
      }
      if (hasUnmatched) {
        reasons.push(
          unmatched.length === 1
            ? "1 survey respondent didn't match the roster"
            : `${unmatched.length} survey respondents didn't match the roster`,
        );
      }
      attention_reason = reasons.join(" · ");
    } else if (sources_missing.length === 0) {
      status = "ready";
    } else {
      status = "waiting";
    }

    rows.push({
      class_key: classKey,
      course_type: identity.course_type,
      class_date: identity.class_date,
      location: identity.location,
      sources_present,
      sources_missing,
      status,
      ...(attention_reason ? { attention_reason } : {}),
      sharepoint_uploaded_at,
      last_activity_at,
      open_exception_count,
    });
  }

  /* 5. Sort: earliest upcoming class first; tie-break on class_key for
        stable ordering across runs (important for E2E + screenshot
        diffs). */
  rows.sort((a, b) => {
    const d = a.class_date.localeCompare(b.class_date);
    if (d !== 0) return d;
    return a.class_key.localeCompare(b.class_key);
  });

  return rows;
}

/* ------------------------------------------------------------------ */
/* Date helpers — kept local so the aggregator is dep-free             */
/* ------------------------------------------------------------------ */

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
