/**
 * Weekly auto-report builder.
 *
 * Pure function: takes a window of observations + the active
 * principles + a name lookup map, returns a markdown report grouped
 * by principle with per-member rollups, top-3 evidence rows, and a
 * "this principle is being ignored" flag when the trend is
 * consistently negative.
 *
 * The cron writes the markdown to instinct_principle_weekly_reports;
 * the team-tab UI surfaces the latest row as a banner. Leadership can
 * copy-paste into SharePoint at their discretion — auto-upload to
 * SharePoint is a future enhancement gated on Files.Write scope.
 *
 * Zero LLM tokens — all formatting is template-driven (per global
 * zero-tokens-first invariant).
 */

import type { ObservationRecord, PrincipleRecord } from "@/lib/principles/store";
import type { UserNameRecord } from "@/lib/principles/user-names";
import { writeQuery, safeQuery } from "@/lib/db";

export interface WeeklyReportInput {
  weekStart: Date;
  weekEnd: Date;
  principles: readonly PrincipleRecord[];
  observations: readonly ObservationRecord[];
  names: Map<string, UserNameRecord>;
}

export interface WeeklyReportRecord {
  id: string;
  weekStart: string;
  weekEnd: string;
  markdownBody: string;
  observationCount: number;
  principleCount: number;
  generatedAt: string;
}

interface WeeklyReportRow {
  id: string;
  week_start: string;
  week_end: string;
  markdown_body: string;
  observation_count: number;
  principle_count: number;
  generated_at: string;
}

function rowToReport(row: WeeklyReportRow): WeeklyReportRecord {
  return {
    id: row.id,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    markdownBody: row.markdown_body,
    observationCount: row.observation_count,
    principleCount: row.principle_count,
    generatedAt: row.generated_at,
  };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function meanScore(rows: readonly { score: number }[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((s, r) => s + r.score, 0) / rows.length;
}

/**
 * Pure builder. Tested directly in jest without any DB.
 */
export function buildWeeklyReportMarkdown(input: WeeklyReportInput): string {
  const { weekStart, weekEnd, principles, observations, names } = input;
  const lines: string[] = [];
  lines.push(`# Wolfpack — Principles Last Week`);
  lines.push("");
  lines.push(`**Window:** ${fmtDate(weekStart)} → ${fmtDate(weekEnd)}`);
  lines.push(
    `**Principles tracked:** ${principles.length}  |  **Observations:** ${observations.length}`,
  );
  lines.push("");
  lines.push(
    "_Patterns are signals for a conversation, not a verdict. Numbers are aggregate; click into Instinct's principles dashboard for evidence-level detail._",
  );
  lines.push("");

  /* Group observations by principleId. */
  const obsByPrinciple = new Map<string, ObservationRecord[]>();
  for (const o of observations) {
    const list = obsByPrinciple.get(o.principleId) ?? [];
    list.push(o);
    obsByPrinciple.set(o.principleId, list);
  }

  if (principles.length === 0) {
    lines.push(
      "_No principles defined yet. Once Hoxsie writes the first `## Principle:` section in the SharePoint doc, the next sync picks it up automatically._",
    );
    return lines.join("\n");
  }

  for (const p of principles) {
    const rows = obsByPrinciple.get(p.id) ?? [];
    const mean = meanScore(rows);
    const ignored = rows.length === 0;
    const drifting = !ignored && mean < -0.3;
    lines.push(`## ${p.title}`);
    if (p.owner) lines.push(`_Owner: ${p.owner}_`);
    lines.push("");
    if (ignored) {
      lines.push(
        "> ⚠️ **No observations this week.** Either no signal bound to a validator, or no member's data triggered the validator. Worth checking the principle's `**Signal:**` lines.",
      );
      lines.push("");
      continue;
    }
    lines.push(
      `**Observations:** ${rows.length}  |  **Mean score:** ${mean.toFixed(2)}  ${drifting ? "  |  ⚠️ trending toward drift" : ""}`,
    );
    lines.push("");

    /* Per-member rollup, sorted by lowest mean (most drift) first. */
    const byMember = new Map<string, ObservationRecord[]>();
    for (const o of rows) {
      const k = o.subjectUserId ?? "(team-wide)";
      const list = byMember.get(k) ?? [];
      list.push(o);
      byMember.set(k, list);
    }
    const memberRows = Array.from(byMember.entries())
      .map(([userId, list]) => {
        const name =
          userId === "(team-wide)"
            ? "(team-wide)"
            : names.get(userId)?.displayName ?? userId;
        return { userId, name, count: list.length, mean: meanScore(list) };
      })
      .sort((a, b) => a.mean - b.mean);

    lines.push("| Member | Observations | Mean score |");
    lines.push("|---|---:|---:|");
    for (const r of memberRows) {
      lines.push(`| ${r.name} | ${r.count} | ${r.mean.toFixed(2)} |`);
    }
    lines.push("");

    /* Top-3 most-negative observations as evidence callouts. */
    const top3 = [...rows].sort((a, b) => a.score - b.score).slice(0, 3);
    if (top3.length > 0 && top3.some((o) => o.score < 0)) {
      lines.push(`**Sample observations (most-drift first):**`);
      lines.push("");
      for (const o of top3) {
        const who = o.subjectUserId
          ? names.get(o.subjectUserId)?.displayName ?? o.subjectUserId
          : "(team-wide)";
        const notes =
          (o.evidenceJsonb as { notes?: unknown }).notes ?? "";
        const noteStr =
          typeof notes === "string" && notes
            ? ` — _${notes.slice(0, 120)}_`
            : "";
        lines.push(
          `- **${who}** · ${o.surface}${o.surfaceSubtype ? `/${o.surfaceSubtype}` : ""} · score ${o.score.toFixed(2)}${noteStr}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* DB persistence                                                      */
/* ------------------------------------------------------------------ */

export async function upsertWeeklyReport(args: {
  weekStart: string;
  weekEnd: string;
  markdownBody: string;
  observationCount: number;
  principleCount: number;
}): Promise<WeeklyReportRecord> {
  const result = await writeQuery<WeeklyReportRow>(
    `INSERT INTO instinct_principle_weekly_reports
       (week_start, week_end, markdown_body, observation_count, principle_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (week_start)
       DO UPDATE SET week_end = EXCLUDED.week_end,
                     markdown_body = EXCLUDED.markdown_body,
                     observation_count = EXCLUDED.observation_count,
                     principle_count = EXCLUDED.principle_count,
                     generated_at = NOW()
     RETURNING id, week_start, week_end, markdown_body,
               observation_count, principle_count, generated_at`,
    [
      args.weekStart,
      args.weekEnd,
      args.markdownBody,
      args.observationCount,
      args.principleCount,
    ],
  );
  return rowToReport(result.rows[0]);
}

export async function getLatestWeeklyReport(): Promise<WeeklyReportRecord | null> {
  const result = await safeQuery<WeeklyReportRow>(
    `SELECT id, week_start, week_end, markdown_body, observation_count,
            principle_count, generated_at
       FROM instinct_principle_weekly_reports
      ORDER BY generated_at DESC
      LIMIT 1`,
    [],
  );
  return result.rows[0] ? rowToReport(result.rows[0]) : null;
}
