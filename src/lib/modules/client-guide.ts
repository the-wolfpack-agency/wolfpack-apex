/**
 * The client's instructions, generated from what the product actually does.
 *
 * WHY THIS IS GENERATED AND NOT WRITTEN
 *
 * A hand-written guide is accurate on the day it is written. This one is built
 * from MODULE_CAPABILITIES, the same declaration that decides which prompts the
 * interface offers and which actions the deployment journey verifies, so the
 * three cannot disagree. When an action is fixed and promoted to `supported`,
 * it appears here in the same change; when one is found to route elsewhere, it
 * stops being taught in the same change.
 *
 * That matters more here than anywhere else in the product. A guide that
 * promises something the engine does not do is worse than no guide: somebody
 * follows it, gets a list where they expected an answer, and concludes the tool
 * is broken rather than that the sentence was wrong.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not teach workarounds. If an action does not work, the honest
 * response is to fix it or to leave it out, not to coach somebody around it.
 * `routes_elsewhere` actions appear in the OPERATOR view, which is for us, and
 * never in the client view.
 *
 * It also carries no example that only our corpus can answer, because these
 * words end up in front of somebody whose documents are their own.
 */
import {
  MODULE_CAPABILITIES,
  type ModuleAction,
  type ModuleCapability,
} from "./capabilities";

export interface GuideEntry {
  /** What the reader wants to do, in their words. */
  goal: string;
  /** Type this. Measured to produce the stated result. */
  say: string;
  /** What comes back, described plainly rather than by internal shape name. */
  get: string;
}

export interface GuideSection {
  module: string;
  entries: GuideEntry[];
}

/** What each answer shape looks like to somebody reading it. */
const SHAPE_IN_PLAIN_WORDS: Record<ModuleAction["returns"], string> = {
  synthesised: "A written answer, with the document it came from.",
  list: "A list of matching documents you can open.",
  record: "A single record, laid out.",
  action: "It performs the change and confirms what it did.",
};

function entryFor(a: ModuleAction): GuideEntry {
  return {
    goal: a.because,
    say: a.example,
    get: SHAPE_IN_PLAIN_WORDS[a.returns],
  };
}

/**
 * The client-facing guide: only what is verified to work.
 *
 * Filtered on `supported`, which by the contract's own rule means measured
 * against a real deployment rather than passing a test suite.
 */
export function clientGuide(
  modules: ModuleCapability[] = MODULE_CAPABILITIES,
): GuideSection[] {
  return modules
    .map((m) => ({
      module: m.label,
      entries: m.actions.filter((a) => a.status === "supported").map(entryFor),
    }))
    .filter((s) => s.entries.length > 0);
}

export interface OperatorNote {
  module: string;
  /** The phrasing somebody will try. */
  say: string;
  /** What actually happens, so support can answer it in one line. */
  actually: string;
}

/**
 * What we know and the client is not told.
 *
 * A support person needs this on day one: somebody WILL type "summarize this"
 * and needs an answer better than "that's odd". Kept separate from the client
 * guide because teaching a workaround is not the same as documenting a gap.
 */
export function operatorNotes(
  modules: ModuleCapability[] = MODULE_CAPABILITIES,
): OperatorNote[] {
  return modules.flatMap((m) =>
    m.actions
      .filter((a) => a.status === "routes_elsewhere")
      .map((a) => ({
        module: m.label,
        say: a.example,
        actually: `Behaves like "${a.behavesLike ?? "another action"}": ${
          SHAPE_IN_PLAIN_WORDS[a.returns]
        }`,
      })),
  );
}

/**
 * Render the client guide as markdown, for the handoff pack.
 *
 * Plain sentences and no product vocabulary: "a written answer" rather than
 * "synthesised", because the reader has never seen our types and should not
 * have to.
 */
export function clientGuideMarkdown(sections: GuideSection[] = clientGuide()): string {
  if (sections.length === 0) {
    /* An empty guide is a real state and must read as one. A deployment with
       nothing verified should say so rather than print an empty heading. */
    return "No capabilities have been verified on this deployment yet.";
  }
  const out: string[] = ["# What you can ask", ""];
  for (const s of sections) {
    out.push(`## ${s.module}`, "");
    for (const e of s.entries) {
      out.push(`**${e.goal}**`, "", `Type: \`${e.say}\``, "", e.get, "");
    }
  }
  return out.join("\n").trimEnd();
}
