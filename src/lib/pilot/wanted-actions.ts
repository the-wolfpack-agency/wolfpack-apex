/**
 * What people expected the product to DO, without quoting them.
 *
 * WHY THIS BUCKET IS DIFFERENT FROM THE OTHERS. The three question buckets ask
 * about the business, so shortening and masking a known name makes them safe.
 * This one holds instructions, and an instruction is about somebody's own work:
 * who they wanted a meeting with, which client's email to file, who to route a
 * change to. The entity IS the sensitive part and it is usually the only part
 * the directory does not know, so masking is at its weakest exactly where the
 * risk is highest.
 *
 * Measured on our own log: "book me 30 minutes with dana tomorrow" and
 * "collect out rubycar marketing emails into one folder" both survived the
 * directory mask, because neither the colleague nor the client appears in any
 * table this workspace holds. That is not a gap in the mask to be patched. It
 * is the mask being asked to do a job it cannot do.
 *
 * SO THE VERB CARRIES THE SIGNAL AND THE REST IS DROPPED. A reader needs to
 * know people expected it to schedule meetings and file email. Which meeting
 * and whose email adds nothing to that and cannot be published safely, so no
 * free text renders here at all: the phrase comes from a fixed list, and an
 * instruction whose verb is not on the list is counted rather than described.
 */

/** Verb to what a reader would call it. The whole rendered vocabulary. */
const ACTION_PHRASE: Record<string, string> = {
  book: "schedule a meeting",
  schedule: "schedule a meeting",
  "set up": "schedule a meeting",
  remind: "set a reminder",
  send: "send something on someone's behalf",
  share: "share something",
  invite: "invite someone",
  collect: "file or move email",
  file: "file or move email",
  move: "file or move email",
  archive: "file or move email",
  sort: "file or move email",
  organize: "file or move email",
  /* Kept because people type it: the verb the product reads is whatever
     somebody actually wrote, and this list is about matching them, not about
     how we spell. */
  organise: "file or move email",
  assign: "assign work to someone",
  create: "create a record",
  make: "create a record",
  add: "create a record",
  upload: "put a document in",
  export: "export data",
  delete: "delete something",
  remove: "delete something",
  rename: "rename something",
  "turn on": "change a setting",
  "turn off": "change a setting",
};

export interface WantedAction {
  /** From the fixed list above. Never derived from what somebody typed. */
  action: string;
  /** How many times it was asked for, across every phrasing. */
  asked: number;
}

export interface WantedSummary {
  actions: WantedAction[];
  /**
   * Instructions whose verb is not on the list.
   *
   * Counted rather than dropped. An instruction nobody can see is
   * indistinguishable from nobody having wanted it, and this bucket exists
   * precisely because people do not file requests for things they assumed
   * would work.
   */
  other: number;
}

/** The verb, taken only from the front, so nothing mid-sentence can be read. */
export function actionOf(query: string): string | null {
  const q = (query ?? "").trim().toLowerCase().replace(/^[\s\-*•>"'`(\[]+/, "");
  /* Two-word verbs first: "set up a call" is scheduling, and matching "set"
     alone would miss it. */
  for (const verb of ["set up", "turn on", "turn off"]) {
    if (q.startsWith(`${verb} `)) return ACTION_PHRASE[verb];
  }
  const first = q.split(/[^a-z]+/)[0];
  return ACTION_PHRASE[first] ?? null;
}

/** How many people wanted each thing, most-wanted first. */
export function summarizeWanted(
  items: readonly { query: string; asked: number }[],
  top: number,
): WantedSummary {
  const counts = new Map<string, number>();
  let other = 0;
  for (const i of items) {
    const action = actionOf(i.query);
    if (!action) {
      other += i.asked;
      continue;
    }
    counts.set(action, (counts.get(action) ?? 0) + i.asked);
  }
  const actions = [...counts.entries()]
    .map(([action, asked]) => ({ action, asked }))
    .sort((a, b) => b.asked - a.asked || a.action.localeCompare(b.action))
    .slice(0, top);
  return { actions, other };
}
