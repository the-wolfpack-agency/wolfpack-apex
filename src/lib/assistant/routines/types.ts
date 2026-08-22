/**
 * Routines — a named sequence of the things somebody already does by hand.
 *
 * THE OBSERVATION THIS IS BUILT ON
 *
 * There is a ceiling on how much software one person touches in a day. They
 * open mail, read a thread, check a calendar, write something, ping a
 * colleague, file a ticket. It is a short list, and it is the same short list
 * five days a week. What makes it feel large is that each action lives in a
 * different tool, so the PERSON is the integration layer: they carry context
 * out of one window and retype it into the next.
 *
 * A routine is that carrying, done for them. Not new software -- the same
 * actions, in the same order, executed the way they would execute them.
 *
 * THREE KINDS OF STEP, AND THE THIRD IS THE PRODUCT
 *
 * A tool step runs one registered tool. A model step turns what the earlier
 * steps returned into something a person can act on. A human step STOPS.
 *
 * The temptation is to build the version that runs the whole chain unattended
 * and reports at the end. That is the wrong shape for work somebody is
 * accountable for, and it is also the less valuable one, because a routine
 * that pauses records something no dashboard has: the boundary between what
 * the tech did and what the person did, and how long the person's part took.
 *
 * A month of that turns opinions into arithmetic. The step everybody edits
 * means the tool before it is wrong. The step everybody approves unchanged
 * does not need a human, and deleting the pause gives them the minutes back.
 * The routine abandoned halfway has something worse than doing it by hand in
 * the middle of it. See RoutineRun's timing fields, which exist for exactly
 * this and are the reason a run is persisted at all.
 *
 * DELIBERATELY NOT A SCRIPTING LANGUAGE
 *
 * Steps run in order. A later step reads an earlier step's output from a named
 * slot, by string substitution into validated tool parameters. There are no
 * loops, no branches and no expressions.
 *
 * That ceiling is the point rather than a stage to grow out of. A routine
 * anyone can read is one an operator will trust with their mailbox; the moment
 * it needs control flow it has stopped describing somebody's morning and
 * become a program, and a program with no tests, no reviewer and no type
 * checker does not belong between a client and their customers.
 */

/** Where a step's output is stored for later steps to read. */
export type SlotName = string;

export interface ToolStep {
  kind: "tool";
  /** Slot this step's result is written to. Omit for a step nothing reads. */
  slot?: SlotName;
  /** Registered tool name, e.g. "search_mail". Resolved at run time so a
   *  routine saved against a tool that has since been removed fails as a
   *  reported step rather than a broken run. */
  tool: string;
  /** Parameters, with {{slot}} references substituted before validation. */
  params: Record<string, unknown>;
  /** What the person sees while it runs. Written for them, not for a log. */
  label: string;
}

export interface ModelStep {
  kind: "model";
  slot?: SlotName;
  /** The question, with {{slot}} references substituted. Goes through the
   *  router, so it inherits redaction, residency, the budget and the content
   *  policy -- a routine cannot reach a model on softer terms than a person. */
  prompt: string;
  label: string;
}

export interface HumanStep {
  kind: "human";
  /** What the person is being asked to do. A pause with no question is just a
   *  stall, and it is how a chain gets abandoned. */
  label: string;
  /** Slots to put in front of them so the ask is answerable without hunting
   *  back through the run. */
  show?: SlotName[];
}

export type RoutineStep = ToolStep | ModelStep | HumanStep;

export interface Routine {
  /** Stable id, snake_case. Used in analytics and in the ledger. */
  id: string;
  /** What somebody types to run it: "run my morning". */
  command: string;
  /** One line, in the owner's words, about what it saves them. */
  description: string;
  /** Who this is for. Presentation only -- never authority, which stays with
   *  the capability gate on each tool. */
  audience: "anyone" | "engineer" | "leadership" | "sales" | "service";
  steps: RoutineStep[];
}

/** What a step did, or why it did not. */
export type StepStatus = "ok" | "failed" | "skipped" | "waiting";

export interface StepOutcome {
  index: number;
  kind: RoutineStep["kind"];
  label: string;
  status: StepStatus;
  /** Milliseconds the MACHINE spent. Never includes time a person was
   *  thinking: those are counted separately and the distinction is the whole
   *  measurement. */
  durationMs: number;
  /** Present on a failure, in the words the person needs, not a stack. */
  error?: string;
  /** The user-facing answer this step produced, when it produced one. */
  answer?: string;
  /** Slot written, for reading a run back without re-deriving it. */
  slot?: SlotName;
}

export type RunState = "running" | "waiting_for_human" | "done" | "failed";

export interface RoutineRun {
  runId: string;
  routineId: string;
  userId: string;
  workspaceId: string;
  state: RunState;
  /** Index of the step to run NEXT. On a paused run this is the human step,
   *  so resuming is "carry on from here" rather than a replay. */
  cursor: number;
  outcomes: StepOutcome[];
  /** Slot contents. Kept for the run's lifetime so a resume does not re-fetch
   *  a mailbox that has moved on since the person was asked to look at it. */
  slots: Record<SlotName, unknown>;
  /** Total machine time across every step so far. */
  techMs: number;
  /** Total time spent WAITING FOR A PERSON. The number that turns "this
   *  routine feels slow" into "step four costs eleven minutes a day". */
  humanMs: number;
  /**
   * When the run stopped at a human step, as a millisecond timestamp.
   *
   * Persisted rather than derived: it is the only record of when the handoff
   * happened, and the whole human-cost measurement is the difference between
   * this and the moment the person came back. Null on a run that is not
   * waiting, so "we are not waiting on anybody" is a value rather than an
   * absence to be inferred.
   */
  pausedAt?: number | null;
}
