/**
 * Guided intake - the product thesis made concrete: LEAD the user to a good
 * outcome instead of handing them a blank prompt box. A non-expert cares about
 * OUTPUT and does not know how to phrase the ideal request or which SDLC steps
 * matter. So we offer a CONSTRAINED set of goals, walk them through only the
 * decisions that change the result (tests, data, auth...), and ASSEMBLE a
 * well-formed request from their answers. Pure + declarative - this file IS the
 * codified expertise; the component just renders it.
 */
import type { ChipTaskType } from "./chips";

export interface IntakeOption {
  value: string;
  label: string;
  /** Plain-language consequence of this choice (our expertise, shown inline). */
  hint?: string;
}
export interface IntakeStep {
  id: string;
  question: string;
  /** Why this matters - fills the gap a non-expert has. */
  help?: string;
  kind: "choice" | "text";
  options?: IntakeOption[];
  placeholder?: string;
  required?: boolean;
  defaultValue?: string;
}
export interface IntakeGoal {
  id: string;
  label: string;
  /** One line a non-expert recognizes. */
  blurb: string;
  taskType: ChipTaskType;
  steps: IntakeStep[];
}

const YES_NO = (yesHint: string, noHint = ""): IntakeOption[] => [
  { value: "yes", label: "Yes", hint: yesHint },
  { value: "no", label: "No", hint: noHint },
];

export const INTAKE_GOALS: readonly IntakeGoal[] = [
  {
    id: "feature",
    label: "Add something new",
    blurb: "A new feature, page, or capability.",
    taskType: "ui",
    steps: [
      { id: "what", kind: "text", required: true, question: "What should it do?", placeholder: "e.g. a page that lists a customer's invoices", help: "Describe the outcome you want, not how to build it." },
      { id: "where", kind: "text", question: "Where should it live? (optional)", placeholder: "e.g. the billing section, or a file path", help: "If you know the area or file, it helps us put it in the right place." },
      { id: "data", kind: "choice", question: "Does it need to save or read data?", options: YES_NO("We'll wire up storage and persistence.", "Keep it stateless."), defaultValue: "no", help: "Anything that remembers information between visits needs data." },
      { id: "auth", kind: "choice", question: "Should it be behind a login?", options: YES_NO("We'll require sign-in and the right permissions.", "It can be public."), defaultValue: "yes", help: "Most internal tools should require a login. We default to safe." },
      { id: "tests", kind: "choice", question: "Include tests so it doesn't break later?", options: YES_NO("Recommended - we add tests that prove it works.", "Skip tests (not recommended)."), defaultValue: "yes", help: "Tests are what keep it working as the system grows. We recommend yes." },
    ],
  },
  {
    id: "fix",
    label: "Fix something broken",
    blurb: "Something isn't working the way it should.",
    taskType: "ci-fix",
    steps: [
      { id: "symptom", kind: "text", required: true, question: "What's going wrong?", placeholder: "e.g. the save button does nothing on the orders page", help: "Describe what you see - the symptom, not the cause." },
      { id: "where", kind: "text", question: "Where does it happen? (optional)", placeholder: "e.g. the orders page, or a file" },
      { id: "error", kind: "text", question: "Any error message you saw? (optional)", placeholder: "paste it if you have one", help: "An exact error message helps us find it fast." },
      { id: "tests", kind: "choice", question: "Add a test so it can't come back?", options: YES_NO("Recommended - a test that fails on the bug, passes on the fix.", "Just fix it."), defaultValue: "yes", help: "A regression test stops the same bug returning later." },
    ],
  },
  {
    id: "improve",
    label: "Improve existing code",
    blurb: "Clean up, speed up, or simplify something that already works.",
    taskType: "refactor",
    steps: [
      { id: "what", kind: "text", required: true, question: "What should be improved?", placeholder: "e.g. the checkout code is hard to follow and slow", help: "Name the area and what bothers you about it." },
      { id: "behavior", kind: "choice", question: "Keep the behavior exactly the same?", options: YES_NO("Yes - a safe refactor, no visible change.", "No - behavior can change too."), defaultValue: "yes", help: "A pure cleanup shouldn't change what the user sees. We default to safe." },
    ],
  },
  {
    id: "tests",
    label: "Add tests",
    blurb: "Prove an existing feature works and keep it that way.",
    taskType: "test",
    steps: [
      { id: "what", kind: "text", required: true, question: "What should the tests cover?", placeholder: "e.g. the login flow and its error cases", help: "Name the feature or flow you want protected." },
      { id: "layer", kind: "choice", question: "What kind of testing?", options: [
        { value: "all", label: "All the right layers", hint: "We pick the layers that matter (recommended)." },
        { value: "unit", label: "Unit only", hint: "Fast, logic-level checks." },
        { value: "e2e", label: "End-to-end", hint: "Drives the real UI." },
      ], defaultValue: "all", help: "If unsure, let us choose the right mix." },
    ],
  },
  {
    id: "docs",
    label: "Write or update docs",
    blurb: "Explain how something works. No behavior change.",
    taskType: "docs",
    steps: [
      { id: "what", kind: "text", required: true, question: "What should be documented?", placeholder: "e.g. how the invoice export works", help: "Name what you want explained." },
    ],
  },
];

export function goalById(id: string): IntakeGoal | undefined {
  return INTAKE_GOALS.find((g) => g.id === id);
}

/** True when every required step has a non-empty answer. */
export function isComplete(goal: IntakeGoal, answers: Record<string, string>): boolean {
  return goal.steps.every((s) => !s.required || (answers[s.id] ?? "").trim().length > 0);
}

/**
 * Assemble a well-formed request from the guided answers. Pure. This is where the
 * user's plain answers become the precise instruction the factory executes well -
 * including the SDLC defaults (tests, auth, behavior-preservation) they chose.
 */
export function composeRequest(goal: IntakeGoal, answers: Record<string, string>): string {
  const a = (id: string) => (answers[id] ?? "").trim();
  const parts: string[] = [];

  if (goal.id === "feature") {
    parts.push(`Add a new feature: ${a("what")}.`);
    if (a("where")) parts.push(`Place it in: ${a("where")}.`);
    if (a("data") === "yes") parts.push("It needs to persist and read data - wire up storage.");
    parts.push(a("auth") === "no" ? "It can be public (no login required)." : "Require authentication and the appropriate authorization.");
    parts.push(a("tests") === "no" ? "Tests are optional for this change." : "Include tests that prove it works.");
  } else if (goal.id === "fix") {
    parts.push(`Investigate and fix a bug: ${a("symptom")}.`);
    if (a("where")) parts.push(`It happens in: ${a("where")}.`);
    if (a("error")) parts.push(`Observed error: ${a("error")}.`);
    parts.push(a("tests") === "no" ? "A regression test is optional." : "Add a regression test that fails on the bug and passes on the fix.");
  } else if (goal.id === "improve") {
    parts.push(`Improve existing code: ${a("what")}.`);
    parts.push(a("behavior") === "no" ? "Behavior may change as part of this." : "Preserve the existing behavior exactly - this is a safe refactor.");
    parts.push("Do not duplicate existing code; reuse or extract shared helpers.");
  } else if (goal.id === "tests") {
    parts.push(`Add tests that cover: ${a("what")}.`);
    parts.push(a("layer") === "all" ? "Use the appropriate layers (unit / contract / DB / e2e as relevant)." : `Focus on ${a("layer")} tests.`);
  } else if (goal.id === "docs") {
    parts.push(`Write or update documentation: ${a("what")}. Documentation only - no behavior change.`);
  }

  return parts.filter(Boolean).join(" ");
}
