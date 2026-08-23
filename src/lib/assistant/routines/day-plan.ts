/**
 * Turning "here is what I do on a Monday" into a play by play.
 *
 * THE ENTRY POINT TO EVERYTHING ELSE
 *
 * Routines exist, tools exist, and the person who would benefit most has no
 * idea either is there. Asking them to browse a tool list is asking them to
 * translate their own job into our vocabulary, which is the work we are
 * supposed to be doing for them.
 *
 * So they describe their day in their own words, and this says back: here is
 * what happens, here is the part software can already do, here is the part only
 * you can do, and here is where there is nothing yet. Then it offers to chain
 * the whole thing into one command.
 *
 * THE MODEL PROPOSES, THE REGISTRY DECIDES
 *
 * The one thing rules cannot do is turn prose into a list of discrete steps, so
 * a model does that and nothing else. Every step it produces is then checked
 * against the LIVE tool registry, and a tool name that does not exist becomes a
 * GAP rather than a step.
 *
 * That boundary is the whole design. A model naming a plausible tool would
 * produce a routine that fails at step three in front of the person who just
 * told us about their job, and they would not come back. It is cheaper to say
 * "there is nothing for that yet" than to be caught inventing.
 *
 * A step is also dropped to a gap when the person's ROLE cannot invoke the tool
 * it matched. Proposing a chain somebody is not allowed to run is a worse
 * outcome than proposing a shorter one.
 */
import type { ToolDef } from "@/lib/assistant/tools/types";
import { canInvokeTool } from "@/lib/assistant/tools/gate";
import type { Routine, RoutineStep } from "./types";

/** One thing the person said they do, before we know what it maps to. */
export interface DescribedStep {
  /** Their words, kept, because the play by play reads back to them. */
  text: string;
  /** The model's guess at a registered tool, or null for "a person does this". */
  tool: string | null;
  /** True when the model judged this to need no software at all. */
  humanOnly: boolean;
}

export type MappedStep =
  | { kind: "tool"; text: string; tool: string; description: string }
  /** Work only a person can do. Not a gap: nothing is missing. */
  | { kind: "human"; text: string }
  /** Software could help and we do not have it. Named honestly. */
  | { kind: "gap"; text: string; reason: "no_tool" | "not_permitted" | "needs_detail" };

export interface DayPlan {
  steps: MappedStep[];
  /** How much of the described day we can already carry. */
  covered: number;
  humanOnly: number;
  gaps: number;
}

/**
 * Check every described step against what actually exists.
 *
 * Pure, and the guard the whole feature rests on: a tool name reaches the
 * output only if the registry has it AND this role may invoke it.
 */
export function mapDay(
  described: DescribedStep[],
  tools: ReadonlyArray<ToolDef<unknown, unknown>>,
  role: string,
): DayPlan {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const steps: MappedStep[] = [];

  for (const step of described) {
    const text = step.text.trim();
    if (!text) continue;

    if (step.humanOnly || !step.tool) {
      steps.push({ kind: "human", text });
      continue;
    }

    const tool = byName.get(step.tool);
    if (!tool) {
      /* The model named something that does not exist. This is the case that
         would otherwise become a routine failing in front of them. */
      steps.push({ kind: "gap", text, reason: "no_tool" });
      continue;
    }
    if (!canInvokeTool(role, tool.capability)) {
      steps.push({ kind: "gap", text, reason: "not_permitted" });
      continue;
    }

    /* CAN THIS TOOL ACTUALLY RUN WITH NOTHING?
     *
     * A drafted step carries no parameters, deliberately: a model's guess at
     * what somebody meant is a wrong action taken confidently. But some tools
     * require a detail before they can do anything at all. Searching mail needs
     * to know whose mail, or about what; there is no sensible default and
     * inventing one would be the guess this avoids.
     *
     * Found in production: a saved chain contained "read the overnight email"
     * as a search_mail step with no parameters, and failed at step one with a
     * validation message about the tool rather than about the chain. The
     * template library checked for exactly this before offering anything and
     * this path did not, so the check moved here where both use it.
     *
     * It becomes a GAP rather than a step, because a chain that stops at step
     * one is worse than a chain that never included the step and said why. */
    const runsWithNothing = tool.paramSchema.safeParse({});
    if (!runsWithNothing.success) {
      steps.push({ kind: "gap", text, reason: "needs_detail" });
      continue;
    }

    steps.push({
      kind: "tool",
      text,
      tool: tool.name,
      description: tool.description.split(/(?<=\.)\s/)[0].replace(/\.$/, ""),
    });
  }

  return {
    steps,
    covered: steps.filter((s) => s.kind === "tool").length,
    humanOnly: steps.filter((s) => s.kind === "human").length,
    gaps: steps.filter((s) => s.kind === "gap").length,
  };
}

/**
 * The chain we could build from what we can actually do.
 *
 * Only tool steps and human steps go in. A gap cannot be a step: a routine with
 * a hole in it is one that stops halfway, and the person is left worse off than
 * before they described their day.
 *
 * Every human step is marked "do", not "review". These come from somebody
 * describing their own work, so they are things the person does, not
 * checkpoints on ours. Getting that wrong would count their real work as a
 * pause worth deleting.
 */
export function draftRoutine(plan: DayPlan, id: string, command: string): Routine | null {
  const steps: RoutineStep[] = [];
  /* Slots for what each tool step returns, so the thinking step below can read
     them. Named from the person's own words rather than the tool's, because
     the prompt is built from those words and "{{the_overnight_email}}" is
     readable in a way that "{{slot_1}}" is not. */
  const gathered: Array<{ slot: string; text: string }> = [];

  for (const s of plan.steps) {
    if (s.kind === "tool") {
      const slot = slotNameFor(s.text, gathered.length);
      gathered.push({ slot, text: s.text });
      steps.push({
        kind: "tool",
        tool: s.tool,
        slot,
        /* Empty, deliberately. Parameters come from the person confirming the
           chain, not from a model's guess at what they meant, because a wrong
           parameter is a wrong action taken confidently. */
        params: {},
        label: s.text.slice(0, 80),
      });
    } else if (s.kind === "human") {
      steps.push({ kind: "human", label: s.text.slice(0, 80), action: "do" });
    }
  }

  /* A CHAIN OF ONE IS NOT A CHAIN, and that is the only bar.
   *
   * This used to require two TOOL steps, which quietly excluded the person
   * this product is most for. Somebody whose morning is "read the overnight
   * email, ring the two accounts that went quiet, walk the floor before
   * standup" describes a real, repeated, valuable sequence, and got told there
   * was nothing here for them.
   *
   * A chain of human steps is not a lesser chain. It arrives when it should,
   * it remembers what comes next, it records what was done and what was
   * skipped, and it measures what each part costs. That measurement is the
   * most differentiated thing this product has, and requiring two tool calls
   * before it would switch on meant the people with the least software got the
   * least of it, which is exactly backwards.
   *
   * Two steps of any kind, because one is not a sequence and offering to save
   * it is offering somebody a longer way to do what they already do. */
  if (steps.length < 2) return null;

  /* THE STEP THAT MAKES IT A CHAIN RATHER THAN A LIST.
   *
   * Without this a described day is N independent lookups: it fetches four
   * things and hands back four things, which is what the person could already
   * do by asking four times. The value was always in reading them together,
   * and every built-in routine does exactly that. A drafted one did not, so
   * the chains people built for themselves were strictly weaker than the ones
   * we shipped.
   *
   * Only when there are at least two things to read together. One lookup plus
   * a paragraph about that lookup is a slower way to see one lookup, and it
   * costs a model call to produce. */
  if (gathered.length >= 2) {
    const firstHuman = steps.findIndex((s) => s.kind === "human");
    const thinking: RoutineStep = {
      kind: "model",
      slot: "sense",
      prompt: [
        ...gathered.map((g) => `${g.text}: {{${g.slot}}}`),
        "",
        "Read those together and say what actually matters, in the person's own terms.",
        "Be specific: name the meeting, the message, the number. If two of them are",
        "about the same thing, say so, because that connection is the reason to look",
        "at them together at all. If nothing here needs attention, say that plainly",
        "rather than manufacturing a priority.",
      ].join("\n"),
      label: "Reading it all together",
    };
    /* Before the person's first step, so what they are asked to act on is the
       reading rather than the raw material. */
    if (firstHuman === -1) steps.push(thinking);
    else steps.splice(firstHuman, 0, thinking);
  }

  return {
    id,
    command,
    description: "Saved from the day you described.",
    audience: "anyone",
    steps,
  };
}

/**
 * A slot name from the person's own words.
 *
 * Lowercased, spaces to underscores, trimmed to something readable, and
 * de-duplicated by position. It ends up inside a prompt the model reads, so a
 * name that says what it holds is worth more than a tidy identifier.
 */
function slotNameFor(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 4)
    .join("_");
  return base ? `${base}_${index + 1}` : `step_${index + 1}`;
}

/**
 * Say it back to them.
 *
 * Their words first on every line, because the whole point is that they
 * recognise their own day. Ours second.
 */
export function renderPlan(plan: DayPlan, canChain: boolean): string {
  if (plan.steps.length === 0) {
    return "I could not pick out any distinct steps from that. Try walking me through it in order, one thing at a time.";
  }

  const lines: string[] = ["Here is your day as I understand it.", ""];

  plan.steps.forEach((s, i) => {
    const n = `${i + 1}.`;
    if (s.kind === "tool") {
      lines.push(`${n} **${s.text}** — I can do this now. ${s.description}.`);
    } else if (s.kind === "human") {
      /* Named as work rather than as a shortfall. A person reading a list of
         their own job wants the parts only they can do described as the
         valuable things they are, not as coverage we failed to reach. */
      lines.push(`${n} **${s.text}** — yours. No tool should be doing this one.`);
    } else if (s.reason === "not_permitted") {
      lines.push(`${n} **${s.text}** — there is a tool for this, but your role cannot run it.`);
    } else if (s.reason === "needs_detail") {
      /* Named differently from "nothing does this", because it is a different
         thing and the person can act on it: the capability exists and the
         chain cannot supply the specifics. */
      lines.push(
        `${n} **${s.text}** — I can do this, but not on its own: it needs a detail each time, so it is better asked directly than run in a chain.`,
      );
    } else {
      lines.push(`${n} **${s.text}** — nothing here does this yet.`);
    }
  });

  lines.push("");
  lines.push(
    `${plan.covered} of ${plan.steps.length} ${plan.covered === 1 ? "step is" : "steps are"} something I can already do${
      plan.humanOnly > 0 ? `, and ${plan.humanOnly} ${plan.humanOnly === 1 ? "is" : "are"} yours` : ""
    }.`,
  );

  if (plan.gaps > 0) {
    /* STATED, NOT BURIED. A plan that quietly omits what it cannot do reads as
       full coverage, and the person finds out at the worst moment. */
    lines.push(
      `${plan.gaps} ${plan.gaps === 1 ? "step has" : "steps have"} nothing behind ${plan.gaps === 1 ? "it" : "them"} yet. I have left ${plan.gaps === 1 ? "it" : "them"} out rather than building a chain that stops halfway.`,
    );
  }

  if (canChain) {
    lines.push("");
    /* Worded from what is actually there. Offering to "chain the parts I can
       do" to somebody whose day is entirely their own reads as an offer of
       nothing, when what they would get is a sequence that arrives on time,
       remembers the order, and keeps count of what it costs them. */
    lines.push(
      plan.covered === 0
        ? "Would you like me to keep this as one command? None of it is mine to do, so it would be a sequence that arrives when you want it, remembers what comes next, and keeps track of what actually got done."
        : "Would you like me to chain the parts I can do into one command? It would stop and hand back to you at each of your own steps.",
    );
  }

  return lines.join("\n");
}

/**
 * What we ask the model, and the only thing we ask it.
 *
 * Constrained hard: it splits prose into steps and, for each, either names a
 * tool from a supplied list or says a person does it. Everything it returns is
 * verified afterwards, so the prompt's job is to make verification pass often,
 * not to be trusted.
 */
export function buildExtractionPrompt(
  description: string,
  tools: ReadonlyArray<ToolDef<unknown, unknown>>,
): string {
  const manifest = tools.map((t) => `${t.name}: ${t.description.split(/(?<=\.)\s/)[0]}`).join("\n");
  return [
    "Someone has described their working day. Break it into the distinct steps they perform, in order.",
    "",
    "For each step, either name ONE tool from the list below that would do it, or mark it as something only a person can do (a conversation, a decision, judgement, preparation, anything physical).",
    "",
    "Rules:",
    '- Use a tool name EXACTLY as written below, or use null. Never invent a name.',
    "- When unsure, use null. A step marked as a person's work is always safe; a wrong tool is not.",
    "- Keep their own words for each step, shortened but not reworded.",
    "- At most 12 steps.",
    "",
    "Reply with JSON only, in this shape:",
    '{"steps":[{"text":"...","tool":"tool_name_or_null","humanOnly":false}]}',
    "",
    "Tools:",
    manifest,
    "",
    "Their day:",
    description,
  ].join("\n");
}

/**
 * Read the model's reply.
 *
 * Tolerant, because a model wrapping JSON in prose is ordinary rather than
 * exceptional, and losing somebody's whole description over a stray sentence
 * would be the worst possible first impression of the product.
 */
export function parseExtraction(raw: string): DescribedStep[] {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) return [];
    return parsed.steps
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
      .map((s) => ({
        text: typeof s.text === "string" ? s.text.slice(0, 200) : "",
        tool: typeof s.tool === "string" && s.tool !== "null" ? s.tool : null,
        humanOnly: s.humanOnly === true,
      }))
      .filter((s) => s.text.length > 0)
      .slice(0, 12);
  } catch {
    return [];
  }
}
