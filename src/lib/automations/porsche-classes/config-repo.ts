/**
 * porsche-classes / config-repo — typed accessor for the operator-managed
 * configuration row in `instinct_automation_porsche_config` (migration
 * 090).
 *
 * Two payload shapes are stored today:
 *   - 'inbox_filters' → {sender_match, subject_match}
 *     Drives the inbox poller's mailbox filter, replacing the static
 *     array in `index.ts`.
 *   - 'sharepoint'    → {site_id, drive_id, path}
 *     Drives the SharePoint upload destination, preferred over the
 *     INSTINCT_SHAREPOINT_* env vars.
 *
 * Why a generic getConfig/setConfig pair PLUS typed helpers: the
 * /api/automations/porsche-classes/config route writes opaque JSON, so
 * the generic helpers stay at hand for forward-compat (a future
 * 'anthropic' or 'pcna_recipients' key drops in without touching this
 * file). The typed helpers encode the shape contracts the wizard relies
 * on, including defaults — a brand-new tenant with no config rows reads
 * the static fallback from `index.ts` (inbox_filters) or null
 * (sharepoint) so callers don't crash on a fresh deploy.
 *
 * Shadow mode (no DATABASE_URL): reads return defaults, writes throw
 * via writeQuery. The wizard surfaces the error inline.
 */

import { query, writeQuery } from "@/lib/db";

/* Strip leading + trailing slashes without a regex. The previous
   `/^\/+|\/+$/g` form has overlapping `+` quantifiers across an
   alternation that can backtrack on adversarial input (long runs of
   slashes in the middle of the string). Plain string scanning is
   linear and obviously bounded. */
function stripSlashes(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && input.charCodeAt(start) === 47 /* '/' */) start++;
  while (end > start && input.charCodeAt(end - 1) === 47) end--;
  return start === 0 && end === input.length ? input : input.slice(start, end);
}

/* ------------------------------------------------------------------ */
/* Typed payloads                                                      */
/* ------------------------------------------------------------------ */

export interface InboxFiltersConfig {
  sender_match: string[];
  subject_match: string[];
}

export interface SharepointConfig {
  site_id: string;
  drive_id: string;
  /** Folder path within the drive, NO leading or trailing slashes. */
  path: string;
}

export type PorscheConfigKey =
  | "inbox_filters"
  | "sharepoint"
  // Notify-summary-ready recipients. string[] of email addresses; the
  // wizard owns the writer (followed-up onboarding step). Read from
  // notify-summary-ready.ts via loadRecipients(); a missing row is a
  // no-op (no email sent, transition still recorded as
  // skipped_no_recipients so we don't re-check on every artifact).
  | "notify_recipients";

/**
 * Default inbox filters — mirror the static array in
 * src/lib/automations/porsche-classes/index.ts so a fresh deploy keeps
 * working pre-wizard. Kept in sync by exporting from `index.ts` and
 * re-using here would create a circular import; duplicating is the
 * simpler choice and the values rarely change.
 */
export const DEFAULT_INBOX_FILTERS: InboxFiltersConfig = {
  sender_match: [
    "porsche-academy-notification@porsche.de",
    "notifications@cognitoforms.com",
    "@thewolfpack.agency",
    /* Wildcard "@" — every email address contains it. Lets distinctive
       subjects (Survey Data PCBA, etc.) pass even when the sender is
       unknown. Remove once the survey-vendor address is known. */
    "@",
  ],
  subject_match: [
    "Scheduled Report Notification",
    "Coordinator Class Report",
    "Instructor Class Report",
    "Survey Data PCBA",
    // "Change Management Plan" + "Brand Ambassador" removed 2026-04-26:
    // not part of the class-summary workflow per operator
    // confirmation. They previously matched but had no parser, so
    // every such email quarantined.
  ],
};

/* ------------------------------------------------------------------ */
/* Generic accessors                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read a config row by key. Returns null when the row doesn't exist —
 * the typed helpers below convert that to a safe default. Returns null
 * (not throws) when the database is unreachable so the wizard's
 * GET /config still renders a "not configured yet" status indicator.
 */
export async function getConfig<T = unknown>(
  key: PorscheConfigKey,
): Promise<T | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await query<{ value: T }>(
      `SELECT value
         FROM instinct_automation_porsche_config
        WHERE key = $1`,
      [key],
    );
    return r.rows[0]?.value ?? null;
  } catch (err) {
    console.warn(
      `[porsche-classes/config-repo] getConfig(${key}) failed: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Write (UPSERT) a config row. Throws WriteQueryError on any failure —
 * silent-write-discard is unacceptable (per
 * memory feedback_no_silent_data_loss). The route layer catches and
 * surfaces a typed error to the operator.
 */
export async function setConfig(
  key: PorscheConfigKey,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_automation_porsche_config
       (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value      = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING key`,
    [key, JSON.stringify(value), updatedBy],
    { expectRows: 1 },
  );
}

/* ------------------------------------------------------------------ */
/* Typed helpers — the wizard + the registry both consume these        */
/* ------------------------------------------------------------------ */

/**
 * Resolve effective inbox filters: stored row if present, else the
 * shipped defaults. Coerces missing arrays to [] so the consumer can
 * safely call `.some(...)` without a nullish guard.
 */
export async function getInboxFilters(): Promise<InboxFiltersConfig> {
  const stored = await getConfig<Partial<InboxFiltersConfig>>("inbox_filters");
  if (!stored) return DEFAULT_INBOX_FILTERS;
  return {
    sender_match: Array.isArray(stored.sender_match)
      ? stored.sender_match.filter((s): s is string => typeof s === "string")
      : DEFAULT_INBOX_FILTERS.sender_match,
    subject_match: Array.isArray(stored.subject_match)
      ? stored.subject_match.filter((s): s is string => typeof s === "string")
      : DEFAULT_INBOX_FILTERS.subject_match,
  };
}

export async function setInboxFilters(
  value: InboxFiltersConfig,
  updatedBy: string,
): Promise<void> {
  if (!Array.isArray(value.sender_match) || !Array.isArray(value.subject_match)) {
    throw new Error(
      "setInboxFilters: sender_match and subject_match must be arrays",
    );
  }
  // Normalize — trim, drop empty strings, dedupe — so the operator never
  // accidentally saves "  " or duplicate entries from a copy/paste.
  const norm = (arr: string[]): string[] =>
    Array.from(
      new Set(
        arr
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    );
  await setConfig(
    "inbox_filters",
    {
      sender_match: norm(value.sender_match),
      subject_match: norm(value.subject_match),
    },
    updatedBy,
  );
}

/**
 * Read the SharePoint destination. Returns null when no config row
 * exists — the SharePoint upload module then falls back to env vars,
 * which is the legacy / pre-wizard path.
 */
export async function getSharepointConfig(): Promise<SharepointConfig | null> {
  const stored = await getConfig<Partial<SharepointConfig>>("sharepoint");
  if (!stored) return null;
  // Strict typecheck — a partial / corrupted row should NOT silently
  // hand back a half-populated config that crashes Graph at runtime.
  if (
    typeof stored.site_id !== "string" ||
    typeof stored.drive_id !== "string" ||
    typeof stored.path !== "string"
  ) {
    return null;
  }
  return {
    site_id: stored.site_id.trim(),
    drive_id: stored.drive_id.trim(),
    path: stripSlashes(stored.path.trim()),
  };
}

export async function setSharepointConfig(
  value: SharepointConfig,
  updatedBy: string,
): Promise<void> {
  if (
    typeof value.site_id !== "string" ||
    typeof value.drive_id !== "string" ||
    typeof value.path !== "string"
  ) {
    throw new Error(
      "setSharepointConfig: site_id, drive_id, path must all be strings",
    );
  }
  const trimmed: SharepointConfig = {
    site_id: value.site_id.trim(),
    drive_id: value.drive_id.trim(),
    path: stripSlashes(value.path.trim()),
  };
  if (!trimmed.site_id || !trimmed.drive_id || !trimmed.path) {
    throw new Error(
      "setSharepointConfig: site_id, drive_id, path must each be non-empty",
    );
  }
  await setConfig("sharepoint", trimmed, updatedBy);
}
