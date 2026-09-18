/**
 * /builds/governance-posture content - the client-presentable "how governed is
 * your AI" surface. The control list is DERIVED live from the control-ladder
 * registry (the same one CI ratchets), not restated here, so this page can never
 * overclaim: if a control is not enforced in the registry, it does not show as
 * enforced here. The prose (intro + proofs) is held as data and test-pinned; the
 * numbers-in-the-wild live on the Effectiveness view, linked from the page.
 */
import { CONTROL_LADDER, isEnforcing, type ControlEntry } from "@/lib/governance/control-ladder";

export const POSTURE_HEADLINE =
  "How governed is your AI? Here is the exact answer, read from the platform's own controls. This is not marketing copy: the list below is derived from the same registry our build checks, so it cannot claim more than is actually enforced.";

export const POSTURE_INTRO =
  "OGIAM puts your AI on the untrusted side of every door and enforces the rules in the walls, not in the AI's good intentions. Most 'AI safety' is a paragraph asking the AI to behave; that stops working the moment the AI, being a guessing machine, does not. Here every action passes through the same doors, and a fixed rule at each door decides yes or no.";

export interface PostureProof {
  title: string;
  body: string;
}
export const POSTURE_PROOFS: PostureProof[] = [
  {
    title: "Any model, same governance",
    body: "The governance decision comes out identically whether the AI is Claude, GPT, Meta's Llama, or DeepSeek. It is proven, not asserted: the same set of good and bad actions is run through every model and the outcome is the same, because the rules live in the platform, not the model.",
  },
  {
    title: "What is enforced is a number, not a claim",
    body: "Every control is tagged as automatically enforced, held for a person, or human-reviewed, and that tally is checked by our own build. It can only improve: a control cannot quietly slip from enforced back to a suggestion without the build catching it.",
  },
  {
    title: "Every action is on the record",
    body: "Each decision is written to a tamper-evident log nobody can alter. 'Here is how your AI behaved' is evidence you can hand an auditor, not a promise.",
  },
];

export const POSTURE_CLOSER =
  "One honest line: truthfulness (not fabricating, not overclaiming) cannot be checked before an action runs, because it is a property of an answer, not of an action. So it is human-reviewed against the record rather than pretended to be a gate. Being clear about that line is the point.";

export interface PostureControl {
  label: string;
}
export interface PostureGroups {
  /** Structural / deterministic / containment controls, wired at a live seam. */
  autoEnforced: PostureControl[];
  /** Wired controls that hold an action for a person to approve. */
  humanApproval: PostureControl[];
  /** Inherently non-deterministic conduct, reviewed after the fact, never faked as a gate. */
  humanReviewed: PostureControl[];
  /** Deterministic controls still being wired inline (transparency, not hidden). */
  hardening: PostureControl[];
  enforcedCount: number;
  totalCount: number;
}

/** Group the live control registry into a client-friendly posture view. */
export function postureControls(): PostureGroups {
  const map = (e: ControlEntry): PostureControl => ({ label: e.capability });
  const autoEnforced = CONTROL_LADDER.filter((e) => isEnforcing(e) && e.rung !== "human-in-loop");
  const humanApproval = CONTROL_LADDER.filter((e) => isEnforcing(e) && e.rung === "human-in-loop");
  const humanReviewed = CONTROL_LADDER.filter((e) => e.rung === "advisory");
  const hardening = CONTROL_LADDER.filter((e) => !isEnforcing(e) && e.rung !== "advisory");
  return {
    autoEnforced: autoEnforced.map(map),
    humanApproval: humanApproval.map(map),
    humanReviewed: humanReviewed.map(map),
    hardening: hardening.map(map),
    enforcedCount: autoEnforced.length + humanApproval.length,
    totalCount: CONTROL_LADDER.length,
  };
}
