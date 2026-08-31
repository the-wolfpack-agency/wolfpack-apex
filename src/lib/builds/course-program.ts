/**
 * Building a new course for a new client, from a method that already works.
 *
 * WHAT CHANGED FROM THE EARLIER CONCEPT. That one asked how to replace the
 * form the Change Management Plan is captured in. This asks a bigger question:
 * the Brand Ambassador program works, so what part of it is ours to take
 * somewhere else. The answer turns out to be neither the content nor the tool.
 * It is the order the pieces come in.
 *
 * AND IT CORRECTS SOMETHING THE EARLIER PAGE GOT WRONG. It said nobody follows
 * up and four weeks of silence is the failure mode. Reading the corpus rather
 * than the form builder turned up BA101 Mobile Coach Rules: an SMS coach that
 * tells participants "I'll check in weekly this year". Follow-through exists.
 * What it lacks is knowledge of what the person actually committed to, which is
 * a much better problem to have and a much cheaper one to fix.
 *
 * EVERY QUOTE HERE IS FROM THEIR OWN MATERIAL, held as data so a test can pin
 * it. A document arguing that we understand their program had better not
 * paraphrase it.
 */

/** Counted in the indexed corpus on 2026-08-31. */
export const CORPUS = {
  /** Facilitator guides read: BA101 and BA102, days one to four. */
  facilitatorGuides: 8,
  /** Distinct cohort evaluation exports. */
  surveyExports: 10,
  /** Levels the curriculum runs to: 101, 102, 201, 202. */
  levels: 4,
  /** Rows of hand-authored SMS coaching script. */
  mobileCoachRules: 115,
  courseDays: 4,
} as const;

/**
 * THE CONSTRAINT THAT SHAPES EVERY OTHER DECISION HERE.
 *
 * Printed on the foot of every page of both facilitator guides. It is not
 * ambiguous and it is not a formality, and it is the first thing to settle
 * before anybody writes a slide for somebody else.
 */
export const COPYRIGHT_LINE =
  "© 2026 Porsche Cars North America, Inc. All content and imagery contained herein is for " +
  "internal Porsche Center use only and cannot be copied or distributed.";

export const IP_POSITION =
  "The method transfers. The materials do not. Nothing branded, written or photographed for this " +
  "program goes to another client, and the design below assumes a fresh set of materials built for " +
  "whoever the new client is. Who owns the method itself is a question for the engagement contract " +
  "rather than for this page, and it should be answered before the first proposal, not after it.";

export interface Component {
  name: string;
  /** What it does for the participant. */
  purpose: string;
  /**
   * Structure travels. Content belongs to the client it was written for.
   *
   * The distinction is the whole document: an activity where people tell a
   * personal story about the brand is a structure, and "Your Porsche Story" is
   * content.
   */
  transfers: "structure" | "structure and wording" | "not at all";
  /** What it becomes for a different client. */
  becomes: string;
}

/**
 * The week, component by component.
 *
 * Taken from the BA101 and BA102 agendas rather than from memory of them, and
 * ordered the way the guides order it: belonging first, content in the middle,
 * commitment at the end.
 */
export const COMPONENTS: Component[] = [
  {
    name: "Personal story opener",
    purpose:
      "Two rounds of four minutes, in pairs, then introduce your partner. People who have spoken in the first hour speak all week.",
    transfers: "structure",
    becomes: "The same activity about the new client's product, category or craft.",
  },
  {
    name: "Expectations activity",
    purpose:
      "Table groups agree their top three goals for the week and write them on Post-Its. Participants set the bar before anybody teaches them anything.",
    transfers: "structure and wording",
    becomes: "Unchanged. Nothing in it is client-specific.",
  },
  {
    name: "Ground rules and agenda",
    purpose: "The week is visible from the first morning, so nothing lands as a surprise.",
    transfers: "structure and wording",
    becomes: "Unchanged.",
  },
  {
    name: "Content modules",
    purpose:
      "Hiring, interviewing, coaching, crafting the client experience, center vision, luxury retail field study, time management, resilience.",
    transfers: "not at all",
    becomes:
      "Written from scratch for the new client's role and category. This is the bulk of the build and the bulk of the cost.",
  },
  {
    name: "WOW / What's Next worksheets",
    purpose:
      "A running capture carried through every day. The facilitator guide is explicit about tying it forward: it feeds the plan and the capstone.",
    transfers: "structure and wording",
    becomes: "Unchanged, and the piece most often left out of courses that copy this shape.",
  },
  {
    name: "SWOT",
    purpose: "Honest self-assessment immediately before commitment, so the commitment is grounded.",
    transfers: "structure and wording",
    becomes: "Unchanged.",
  },
  {
    name: "SMART goals",
    purpose: "Turns a vague intention into something a manager and a participant can both check.",
    transfers: "structure and wording",
    becomes: "Unchanged.",
  },
  {
    name: "Change Management Plan",
    purpose:
      "The commitment, written from three days of accumulated notes rather than invented on the spot. Shared with a manager, updated over time, discussed in coaching.",
    transfers: "structure",
    becomes:
      "The same instrument with prompts written for the new role. This is the centerpiece and the thing worth building properly.",
  },
  {
    name: "Capstone presentation",
    purpose:
      "Said out loud, to peers, on the last day. A commitment made in a room is a different commitment from one typed into a form.",
    transfers: "structure",
    becomes: "Unchanged in shape; the brief is client-specific.",
  },
  {
    name: "Knowledge test and commencement",
    purpose: "A bar to clear and a moment that marks clearing it.",
    transfers: "structure",
    becomes: "New question bank. The ceremony is the point and costs nothing.",
  },
  {
    name: "Mobile coach",
    purpose:
      "Weekly SMS for a year after class. Opens with a scripted introduction and keeps checking in.",
    transfers: "structure",
    becomes:
      "The same channel, driven by the participant's own plan rather than by a fixed script. See the improvements below.",
  },
  {
    name: "Program evaluation",
    purpose: "Post-course survey on facilitators and perceived value.",
    transfers: "structure",
    becomes: "Kept, and joined by a measure of whether anything changed.",
  },
];

/**
 * THE PART WORTH TAKING, AND THE EASIEST PART TO LOSE.
 *
 * Every artifact feeds the next one. The notes become the SWOT, the SWOT
 * grounds the SMART goal, the goal becomes the plan, the plan is presented out
 * loud, and the coach keeps asking about it afterwards. A course that ships
 * these as five separate worksheets has copied the components and missed the
 * design.
 */
export const COMMITMENT_LADDER: string[] = [
  "Notes captured all week on the WOW / What's Next worksheet",
  "SWOT, which forces an honest read before committing to anything",
  "SMART goals, which make the intention checkable",
  "The Change Management Plan, written from the notes rather than from nothing",
  "The capstone, said out loud to peers",
  "Weekly coaching for a year afterwards",
];

export interface Improvement {
  title: string;
  /** Measured or quoted from their material. */
  today: string;
  proposed: string;
  why: string;
}

/**
 * Where the program is weakest, which is the same place our product is
 * strongest. Each of these is a measurement failure rather than a design one.
 */
export const IMPROVEMENTS: Improvement[] = [
  {
    title: "The coach does not know what the person committed to",
    today:
      "The mobile coach runs on hand-authored rules matching typed replies with regular expressions, and opens by asking how valuable the program was on a scale of one to five.",
    proposed:
      "The coach asks about the participant's own commitment, in their own words, on the cadence their plan set. Same channel, same weekly rhythm, different question.",
    why: "\"How valuable was the program\" is answerable on the last day. \"You said you would change how you open a service conversation, how did that go\" is only answerable if somebody kept the plan.",
  },
  {
    title: "Evaluation measures the week, not the year",
    today:
      "The survey asks how the facilitators contributed and how well they guided activities. Useful, and it is a satisfaction instrument.",
    proposed:
      "Keep it, and add a second measure that arrives later: how many commitments were still live at week six, which ones closed, and what changed.",
    why: "A course can be rated excellent by everyone who attended and change nothing. Only one of those two facts is currently visible.",
  },
  {
    title: "The plan cannot be connected to an outcome",
    today:
      "Plans, class reports and survey responses sit in separate form silos with no join.",
    proposed:
      "One record per participant carrying the class, the manager, the coach and the commitments, so the cohort question can be asked at all.",
    why: "Whether the people who wrote a plan behaved differently afterwards is the only question the exercise exists to answer.",
  },
  {
    title: "A submission is not a living record",
    today:
      "The plan is captured once. Sharing, updating and discussing all happen afterwards, and a new submission does not know about the first.",
    proposed:
      "Revisions, a manager who acknowledges rather than receives, and coaching notes that attach to a commitment instead of to an inbox.",
    why: "Three of the four things their own material says a plan is for happen after it is submitted.",
  },
  {
    title: "Nothing tells a facilitator which commitments recur",
    today:
      "Reading the cohort means opening the entries list, which means reading individual plans.",
    proposed:
      "Recurring themes by cohort and by location, as counts, without anybody reading a plan.",
    why: "If sixty per cent of a cohort commits to the same thing, that is a signal about the course rather than about the people.",
  },
];

/**
 * A CONSTRAINT, NOT A FEATURE.
 *
 * A change management plan is somebody writing down what they are bad at. It
 * stays honest only while it is not surveillance, and 320 identical safe
 * answers is what a program gets when head office can read them individually.
 */
export const CANDOR_CONSTRAINT =
  "Above the manager, a cohort is counts and recurring themes. Reading an individual plan outside the " +
  "participant, their manager and their coach is a deliberate act and is recorded.";

export interface BuildItem {
  what: string;
  detail: string;
}

/** What Wolfpack delivers, separated so a client can buy part of it. */
export const DELIVERABLES: BuildItem[] = [
  { what: "Curriculum design", detail: "The week, built on the ladder above, with modules written for the client's roles." },
  { what: "Facilitator guides", detail: "Timed, scripted, in the shape the BA guides use, because that shape demonstrably runs." },
  { what: "Participant materials", detail: "Journal, worksheets, plan and capstone brief." },
  { what: "The platform", detail: "Plans as living records, manager and coach seats, cadence, cohort rollups, audit." },
  { what: "The coach", detail: "Weekly follow-up driven by each participant's own commitments." },
  { what: "Measurement", detail: "Satisfaction at the end of the week, and follow-through at six and twelve weeks." },
  { what: "Facilitator enablement", detail: "Train the trainer, so the client can run cohorts without us in the room." },
];

export interface ConfigItem {
  setting: string;
  why: string;
}

/** Set once per program, because the next client will differ on every line. */
export const CONFIGURATION: ConfigItem[] = [
  { setting: "Program, level and cohort size", why: "BA runs four levels and roughly 32 to a class. The next client will not match, and nothing should assume it does." },
  { setting: "Commitments per plan", why: "Three is a plan and ten is a wish list. A teaching decision, not a product one." },
  { setting: "Commitment prompts", why: "What will change, why, how you will know, by when. The wording belongs to the course." },
  { setting: "Check-in cadence from the class date", why: "Week two catches a plan that never started. Week twelve catches one that stopped." },
  { setting: "Coaching window and who reviews", why: "A coach sees their own classes while coaching is happening, and not afterwards." },
  { setting: "Channel", why: "SMS worked for a dealership floor. A different workforce may need email or Teams." },
  { setting: "Retention", why: "How long a closed plan stays readable, agreed once rather than per request." },
];

export interface Reuse {
  have: string;
  serves: string;
}

/** Already built and tested. None of it is new work. */
export const REUSED: Reuse[] = [
  { have: "Documents indexed and answerable with citations", serves: "A coach asks what somebody committed to and gets the plan, quoted." },
  { have: "Hash-chained audit log", serves: "A plan's history is provable, including who read one." },
  { have: "Role scoping with per-user overrides", serves: "Participant, manager, coach and program owner see different things by default." },
  { have: "The redaction boundary", serves: "Nothing sensitive in a plan reaches a model. Proven against a real corpus." },
  { have: "Analytics and the learning loop", serves: "Which prompts get thin answers, which is how the instrument improves between cohorts." },
];

export interface OpenQuestion {
  question: string;
  why: string;
}

export const OPEN_QUESTIONS: OpenQuestion[] = [
  {
    question: "Who is the client, and what is the role being trained?",
    why: "Every content module is written for a specific job. Until that is known the estimate is a shape rather than a number, and the ladder is the only part that can be designed in advance.",
  },
  {
    question: "Does the engagement contract leave us free to reuse the method?",
    why: "The materials are plainly not ours. The instructional design is a separate question and the answer lives in the contract. It should be settled before a proposal goes out, not after one is accepted.",
  },
  {
    question: "How many cohorts a year, and who facilitates?",
    why: "The difference between us running the room and enabling their trainers changes the deliverable, the price and the timeline more than any feature here.",
  },
  {
    question: "What does the client already use for training records?",
    why: "BA hangs off a mobile academy the participants already log into. A course that asks people to learn a second system loses the follow-through it is being bought for.",
  },
  {
    question: "What does the client want to be able to prove?",
    why: "Completion, behavior change and business outcome need different instruments, and only the first is cheap. Agreeing this early prevents building the wrong measure well.",
  },
];

export const HEADLINE =
  "The Brand Ambassador program works, and what makes it work is not the slides. It is that every " +
  "artifact feeds the next one: notes become a SWOT, the SWOT grounds a goal, the goal becomes a " +
  "plan, the plan is presented out loud, and a coach keeps asking about it for a year. That ladder " +
  "is what transfers to a new client. The materials do not, and should not.";
