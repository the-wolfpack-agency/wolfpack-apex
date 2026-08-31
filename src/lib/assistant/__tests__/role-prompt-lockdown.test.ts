/**
 * Every prompt we put in front of a role must work FOR THAT ROLE.
 *
 * WHY THIS EXISTS, GIVEN IT PASSES TODAY. Measured before writing it: 54 role
 * chips and 58 guide phrasings, and all of them already reach a tool their role
 * can invoke. The property is true. Nothing was holding it true.
 *
 * That is the same argument the SQL ratchet makes and it is worth repeating,
 * because this repo has now been bitten twice by a habit mistaken for a
 * control. The assistant's own system prompt named the wrong product for four
 * months. Seven of eight task phrasings missed until somebody swept them by
 * hand. Both were correct once and drifted, and in both cases the suite stayed
 * green throughout.
 *
 * TWO FAILURES, AND THE SECOND IS THE EXPENSIVE ONE.
 *
 * A chip that reaches no tool falls through to a model, which answers from
 * whatever it had nearest. That is how "who runs engineering" was answered from
 * brand-ambassador training slides.
 *
 * A chip that reaches a tool the role may not invoke is worse. It is offered,
 * clicked, and refused, so a new user's first action ends in a permission
 * error on something we suggested. A control shown to somebody who cannot use
 * it is a defect, not an access-control success, and this is the cheapest place
 * to catch one.
 *
 * SCOPED TO WHAT WE PUT IN FRONT OF PEOPLE. This does not claim the assistant
 * only answers these phrasings; it answers plenty that are not written down.
 * It claims that everything we SUGGEST resolves, which is a promise we make and
 * can therefore be held to.
 */
import "@/lib/assistant/tools/index";
import { getTools } from "@/lib/assistant/tools/registry";
import { canInvokeTool, TOOL_ROLE_LEVEL } from "@/lib/assistant/tools/gate";
import { welcomePromptsForRole } from "@/lib/assistant/welcome-prompts";
import { PROMPT_GUIDE } from "@/lib/assistant/prompt-corpus";
import { isQuestionShaped } from "@/lib/brain/question-terms";

interface Claimant {
  name: string;
  capability: string;
  matchIntent?: (m: string) => unknown;
}

const TOOLS = getTools() as unknown as Claimant[];

/** Every tool that says this message is for it. */
function claimants(message: string): Claimant[] {
  const out: Claimant[] = [];
  for (const t of TOOLS) {
    try {
      if (t.matchIntent && t.matchIntent(message)) out.push(t);
    } catch {
      /* A matcher that throws is its own bug and has its own test. */
    }
  }
  return out;
}

/** The canonical roles, read from the gate rather than listed here. */
const ROLES = Object.keys(TOOL_ROLE_LEVEL);

describe("every role's starter prompts resolve for that role", () => {
  /* Read from the gate, so a role added there is covered here without anybody
     remembering to add it. A new role with no kit falls back to the generic
     one, and the assertions below still have to hold for it. */
  it.each(ROLES)("%s is offered something", (role) => {
    expect(welcomePromptsForRole(role).length).toBeGreaterThan(0);
  });

  /* RETRIEVAL IS A DESTINATION, NOT A DEAD END.
   *
   * The risk this guards is a chip falling through to a model that answers
   * from whatever it had nearest, which is how "who runs engineering" was once
   * answered from brand-ambassador training slides. A content question does
   * not do that. It reaches the Brain, which answers from the document and
   * cites it, and it reaches no tool ON PURPOSE: the tool that used to claim
   * "what does our policy say about time off?" was universal search, and it
   * replied with a list of filenames.
   *
   * So the exemption is narrow and specific. It covers only sentences the
   * question-frame parser recognizes, which is the same parser retrieval uses
   * to build its search terms. If that parser stops recognizing a chip, the
   * chip stops being exempt here and this test fails, which is the behavior
   * worth having. */
  it.each(ROLES)("every prompt offered to %s reaches a tool", (role) => {
    const dead = welcomePromptsForRole(role)
      .filter((p) => claimants(p.text).length === 0 && !isQuestionShaped(p.text))
      .map((p) => `${role}: ${JSON.stringify(p.text)} reaches no tool and will be answered by a model`);
    expect(dead).toEqual([]);
  });

  /* And the exemption must never become a blanket. A chip that is neither
     claimed nor question-shaped is still a failure above; this asserts the
     escape hatch is actually narrow. */
  it("the retrieval exemption covers content questions and not much else", () => {
    const exempt = ROLES.flatMap((role) =>
      welcomePromptsForRole(role)
        .filter((p) => claimants(p.text).length === 0 && isQuestionShaped(p.text))
        .map((p) => p.text),
    );
    expect(new Set(exempt).size).toBeLessThanOrEqual(4);
  });

  /* THE ONE THAT ENDS IN A PERMISSION ERROR. Offered, clicked, refused. */
  it.each(ROLES)("every prompt offered to %s reaches a tool %s may invoke", (role) => {
    const forbidden = welcomePromptsForRole(role)
      .filter((p) => {
        const c = claimants(p.text);
        return c.length > 0 && !c.some((t) => canInvokeTool(role, t.capability));
      })
      .map((p) => {
        const c = claimants(p.text).map((t) => `${t.name} needs ${t.capability}`);
        return `${role}: ${JSON.stringify(p.text)} is suggested but only ${c.join(", ")} claim it`;
      });
    expect(forbidden).toEqual([]);
  });
});

describe("the written guide matches what the product does", () => {
  /* PROMPT_GUIDE is shown to users by what_can_you_do, so a phrasing here that
     no longer routes is a documented capability the product has stopped
     having. */
  it("every documented phrasing reaches a tool", () => {
    const dead: string[] = [];
    for (const g of PROMPT_GUIDE) {
      for (const say of g.say) {
        if (claimants(say).length === 0 && !isQuestionShaped(say)) {
          dead.push(`${JSON.stringify(say)} is documented as reaching ${g.tool} and reaches nothing`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it("every documented phrasing reaches the tool it names", () => {
    const wrong: string[] = [];
    for (const g of PROMPT_GUIDE) {
      for (const say of g.say) {
        const c = claimants(say);
        if (c.length > 0 && !c.some((t) => t.name === g.tool)) {
          wrong.push(
            `${JSON.stringify(say)} is documented as ${g.tool} but is claimed by ${c.map((t) => t.name).join(", ")}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  /* A guide entry naming a tool that no longer exists would pass both checks
     above by never being compared to anything. */
  it("names only tools that exist", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const missing = PROMPT_GUIDE.filter((g) => !names.has(g.tool)).map(
      (g) => `${g.goal} names ${g.tool}, which is not registered`,
    );
    expect(missing).toEqual([]);
  });
});

describe("how much of the role surface is bespoke", () => {
  /* A number rather than a pass/fail, in the shape of the inline-prompt
     ratchet. Eight of the fourteen roles have their own kit and six fall back
     to the generic one, which is legitimate and is also the honest measure of
     how role-aware this actually is. Update it deliberately when a kit is
     added; the direction is the point.

     The six on the generic kit are evp, cco, lead, manager, viewer and member.
     Worth noting rather than fixing here: lead and manager are ordinary
     client-side roles, so they are the two most worth writing a kit for.

     Not asserted as a minimum, because a generic kit that resolves is better
     than a bespoke one written to satisfy a counter. */
  it("records how many roles have their own kit", () => {
    const generic = welcomePromptsForRole("definitely-not-a-real-role").map((p) => p.text).join("|");
    const bespoke = ROLES.filter(
      (r) => welcomePromptsForRole(r).map((p) => p.text).join("|") !== generic,
    );
    expect(bespoke.sort()).toEqual([
      "ceo", "cto", "designer", "dev", "hr", "ops", "sales", "vp",
    ]);
  });
});
