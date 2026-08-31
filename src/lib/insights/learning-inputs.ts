/**
 * Which learning capabilities have data to work with, and which are starved.
 *
 * WHAT THIS FOUND. Eleven signal extractors sit in src/lib/learning with no
 * caller: mail, calendar, files, contacts, org, planner, tasks, audit,
 * availability, team collaboration. The obvious reading is that somebody
 * forgot to wire them up. It is not what happened.
 *
 * Measured 2026-08-31: their source tables are EMPTY. instinct_ms_messages,
 * instinct_ms_events, instinct_ms_contacts, instinct_ms_files and every
 * instinct_teams table hold zero rows, and instinct_ms_sync_state holds a
 * single row for directory_users. The Microsoft sync has never run for mail,
 * calendar, contacts, files, Teams or OneNote. Not once.
 *
 * Meanwhile the product emitted 3,987,027 events and polled unread mail ten
 * thousand times in a day. It calls Graph live on every request and keeps
 * nothing, so the learning layer reads empty tables and produces nothing, and
 * an extractor with no caller looks identical to an extractor with no data.
 *
 * THOSE TWO NEED DIFFERENT PEOPLE, which is the whole reason this exists. An
 * unwired extractor is an afternoon of plumbing. A starved one is a decision
 * about what to cache, how long to keep it and who may read it, and no amount
 * of plumbing fixes it.
 *
 * IT REPORTS, IT DOES NOT REPAIR. What to cache from somebody's mailbox is not
 * a call a health check gets to make.
 */

export interface LearningInput {
  /** The extractor, as it is named on disk. */
  extractor: string;
  /** What it could tell somebody, if it had data. */
  couldAnswer: string;
  /** Tables it reads. Starved when all of them are empty. */
  sources: string[];
}

/**
 * Declared rather than discovered.
 *
 * Reading imports would find the tables and not what the extractor is FOR,
 * and "which questions can this deployment not answer yet" is the part worth
 * knowing.
 */
export const LEARNING_INPUTS: LearningInput[] = [
  {
    extractor: "mail-signals",
    couldAnswer: "who replies and who does not, and the hour a message is most likely to be answered",
    sources: ["instinct_sent_mail", "instinct_ms_messages"],
  },
  {
    extractor: "calendar-signals",
    couldAnswer: "how much of a week is meetings, and what the context switching costs",
    sources: ["instinct_calendar_events_written", "instinct_ms_events"],
  },
  {
    extractor: "file-signals",
    couldAnswer: "which documents are actually opened, and who works on the same ones",
    sources: ["instinct_ms_files_metadata", "instinct_audit_log"],
  },
  {
    extractor: "contact-signals",
    couldAnswer: "who this organisation deals with outside it, and how often",
    sources: ["instinct_ms_contacts"],
  },
  {
    extractor: "team-collaboration-signals",
    couldAnswer: "which channels carry the work, and where somebody was mentioned and missed it",
    sources: ["instinct_teams_channel_messages", "instinct_teams_channels"],
  },
  {
    extractor: "org-signals",
    couldAnswer: "who reports to whom, and how the org is actually shaped",
    sources: ["instinct_directory_users"],
  },
  {
    extractor: "planner-signals",
    couldAnswer: "what work is planned against what is happening",
    sources: ["instinct_planner_tasks", "instinct_planner_plans"],
  },
  {
    extractor: "task-correlations",
    couldAnswer: "what somebody has open, in the context of what they asked",
    sources: ["instinct_tasks"],
  },
  {
    extractor: "audit-signals",
    couldAnswer: "what changed, by whom, and whether anything unusual happened",
    sources: ["instinct_audit_log"],
  },
];

/**
 * Rows below which a source cannot support a signal.
 *
 * Fifty. Every one of these extractors computes a RATE or a PATTERN: who
 * replies and how often, which hour lands, which channels carry the work. Four
 * sent emails cannot tell you a reply rate, and reporting that source as
 * working overstates readiness in exactly the direction that gets discovered
 * by trusting an answer built on it.
 *
 * The first version of this check had no such threshold and duly reported
 * mail-signals as fed on four rows.
 */
export const MIN_ROWS_FOR_A_SIGNAL = 50;

export type InputState =
  /** Has enough data to compute something meaningful. */
  | "fed"
  /** Has rows, too few to support a rate or a pattern. */
  | "thin"
  /** Every source is empty. Not a wiring problem. */
  | "starved"
  /** A source table does not exist, so nothing could ever have written to it. */
  | "no-table";

export interface InputReading {
  input: LearningInput;
  state: InputState;
  /** Row counts per source, so the reason is visible rather than asserted. */
  counts: { table: string; rows: number | null }[];
}

/**
 * Decide the state from row counts.
 *
 * Null means the table is absent, which is a different fault from empty: one
 * is a migration that never ran, the other is a sync that never ran, and
 * telling somebody to check the wrong one wastes the afternoon this is meant
 * to save.
 */
export function readInput(
  input: LearningInput,
  counts: { table: string; rows: number | null }[],
): InputReading {
  const present = counts.filter((c) => c.rows !== null);
  if (present.length === 0) return { input, state: "no-table", counts };
  const most = Math.max(...present.map((c) => c.rows ?? 0));
  if (most === 0) return { input, state: "starved", counts };
  return { input, state: most >= MIN_ROWS_FOR_A_SIGNAL ? "fed" : "thin", counts };
}

export interface LearningReadiness {
  readings: InputReading[];
  fed: InputReading[];
  thin: InputReading[];
  starved: InputReading[];
  missingTables: InputReading[];
}

export function assessLearningInputs(readings: InputReading[]): LearningReadiness {
  return {
    readings,
    fed: readings.filter((r) => r.state === "fed"),
    thin: readings.filter((r) => r.state === "thin"),
    starved: readings.filter((r) => r.state === "starved"),
    missingTables: readings.filter((r) => r.state === "no-table"),
  };
}

export function describeLearningReadiness(r: LearningReadiness): string {
  const lines = [
    `${r.fed.length} of ${r.readings.length} learning capabilities have data to work with.`,
  ];

  if (r.thin.length > 0) {
    lines.push(
      ``,
      `${r.thin.length} have rows but too few to compute a rate or a pattern from. They will`,
      `produce an answer, and it will be built on a handful of observations, which is the`,
      `kind of number somebody quotes once and regrets.`,
      ``,
    );
    for (const t of r.thin) {
      const most = Math.max(...t.counts.map((c) => c.rows ?? 0));
      lines.push(`  ${t.input.extractor} (${most} row(s))`);
    }
  }
  if (r.starved.length > 0) {
    lines.push(
      ``,
      `${r.starved.length} are starved: the code is written and correct, and the tables it reads are empty.`,
      `That is not a wiring problem and no amount of plumbing fixes it. Something has to`,
      `populate them, which is a decision about what to keep rather than a bug to close.`,
      ``,
    );
    for (const s of r.starved) {
      lines.push(`  ${s.input.extractor}`, `    could answer: ${s.input.couldAnswer}`, ``);
    }
  }
  if (r.missingTables.length > 0) {
    lines.push(
      ``,
      `${r.missingTables.length} read a table that does not exist, which is a migration that never ran rather than a sync that never ran.`,
    );
  }
  return lines.join("\n");
}
