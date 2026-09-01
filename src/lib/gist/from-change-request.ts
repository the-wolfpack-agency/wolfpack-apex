/**
 * A change request, expressed as an ordinary decision.
 *
 * WHY THIS SOURCE. Our own decisions are mostly unreadable: mapping 11,997
 * assistant turns, 93 per cent end "unknown", because a single-turn
 * conversation means satisfied or gave up and nothing can tell which. A change
 * request states its outcome. Somebody approved it, rejected it, or approved
 * it and reversed it later, and that last one is the most informative signal
 * any source carries.
 *
 * WE DO NOT KNOW THEIR SCHEMA, AND MUST NOT PRETEND TO. Every forms system is
 * configured per organization: the status column might be "Status", "State",
 * "Decision" or "Workflow Stage", and its values will be whatever somebody
 * typed when they built the form. So this DETECTS candidate columns and then
 * shows what it detected, rather than guessing silently and producing a
 * confident number from the wrong column.
 *
 * UNMAPPED STATUSES ARE REPORTED, NEVER BUCKETED QUIETLY. That is the lesson
 * from our own gist: four of the product's ten answer sources spent weeks
 * collapsing into "other" and nothing said so. A status this does not
 * recognize becomes "unknown" AND appears in the report, because a status
 * nobody mapped is a decision nobody can learn from.
 *
 * NOTHING THE FORM SAID SURVIVES. Titles, descriptions, names and comments are
 * read to classify and never carried out: the gist that leaves here holds a
 * category, a decider, a latency band and an ending, all from closed
 * vocabularies. That is what allows a client's change history to teach the
 * product without their change history going anywhere.
 */

import type { DecisionGist, DecisionEnding, DeciderKind } from "./decision";
import { endedWell, latencyBand } from "./decision";

/** Column names a forms export plausibly uses, in order of confidence. */
const COLUMN_HINTS = {
  status: ["status", "state", "decision", "outcome", "workflow stage", "stage", "approval"],
  created: ["created", "submitted", "date submitted", "submission time", "opened", "requested"],
  decided: ["decided", "completed", "closed", "approved on", "resolved", "date closed"],
  category: ["type", "category", "request type", "change type", "kind", "classification"],
} as const;

export type ColumnRole = keyof typeof COLUMN_HINTS;

/** Which column this export appears to use for each role, or null. */
export type ColumnMap = Record<ColumnRole, string | null>;

/**
 * Guess the columns, so a human can confirm rather than configure from scratch.
 *
 * Exact matches beat partial ones, and the FIRST hint wins on a tie, so a
 * sheet with both "Status" and "Approval Status" picks the plainer one.
 */
export function detectColumns(headers: string[]): ColumnMap {
  const map = {} as ColumnMap;
  for (const role of Object.keys(COLUMN_HINTS) as ColumnRole[]) {
    const hints = COLUMN_HINTS[role];
    const lower = headers.map((h) => h.toLowerCase().trim());
    let found: string | null = null;
    for (const hint of hints) {
      const exact = lower.indexOf(hint);
      if (exact !== -1) {
        found = headers[exact];
        break;
      }
    }
    if (!found) {
      for (const hint of hints) {
        const partial = lower.findIndex((h) => h.includes(hint));
        if (partial !== -1) {
          found = headers[partial];
          break;
        }
      }
    }
    map[role] = found;
  }
  return map;
}

/**
 * Status words to endings.
 *
 * Matched on the whole value, lowercased, because "Approved" and "Approved by
 * Finance" are the same decision and a partial match on "approve" would also
 * catch "Approval Pending", which is the opposite one.
 */
const ENDING_BY_STATUS: Array<{ ending: DecisionEnding; values: string[] }> = [
  {
    ending: "accepted",
    values: ["approved", "accepted", "complete", "completed", "done", "implemented", "closed - approved", "granted"],
  },
  {
    ending: "rejected",
    values: ["rejected", "denied", "declined", "not approved", "closed - rejected", "refused"],
  },
  {
    ending: "reversed",
    values: ["reversed", "rolled back", "backed out", "undone", "withdrawn after approval", "reverted"],
  },
  {
    ending: "abandoned",
    values: ["cancelled", "canceled", "abandoned", "withdrawn", "expired", "lapsed", "closed - no action"],
  },
  {
    ending: "pending",
    values: ["pending", "open", "in review", "under review", "submitted", "awaiting approval", "in progress", "new"],
  },
];

export interface MappedStatus {
  ending: DecisionEnding;
  /** False when the status was not recognized, so the report can say so. */
  recognized: boolean;
}

export function endingFromStatus(status: string): MappedStatus {
  const v = (status ?? "").trim().toLowerCase();
  if (!v) return { ending: "unknown", recognized: false };
  for (const group of ENDING_BY_STATUS) {
    if (group.values.includes(v)) return { ending: group.ending, recognized: true };
  }
  return { ending: "unknown", recognized: false };
}

export interface ChangeRequestReading {
  gists: DecisionGist[];
  /** Statuses the mapping did not recognize, with how often each appeared. */
  unmapped: Array<{ status: string; count: number }>;
  /** Rows skipped because they carried no status at all. */
  skipped: number;
}

/**
 * Read an export into decisions.
 *
 * A forms system has a human in the loop by definition, so the decider is
 * "human" unless the export says otherwise. That is the honest default: the
 * whole reason this source is interesting is that a person decided.
 */
export function readChangeRequests(
  rows: Array<Record<string, string>>,
  columns: ColumnMap,
  decider: DeciderKind = "human",
): ChangeRequestReading {
  const gists: DecisionGist[] = [];
  const unmappedCounts = new Map<string, number>();
  let skipped = 0;

  for (const row of rows) {
    const statusValue = columns.status ? row[columns.status] : "";
    if (!statusValue) {
      skipped += 1;
      continue;
    }

    const { ending, recognized } = endingFromStatus(statusValue);
    if (!recognized) {
      unmappedCounts.set(statusValue, (unmappedCounts.get(statusValue) ?? 0) + 1);
    }

    /* Latency only when BOTH ends are present and parse. A made-up duration
       would be indistinguishable from a real one in the output. */
    let latency: DecisionGist["latency"] = "instant";
    const created = columns.created ? Date.parse(row[columns.created] ?? "") : NaN;
    const decided = columns.decided ? Date.parse(row[columns.decided] ?? "") : NaN;
    if (Number.isFinite(created) && Number.isFinite(decided) && decided >= created) {
      latency = latencyBand(decided - created);
    }

    /* The category is the form's own type field, lowercased into a stable
       token. It stays a closed set in practice because a form offers a
       dropdown, and anything absent becomes "other" rather than free text. */
    const rawCategory = columns.category ? (row[columns.category] ?? "").trim() : "";
    const category = rawCategory
      ? rawCategory.toLowerCase().replace(/\s+/g, "_").slice(0, 40)
      : "other";

    gists.push({
      domain: "change_request",
      category,
      decider,
      latency,
      ending,
      wentWell: endedWell("change_request", ending),
    });
  }

  return {
    gists,
    unmapped: [...unmappedCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    skipped,
  };
}
