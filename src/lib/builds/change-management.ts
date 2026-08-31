/**
 * Replacing the Change Management Plan, as something a page can render.
 *
 * WHY THIS IS DATA AND NOT PROSE IN A COMPONENT. Every figure below was
 * measured: the forms came from a read-only walk of the tenant, the flow came
 * from the client's own training material, the vendors came from watching the
 * network, and the volume came from their strategy deck. Holding them here
 * means a test can pin them and a page cannot quietly drift from them, which
 * matters more than usual for a document whose whole argument is that we
 * measured their process and they have not.
 *
 * WHAT IS DELIBERATELY MISSING. The fields of the plan itself. The walk could
 * not read them: the forms are built in a canvas editor that renders inputs
 * without form elements, which our reader was only taught to handle
 * afterwards. A concept written around invented fields would be a concept
 * about a form we imagined, so the design below is about the SHAPE of the
 * process and says so.
 */

/** Measured on the tenant on 2026-08-30, and in their own material. */
export const EVIDENCE = {
  surfacesWalked: 39,
  formsFound: 13,
  /** Forms whose name contains "change management". One is named "test". */
  changePlanForms: 3,
  /** Third-party hosts contacted while walking. */
  thirdPartyHosts: 7,
  /** Screens the two analytics vendors were present on. */
  vendorScreens: 38,
  slowestScreenMs: 17_842,
  /** BA102 classes per cycle, from the 2026 strategy. */
  ba102Classes: 10,
  participantsPerClass: 32,
} as const;

export const PLANS_PER_CYCLE = EVIDENCE.ba102Classes * EVIDENCE.participantsPerClass;

/** Their own words, from BA102 day three. The whole design answers this. */
export const THEIR_DESCRIPTION =
  "You will build your Change Management Plan by following the link in your Training Guide on PMA. " +
  "This will let you share your plan with managers, update it as you go, and discuss during coaching.";

export interface FlowStep {
  step: string;
  /** Where it happens today. */
  today: string;
  /** True when a form builder can hold it. */
  heldByAForm: boolean;
}

/**
 * The process as they describe it, against what the current tool can hold.
 *
 * Three of the four moments happen AFTER submission, which is the finding the
 * rest of this document follows from. A form is an excellent way to capture an
 * answer once, and this is not a thing that happens once.
 */
export const FLOW: FlowStep[] = [
  {
    step: "Write the plan after the class",
    today: "A form, reached from a link in the Training Guide on PMA.",
    heldByAForm: true,
  },
  {
    step: "Share it with the manager",
    today: "The participant sends it. Nothing records that it arrived.",
    heldByAForm: false,
  },
  {
    step: "Update it over the following weeks",
    today: "A new submission, or nothing. The earlier version is not a version.",
    heldByAForm: false,
  },
  {
    step: "Discuss it in coaching",
    today: "A conversation. Whatever is agreed lives in somebody's notes.",
    heldByAForm: false,
  },
];

export interface Finding {
  title: string;
  detail: string;
  /** What was measured, so the claim is checkable rather than asserted. */
  evidence: string;
}

/**
 * A CORRECTION, KEPT VISIBLE.
 *
 * An earlier reading of this program concluded that nothing follows up and
 * that four weeks of silence is the failure mode. That was wrong, and it was
 * wrong because it read the form builder rather than the course. BA101 Mobile
 * Coach Rules is 115 rows of SMS script that tells participants "I'll check in
 * weekly this year". Follow-through exists. What it lacks is any knowledge of
 * what the individual committed to, which is a far better problem and a far
 * cheaper one. Put in front of the client, the original claim would have been
 * contradicted by their own material.
 */
export const FOLLOW_UP_CORRECTION =
  "A weekly SMS coach already runs for a year after class. The gap is not that nobody follows up, " +
  "it is that the follow-up asks how valuable the program was rather than how the participant's own " +
  "commitment is going.";

export const FINDINGS: Finding[] = [
  {
    title: "A submission is not a living record",
    detail:
      "Sharing, updating and discussing are a second person and a timeline. Neither exists: no assignment, no review, no revision history.",
    evidence: `${EVIDENCE.surfacesWalked} screens walked, none of them a workflow screen.`,
  },
  {
    title: "A plan cannot be connected to an outcome",
    detail:
      "Plans, class reports and survey responses are separate form silos. Nobody can ask whether the people who wrote a plan behaved differently afterwards, which is the only question the exercise exists to answer.",
    evidence: `${EVIDENCE.formsFound} forms found, each with its own entries list and no join between them.`,
  },
  {
    title: "Participant data shares every page with vendors nobody chose",
    detail:
      "Two analytics vendors load alongside the form. That is the platform's decision rather than the client's, and it is invisible from inside the account. Whether either records sessions is worth asking before more participant data goes through it.",
    evidence: `${EVIDENCE.thirdPartyHosts} third-party hosts contacted, two vendors present on ${EVIDENCE.vendorScreens} of the screens.`,
  },
  {
    title: "Three plans, one of them named test",
    detail:
      "There is no versioning, so changing the instrument means a new form and a split history. The live tenant currently carries a test copy alongside the real ones.",
    evidence: `${EVIDENCE.changePlanForms} change management forms, all published.`,
  },
  {
    title: "It is slow enough to be noticed",
    detail:
      "Slow matters more here than it looks: the plan is written at the end of a three-day class, by someone who wants to leave.",
    evidence: `Slowest screen ${(EVIDENCE.slowestScreenMs / 1000).toFixed(1)}s.`,
  },
];

/**
 * A commitment's life. The state machine is the design.
 *
 * The states are chosen so that DOING NOTHING is visible. Every failure of a
 * post-training commitment looks the same from outside: silence. A model where
 * an untouched plan sits in the same state as a thriving one cannot see the
 * thing it exists to catch, so "active" is a state a commitment leaves on a
 * clock rather than one it can rest in.
 */
export interface CommitmentState {
  name: string;
  meaning: string;
  /** What moves it on, and who does it. */
  leaves: string;
}

export const COMMITMENT_STATES: CommitmentState[] = [
  { name: "drafted", meaning: "Written in class. Nobody else can see it yet.", leaves: "The participant shares it." },
  { name: "shared", meaning: "The manager can see it and has been told.", leaves: "The manager acknowledges, which is one click and is recorded." },
  { name: "active", meaning: "Being worked on, with a check-in due.", leaves: "A check-in lands, or the date passes and it goes overdue." },
  { name: "overdue", meaning: "A check-in was due and did not happen.", leaves: "A check-in lands. Until then it is counted, because silence is the failure mode." },
  { name: "closed: achieved", meaning: "The participant says it happened and the manager agrees.", leaves: "Nothing. It stays readable." },
  { name: "closed: changed", meaning: "The commitment was replaced by a better one. Not a failure and should never be counted as one.", leaves: "Nothing. The replacement links back." },
  { name: "closed: abandoned", meaning: "It did not happen, and why is recorded.", leaves: "Nothing. This is the most useful row in the whole system." },
];

export interface Improvement {
  title: string;
  /** How it works today. */
  now: string;
  /** What replaces it. */
  proposed: string;
  /** The question it makes answerable, or the failure it makes visible. */
  unlocks: string;
}

export const IMPROVEMENTS: Improvement[] = [
  {
    title: "The plan is a record, not a submission",
    now: "One row per submission. An update is a second row that does not know about the first.",
    proposed:
      "One plan per participant per programme, with revisions. Earlier wording stays readable, and who changed what is in the audit chain.",
    unlocks: "Whether a plan was ever revisited, which is the first thing that predicts whether it worked.",
  },
  {
    title: "The manager holds a seat, not a copy",
    now: "The participant sends the plan. Nothing records that it arrived, was read, or was agreed.",
    proposed:
      "The manager is on the record. Acknowledging is one click. Comments attach to a commitment rather than to the plan as a whole.",
    unlocks: "Which plans a manager never saw, in a report nobody has to chase.",
  },
  {
    title: "Check-ins are scheduled by the plan",
    now: "Somebody remembers. Four weeks of silence is how every post-training commitment ends.",
    proposed:
      "Cadence set per programme and counted from the class date. The plan asks the participant, then the manager, then stops asking and marks itself overdue.",
    unlocks: "Overdue as a number rather than an impression, per class and per centre.",
  },
  {
    title: "A commitment carries a before and an after",
    now: "The plan says what someone intends. Nothing records what changed.",
    proposed:
      "Each commitment takes an observation at the start and one at close, in the participant's own terms. Not a KPI, and deliberately not scored.",
    unlocks: "Whether the behaviour moved, from the two people who can actually see it.",
  },
  {
    title: "The plan knows its class, centre and coach",
    now: "Participant, class, centre and coach live in four separate forms with no join.",
    proposed:
      "One reference, already tracked. The plan inherits them rather than asking the participant to retype them.",
    unlocks: "Completion by centre, by class, by instructor. Today this needs a person with a spreadsheet.",
  },
  {
    title: "The cohort is readable without reading anyone's plan",
    now: "The only way to see the cohort is to open the entries list, which means reading individual plans.",
    proposed:
      "Rollups by class and centre are a separate surface from the plans themselves, and the default view for anyone above the manager carries counts and recurring themes, not text.",
    unlocks:
      "Which commitments recur across a cohort, which is a signal about the course and not about the person.",
  },
  {
    title: "Coaching starts from what they wrote",
    now: "The coach opens a spreadsheet, or asks.",
    proposed:
      "The assistant answers what this participant committed to, with the plan cited, inside the coaching window and not outside it.",
    unlocks: "A coaching conversation that opens where the last one ended.",
  },
];

/**
 * A DESIGN CONSTRAINT AND NOT A FEATURE, WHICH IS WHY IT IS SEPARATE.
 *
 * A change management plan is somebody writing down what they are bad at. It
 * is honest only while it is not surveillance, and the fastest way to get 320
 * plans that all say the same safe thing is to let head office read them
 * individually. Every rollup above the manager is counts and themes by
 * default, and reading an individual plan outside the participant, their
 * manager and their coach is a deliberate act that lands in the audit chain.
 */
export const CANDOUR_CONSTRAINT =
  "Above the manager, the cohort is counts and recurring themes. Reading an individual plan " +
  "outside the participant, their manager and their coach is a deliberate act and is recorded.";

export interface ConfigItem {
  setting: string;
  why: string;
}

/**
 * What a programme owner sets up once per programme.
 *
 * BA101 and BA102 are different courses with different cohort sizes, so the
 * cadence and the prompts belong to the programme rather than to the product.
 * Everything here exists because hard-coding it would mean a second form the
 * next time a course changes, which is the failure being replaced.
 */
export const CONFIGURATION: ConfigItem[] = [
  { setting: "Programme and class reference", why: "The plan inherits participant, class, centre and coach instead of asking for them." },
  { setting: "How many commitments a plan holds", why: "Three is a plan, ten is a wish list. The number is a teaching decision, not ours." },
  { setting: "The prompts for each commitment", why: "What will change, why, how you will know, by when. Wording belongs to the course." },
  { setting: "Check-in cadence from the class date", why: "Week two catches a plan that never started. Week twelve catches one that stopped." },
  { setting: "Who reviews, and the coaching window", why: "A coach sees the plans for their classes while coaching is happening, and not afterwards." },
  { setting: "Retention", why: "How long a closed plan stays readable, agreed once rather than per request." },
];

export interface Reuse {
  have: string;
  serves: string;
}

/** Already built and already tested. Nothing here is new work. */
export const REUSED: Reuse[] = [
  { have: "Hash-chained audit log", serves: "A plan's history is provable rather than asserted, including who read one." },
  { have: "Role scoping with per-user overrides", serves: "Participant, manager, coach and programme owner see different things by default." },
  { have: "Documents indexed with citations", serves: "The coach asks what somebody committed to and gets the plan, quoted." },
  { have: "The redaction boundary", serves: "Nothing sensitive in a plan reaches a model. Already proven against a real corpus." },
  { have: "Analytics and the learning loop", serves: "Which prompts get thin answers, which is how the instrument improves." },
];

/**
 * The near-miss worth naming, because somebody will find it and ask.
 *
 * wolfpack-auto has an admin surface called change management. It is a
 * different thing that shares a name: organisational change, with categories
 * of process, pricing, staffing, system and policy, and a
 * proposed-approved-active-rolled-back lifecycle. That is a dealership
 * changing a process. This is one person changing their own behaviour after a
 * course. Forcing one onto the other would give both the wrong shape.
 */
export const SIBLING_MODULE =
  "wolfpack-auto's change management is organisational: a dealership changes a process and measures " +
  "the result. This is personal: one person changes their own behaviour after a course. The lifecycle " +
  "and the before-and-after pair are worth borrowing. The rest is not.";

export interface OpenQuestion {
  question: string;
  /** Why it cannot be answered from here, and what would answer it. */
  why: string;
}

export const OPEN_QUESTIONS: OpenQuestion[] = [
  {
    question: "What does the plan actually ask?",
    why: "The walk could not read the fields: the forms render inputs without form elements. One more walk with the current reader returns the real list, and until then any schema here would be invented.",
  },
  {
    question: "Is PMA the system of record for participants?",
    why: "The Training Guide links from there. A replacement should live where the link already points, or the first thing it does is break a habit that works.",
  },
  {
    question: "Do managers have accounts anywhere today?",
    why: "Sharing with a manager currently means sending them something. That is the part this changes most, and it is the part that needs their answer rather than ours.",
  },
  {
    question: "Who owns the process?",
    why: "The instrument scores well in participant feedback. Whoever chose it should be the one who decides what stays.",
  },
];

/** The thing to say first, before any of the above. */
export const HEADLINE =
  "The exercise is working. Participants rate the plan alongside the SMART goal and the SWOT as time " +
  "well spent, so this is not a redesign of the instrument. It is about the three quarters of the " +
  "process that happen after the form is submitted and currently have nowhere to live.";
