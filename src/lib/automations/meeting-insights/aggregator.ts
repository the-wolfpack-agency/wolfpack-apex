/**
 * meeting-insights / aggregator — Phase 5 deterministic helpers.
 *
 * Pure functions, NO LLM calls. Phase 2 already produced one
 * `MeetingAnalysisRecord` per message; Phase 5 just groups, dedupes
 * and counts.
 *
 * Design notes:
 *   - Topic dedup is case-insensitive on the canonical `topic` label.
 *     The display label is the FIRST observed casing across analyses
 *     so the UI doesn't flip-flop between "Pricing" and "pricing".
 *   - Action item dedup key is `description + assignee`, both
 *     trimmed + lowercased. Empty/missing assignee falls back to
 *     "unassigned".
 *   - Decision dedup key is `description` trimmed + lowercased.
 *   - first_seen / last_seen on themes need the source message's
 *     `received_at` — the caller passes a `messageMeta` map keyed by
 *     `message_id`. Aggregator never touches the DB.
 */

import type {
  ActionItem,
  AggregatedTheme,
  Decision,
  MeetingAnalysisRecord,
} from "./types";

interface MessageMeta {
  received_at: string;
  subject: string;
}

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */

export function aggregateThemes(
  analyses: MeetingAnalysisRecord[],
  messageMeta: Map<string, MessageMeta> = new Map(),
): AggregatedTheme[] {
  // Map<lowercaseTopic, agg>
  const acc = new Map<
    string,
    {
      display: string;
      count: number;
      first_seen: string | null;
      last_seen: string | null;
    }
  >();

  for (const a of analyses) {
    const meta = messageMeta.get(a.message_id);
    const ts = meta?.received_at ?? a.created_at ?? null;
    for (const t of a.topics ?? []) {
      const raw = (t?.topic ?? "").trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const existing = acc.get(key);
      if (!existing) {
        acc.set(key, {
          display: raw,
          count: 1,
          first_seen: ts,
          last_seen: ts,
        });
      } else {
        existing.count += 1;
        if (ts) {
          if (!existing.first_seen || ts < existing.first_seen) {
            existing.first_seen = ts;
          }
          if (!existing.last_seen || ts > existing.last_seen) {
            existing.last_seen = ts;
          }
        }
      }
    }
  }

  const out: AggregatedTheme[] = Array.from(acc.values()).map((v) => ({
    topic: v.display,
    mention_count: v.count,
    first_seen: v.first_seen,
    last_seen: v.last_seen,
  }));

  // Sort by frequency desc, then alphabetical for stability.
  out.sort((a, b) => {
    if (b.mention_count !== a.mention_count) {
      return b.mention_count - a.mention_count;
    }
    return a.topic.localeCompare(b.topic);
  });

  return out;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function actionKey(a: ActionItem): string {
  const desc = (a.description ?? "").trim().toLowerCase();
  const who = (a.assignee ?? "unassigned").trim().toLowerCase() || "unassigned";
  return `${desc}|${who}`;
}

export function aggregateActions(
  analyses: MeetingAnalysisRecord[],
): ActionItem[] {
  const seen = new Map<string, ActionItem>();
  for (const a of analyses) {
    for (const item of a.action_items ?? []) {
      const desc = (item?.description ?? "").trim();
      if (!desc) continue;
      const key = actionKey(item);
      if (!seen.has(key)) {
        seen.set(key, {
          description: desc,
          assignee: item.assignee ?? null,
          due: item.due ?? null,
          source_message_id: item.source_message_id ?? a.message_id,
        });
      } else {
        // Prefer the earliest due date when duplicates carry
        // different ones (a recurring action with a fresh
        // deadline shouldn't be silently demoted).
        const cur = seen.get(key)!;
        if (item.due && (!cur.due || item.due < cur.due)) {
          cur.due = item.due;
        }
      }
    }
  }
  return Array.from(seen.values());
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

function decisionKey(d: Decision): string {
  return (d.description ?? "").trim().toLowerCase();
}

export function aggregateDecisions(
  analyses: MeetingAnalysisRecord[],
): Decision[] {
  const seen = new Map<string, Decision>();
  for (const a of analyses) {
    for (const d of a.decisions ?? []) {
      const desc = (d?.description ?? "").trim();
      if (!desc) continue;
      const key = decisionKey(d);
      if (!seen.has(key)) {
        seen.set(key, {
          description: desc,
          decided_by: d.decided_by ?? null,
          source_message_id: d.source_message_id ?? a.message_id,
        });
      }
    }
  }
  return Array.from(seen.values());
}
