/**
 * The SHAPE of a pilot status reading, and the arithmetic over it.
 *
 * Split from the reader (status.ts) because the widget renders these and the
 * reader imports pg. A client component that transitively pulls in the
 * database driver breaks the build a long way from the import that caused it.
 * Same split as phase-one-shape.ts, for the same reason.
 *
 * WHY THIS FILE IS MOSTLY ABOUT NOT KNOWING THINGS.
 *
 * A status answer is the one place a zero is most likely to be read as good
 * news. "No blockers" and "could not reach your tasks" produce the same empty
 * list, and only one of them is worth telling a client. On 2026-08-26 six
 * separate controls in this product were found declared, accurately described
 * and never executed, every one of them reporting a zero that a reader took
 * for a clean bill of health.
 *
 * So the arithmetic here returns `null`, never `0`, for anything it could not
 * measure, every source carries the reason it is dark, and the headline
 * verdict refuses to be optimiztic about a system it could not read. A tool
 * that says "on track" because the task store was down is worse than a tool
 * that says nothing.
 */

/** Whether a source could be read at all, and if not, why. */
export type SourceState =
  /** Read successfully. `items` is the truth, including when it is empty. */
  | "ok"
  /** The integration behind it has never been connected. Not an error. */
  | "not_connected"
  /** Connected, and the read failed. The count is unknown, NOT zero. */
  | "unavailable";

/**
 * One source's contribution to the join, carrying its own state.
 *
 * The state travels WITH the data rather than beside it, so no consumer can
 * count `items.length` without having had the chance to see that the list is
 * empty because nobody looked.
 */
export interface SourceReading<T> {
  state: SourceState;
  /** Why the state is not ok, in words a reader can act on. Null when ok. */
  detail: string | null;
  items: T[];
}

/** A meeting on the calendar, trimmed to what a status view needs. */
export interface StatusMeeting {
  id: string;
  subject: string;
  start: string;
  attendees: string[];
  minutesUntil: number | null;
}

/** A document that landed in the Brain. */
export interface StatusDocument {
  id: string;
  filename: string;
  createdAt: string;
  /** Indexed and answerable, versus merely uploaded. */
  indexed: boolean;
}

/** An open or recently-closed unit of work. */
export interface StatusTask {
  id: string;
  title: string;
  dueAt: string | null;
  overdue: boolean;
  completed: boolean;
}

/** The three sources, joined, each still carrying whether it was read. */
export interface PilotStatusReading {
  /** Instant the reading was taken, so a stale render is visible as stale. */
  takenAt: string;
  /** How far back the reading looked, in days. */
  windowDays: number;
  calendar: SourceReading<StatusMeeting>;
  documents: SourceReading<StatusDocument>;
  tasks: SourceReading<StatusTask>;
}

/**
 * How confident the answer is entitled to be.
 *
 * `unknown` is a first-class outcome, not a failure mode. It is what an honest
 * system says when it read one source out of three.
 */
export type Readiness = "on_track" | "at_risk" | "blocked" | "unknown";

/** A cross-source observation. The reason this tool exists. */
export interface StatusSignal {
  id: string;
  /** blocker = in the way now. watch = will be in the way. good = momentum. */
  tone: "blocker" | "watch" | "good" | "dark";
  title: string;
  detail: string;
  /**
   * Which sources had to be readable to produce this. A one-source signal is
   * a list; a two-source signal is the thing no single tool can see, and the
   * widget leads with those.
   */
  sources: Array<"calendar" | "documents" | "tasks">;
}

/**
 * How a source is named when the product says it out loud.
 *
 * The internal keys are lowercase and reached client-facing sentences as
 * "tasks unavailable" mid-paragraph and "tasks could not be read" as a
 * headline. Small, and it is the copy a client reads first.
 */
export const SOURCE_LABEL: Record<"calendar" | "documents" | "tasks", string> = {
  calendar: "Calendar",
  documents: "Brain",
  tasks: "Tasks",
};

/** Sources that were read successfully. */
export function readableSources(r: PilotStatusReading): Array<"calendar" | "documents" | "tasks"> {
  const out: Array<"calendar" | "documents" | "tasks"> = [];
  if (r.calendar.state === "ok") out.push("calendar");
  if (r.documents.state === "ok") out.push("documents");
  if (r.tasks.state === "ok") out.push("tasks");
  return out;
}

/** Sources that could not be read, with the reason each gave. */
export function darkSources(
  r: PilotStatusReading,
): Array<{ source: "calendar" | "documents" | "tasks"; state: SourceState; detail: string | null }> {
  const all = [
    { source: "calendar" as const, reading: r.calendar },
    { source: "documents" as const, reading: r.documents },
    { source: "tasks" as const, reading: r.tasks },
  ];
  return all
    .filter((a) => a.reading.state !== "ok")
    .map((a) => ({ source: a.source, state: a.reading.state, detail: a.reading.detail }));
}

/**
 * Open tasks, or null when the task store could not be read.
 *
 * NULL, NOT ZERO. This is the whole discipline of the file in one function.
 * "You have 0 tasks left" and "I could not reach your tasks" are opposite
 * answers to "what is left to do", and a number cannot carry the difference.
 */
export function openTaskCount(r: PilotStatusReading): number | null {
  if (r.tasks.state !== "ok") return null;
  return r.tasks.items.filter((t) => !t.completed).length;
}

/** Overdue tasks, or null when the task store could not be read. */
export function overdueTaskCount(r: PilotStatusReading): number | null {
  if (r.tasks.state !== "ok") return null;
  return r.tasks.items.filter((t) => !t.completed && t.overdue).length;
}

/** Work closed inside the window, or null when unreadable. */
export function completedTaskCount(r: PilotStatusReading): number | null {
  if (r.tasks.state !== "ok") return null;
  return r.tasks.items.filter((t) => t.completed).length;
}

/** Documents that landed in the window, or null when unreadable. */
export function documentsLanded(r: PilotStatusReading): number | null {
  if (r.documents.state !== "ok") return null;
  return r.documents.items.length;
}

/** Documents that landed but are not answerable yet, or null when unreadable. */
export function documentsNotIndexed(r: PilotStatusReading): number | null {
  if (r.documents.state !== "ok") return null;
  return r.documents.items.filter((d) => !d.indexed).length;
}

/** The next meeting, or null when there is none or the calendar is dark. */
export function nextMeeting(r: PilotStatusReading): StatusMeeting | null {
  if (r.calendar.state !== "ok") return null;
  const upcoming = r.calendar.items
    .filter((m) => m.minutesUntil !== null && m.minutesUntil >= 0)
    .sort((a, b) => (a.minutesUntil ?? 0) - (b.minutesUntil ?? 0));
  return upcoming[0] ?? null;
}

/**
 * The headline verdict.
 *
 * REFUSES TO BE OPTIMIZTIC ABOUT WHAT IT DID NOT READ. With fewer than two
 * readable sources there is no cross-system view to have an opinion about, so
 * the answer is `unknown` however clean the one source that answered looked.
 * A dark task store is exactly the condition under which "on track" is both
 * most tempting and most wrong.
 */
export function readiness(r: PilotStatusReading): Readiness {
  if (readableSources(r).length < 2) return "unknown";

  const overdue = overdueTaskCount(r);
  const open = openTaskCount(r);
  const next = nextMeeting(r);

  /* Overdue work with a checkpoint already in the diary is the definition of
     blocked: the date will arrive whether the work does or not. */
  if (overdue !== null && overdue > 0 && next !== null) return "blocked";
  if (overdue !== null && overdue > 2) return "blocked";
  if (overdue !== null && overdue > 0) return "at_risk";

  /* A checkpoint with nothing landed against it since the window opened. */
  const landed = documentsLanded(r);
  if (next !== null && landed === 0) return "at_risk";

  /* Open work and no checkpoint booked to review it. */
  if (open !== null && open > 0 && r.calendar.state === "ok" && next === null) return "at_risk";

  return "on_track";
}

/** Plain-language label for a readiness value. */
export function readinessLabel(v: Readiness): string {
  switch (v) {
    case "on_track":
      return "On track";
    case "at_risk":
      return "At risk";
    case "blocked":
      return "Blocked";
    default:
      return "Not enough signal";
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Format a meeting's start for a human, in the reader's zone. */
export function formatWhen(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unreadable date";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(d);
  } catch {
    /* An invalid zone from the browser must not take the whole answer down. */
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/**
 * Turn a reading into the observations worth saying out loud.
 *
 * Rule-based and zero-token. Every rule states the sources it needed, and no
 * rule fires from a source that was not read. The `dark` signals are emitted
 * LAST but are never omitted: the partial view has to announce itself, or the
 * reader draws a conclusion from three lists when only one had data.
 */
export function buildSignals(r: PilotStatusReading, timeZone?: string): StatusSignal[] {
  const out: StatusSignal[] = [];
  const overdue = overdueTaskCount(r);
  const open = openTaskCount(r);
  const done = completedTaskCount(r);
  const landed = documentsLanded(r);
  const unindexed = documentsNotIndexed(r);
  const next = nextMeeting(r);

  /* CROSS-SOURCE. Two systems, one fact neither holds alone. These lead. */
  if (next && overdue !== null && overdue > 0) {
    out.push({
      id: "overdue-before-checkpoint",
      tone: "blocker",
      title: `${overdue} overdue ${plural(overdue, "task", "tasks")} before ${next.subject}`,
      detail: `${next.subject} is ${formatWhen(next.start, timeZone)} and ${overdue} ${plural(overdue, "item is", "items are")} already past due. The date arrives whether the work does or not.`,
      sources: ["calendar", "tasks"],
    });
  }

  if (next && landed === 0) {
    out.push({
      id: "checkpoint-without-material",
      tone: "watch",
      title: `Nothing new in the Brain before ${next.subject}`,
      detail: `No document has landed in the last ${r.windowDays} days, and ${next.subject} is ${formatWhen(next.start, timeZone)}. There is nothing recent to review from.`,
      sources: ["calendar", "documents"],
    });
  }

  if (next && landed !== null && landed > 0 && overdue === 0) {
    out.push({
      id: "checkpoint-prepared",
      tone: "good",
      title: `${landed} ${plural(landed, "document", "documents")} ready for ${next.subject}`,
      detail: `Landed in the last ${r.windowDays} days, nothing overdue against it. ${next.subject} is ${formatWhen(next.start, timeZone)}.`,
      sources: ["calendar", "documents", "tasks"],
    });
  }

  /* SINGLE-SOURCE. Useful, but not the reason this tool exists. */
  if (open !== null && open > 0) {
    out.push({
      id: "work-remaining",
      tone: overdue !== null && overdue > 0 ? "watch" : "good",
      title: `${open} open ${plural(open, "item", "items")} left to do`,
      detail:
        done !== null && done > 0
          ? `${done} closed in the last ${r.windowDays} days.`
          : `Nothing closed in the last ${r.windowDays} days.`,
      sources: ["tasks"],
    });
  }

  if (open === 0) {
    out.push({
      id: "work-clear",
      tone: "good",
      title: "No open work items",
      detail: `The task store answered and it is empty${done !== null && done > 0 ? `, with ${done} closed in the last ${r.windowDays} days` : ""}.`,
      sources: ["tasks"],
    });
  }

  if (unindexed !== null && unindexed > 0) {
    out.push({
      id: "documents-not-answerable",
      tone: "watch",
      title: `${unindexed} ${plural(unindexed, "document is", "documents are")} not answerable yet`,
      detail: "Uploaded but not indexed, so the assistant cannot quote from it.",
      sources: ["documents"],
    });
  }

  /* THE PARTIAL VIEW ANNOUNCES ITSELF. Never omitted, never softened. */
  for (const d of darkSources(r)) {
    out.push({
      id: `dark-${d.source}`,
      tone: "dark",
      title:
        d.state === "not_connected"
          ? `${SOURCE_LABEL[d.source]} is not connected`
          : `${SOURCE_LABEL[d.source]} could not be read`,
      detail:
        d.detail ??
        (d.state === "not_connected"
          ? "Connect it in Settings to include it here."
          : "The read failed, so anything counted from it would be a guess."),
      sources: [d.source],
    });
  }

  return out;
}

/**
 * The one-line answer, spoken.
 *
 * Leads with the verdict, names the sources it is based on, and names the ones
 * it is not. A reader must never have to open the widget to discover that a
 * third of the picture was missing.
 */
export function summarize(r: PilotStatusReading, timeZone?: string): string {
  const readable = readableSources(r);
  const dark = darkSources(r);
  const v = readiness(r);

  if (v === "unknown") {
    const names = dark.map((d) => SOURCE_LABEL[d.source]).join(", ");
    return readable.length === 0
      ? `I could not read the calendar, the Brain or your tasks, so I have nothing to base an answer on. Nothing here is a zero; it is an unknown.`
      : `I can only see ${readable.map((r) => SOURCE_LABEL[r]).join(" and ")} right now (${names} unavailable), which is not enough to say how the pilot is going without guessing at the rest.`;
  }

  const parts: string[] = [];
  const open = openTaskCount(r);
  const overdue = overdueTaskCount(r);
  const landed = documentsLanded(r);
  const next = nextMeeting(r);

  if (open !== null) parts.push(`${open} open ${plural(open, "item", "items")}${overdue ? ` (${overdue} overdue)` : ""}`);
  if (landed !== null) parts.push(`${landed} ${plural(landed, "document", "documents")} in the last ${r.windowDays} days`);
  if (next) parts.push(`next checkpoint ${formatWhen(next.start, timeZone)}`);

  const tail = dark.length
    ? ` Reading ${readable.map((r) => SOURCE_LABEL[r]).join(" and ")}; ${dark.map((d) => SOURCE_LABEL[d.source]).join(" and ")} unavailable, so this is a partial view.`
    : "";

  return `${readinessLabel(v)}: ${parts.join(", ")}.${tail}`;
}
