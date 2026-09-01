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
  | {
      kind: "tool";
      text: string;
      tool: string;
      description: string;
      /** Present when the tool needs a value nobody has supplied yet. */
      ask?: Record<string, string>;
    }
  /** Work only a person can do. Not a gap: nothing is missing. */
  | { kind: "human"; text: string }
  /** Software could help and we do not have it. Named honestly. */
  | {
      kind: "gap";
      text: string;
      reason: "no_tool" | "not_permitted" | "needs_detail";
      /** The schema's own words, when it refused without naming a field. */
      detail?: string;
    };

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
    /* A TOOL THAT NEEDS A DETAIL CAN STILL BE A STEP: it just has to ask.
     *
     * This used to become a gap, which meant most of the registry could never
     * appear in a chain somebody described. Looking a client up, checking a
     * financial metric, asking who somebody is: all of them need one value,
     * none of them have a sensible default, and all of them were unreachable.
     *
     * The schema already knows which value. A zod failure names the path, so
     * the parameter to ask for is read from the tool itself rather than
     * guessed or hand-listed, and a tool added tomorrow is chainable the day
     * it lands with nobody updating anything here. */
    const runsWithNothing = tool.paramSchema.safeParse({});
    if (!runsWithNothing.success) {
      const keys = askableKeys(runsWithNothing.error);
      /* THE SCHEMA REFUSED WITHOUT SAYING WHICH FIELD, which happens when a
         rule spans several of them. The tool can still say what to ask for,
         and if it has, the step is chainable after all. */
      if (keys.length === 0 && tool.chainAsk) {
        steps.push({
          kind: "tool",
          text,
          tool: tool.name,
          description: tool.description.split(/(?<=\.)\s/)[0].replace(/\.$/, ""),
          ask: { ...tool.chainAsk },
        });
        continue;
      }
      if (keys.length === 0) {
        /* The schema refused without saying which field, which happens when a
           rule spans several of them ("at least one of from, to or topic").
           Its own message is more use than ours, so it carries. */
        steps.push({
          kind: "gap",
          text,
          reason: "needs_detail",
          detail: runsWithNothing.error.issues[0]?.message,
        });
        continue;
      }
      steps.push({
        kind: "tool",
        text,
        tool: tool.name,
        description: tool.description.split(/(?<=\.)\s/)[0].replace(/\.$/, ""),
        ask: Object.fromEntries(keys.map((k: string) => [k, questionFor(k, text)])),
      });
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
        /* Except the ones the tool insists on, which it will ask for when it
           runs rather than being guessed now. */
        ...(s.ask ? { ask: s.ask } : {}),
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
  /* WHERE IT GOES DECIDES WHAT IT CAN READ, and getting that backwards is how
   * this shipped broken.
   *
   * The step is inserted before the person's first step, so that what they are
   * asked to act on is the reading. But a described day can perfectly well put
   * a tool step AFTER their own: "check the PRs, look at the deploys, rehearse
   * the opening, then message the team". Reading every gathered slot then
   * means reading one that a later step writes, and the chain stops at the
   * thinking step complaining about a slot nobody wrote yet.
   *
   * Found by running a real described day against production rather than by a
   * test, because the fixture I wrote happened to put every tool before the
   * human step. The order invariant only bites when the shape is less tidy.
   *
   * So the position is decided first, and it reads only what was gathered
   * before it. */
  const insertAt = steps.findIndex((s) => s.kind === "human");
  const readable =
    insertAt === -1
      ? gathered
      : gathered.filter((g) => steps.findIndex((s) => s.kind !== "human" && s.slot === g.slot) < insertAt);

  if (readable.length >= 2) {
    const thinking: RoutineStep = {
      kind: "model",
      slot: "sense",
      prompt: [
        ...readable.map((g) => `${g.text}: {{${g.slot}}}`),
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
    if (insertAt === -1) steps.push(thinking);
    else steps.splice(insertAt, 0, thinking);
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
 * Which parameters a tool refused to run without, read from its own schema.
 *
 * A zod failure names the path it failed on, so the field to ask for comes
 * from the tool rather than from a list somebody has to maintain. A tool added
 * tomorrow becomes chainable the day it lands.
 *
 * First segment only: a nested path is a shape nobody can answer in a sentence,
 * and asking "what should objectType.filters.amount.op be" is not a question a
 * person should be asked. Deduped, and capped, because a tool demanding five
 * values is one somebody should call directly rather than chain.
 */
function askableKeys(error: { issues: Array<{ path: PropertyKey[] }> }): string[] {
  const keys = new Set<string>();
  for (const issue of error.issues) {
    const first = issue.path[0];
    if (typeof first === "string" && first) keys.add(first);
  }
  return [...keys].slice(0, 3);
}

/**
 * The question to put in front of somebody, in their own context.
 *
 * Built from the step they described rather than from the parameter name
 * alone, because "what query?" out of nowhere is a worse question than "what
 * should I search for, for 'look up the client'?". The key is humanised
 * because objectType is our word, not theirs.
 */
function questionFor(key: string, stepText: string): string {
  const human = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return `For "${stepText}", what ${human} should I use?`;
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
 * recognize their own day. Ours second.
 */
export function renderPlan(plan: DayPlan, canChain: boolean): string {
  if (plan.steps.length === 0) {
    return "I could not pick out any distinct steps from that. Try walking me through it in order, one thing at a time.";
  }

  const lines: string[] = ["Here is your day as I understand it.", ""];

  plan.steps.forEach((s, i) => {
    const n = `${i + 1}.`;
    if (s.kind === "tool") {
      /* Say that it will ask, and for what. Somebody agreeing to a chain
         should know where it will stop and turn to them, and finding out at
         run time is a surprise in something they were told was automatic. */
      const asks = Object.keys(s.ask ?? {});
      lines.push(
        asks.length > 0
          ? `${n} **${s.text}** — I can do this, and I will ask you for the ${asks.join(" and the ")} when it runs.`
          : `${n} **${s.text}** — I can do this now. ${s.description}.`,
      );
    } else if (s.kind === "human") {
      /* Named as work rather than as a shortfall. A person reading a list of
         their own job wants the parts only they can do described as the
         valuable things they are, not as coverage we failed to reach. */
      lines.push(`${n} **${s.text}** — yours. No tool should be doing this one.`);
    } else if (s.reason === "not_permitted") {
      lines.push(`${n} **${s.text}** — there is a tool for this, but your role cannot run it.`);
    } else if (s.reason === "needs_detail") {
      /* Reached only when the schema refused without naming a field, so its
         own message is the most useful thing to pass on. */
      lines.push(
        `${n} **${s.text}** — I can do this, but not inside a chain: ${
          s.detail ?? "it needs a detail I cannot work out how to ask for"
        }.`,
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

  /* STATED, NOT BURIED, AND NOT LUMPED TOGETHER.
   *
   * This counted every gap as "nothing behind them yet" and said they had been
   * "left out". Both were untrue of two of the three kinds, and the person
   * could see it: a step reported as having nothing behind it was printed
   * three lines above saying "I can do this". Reported 2026-08-25 against a
   * real plan that said "0 of 8 steps are something I can already do" while
   * listing two it could.
   *
   * A tool that exists and needs a detail is not an absence. A tool the role
   * cannot run is not an absence either. Only the third kind is, and only that
   * one is worth apologizing for. Counted separately so the words can be true
   * of what they describe, and so the numbers add up to the list above them. */
  const needsDetail = plan.steps.filter(
    (s) => s.kind === "gap" && s.reason === "needs_detail",
  ).length;
  const notPermitted = plan.steps.filter(
    (s) => s.kind === "gap" && s.reason === "not_permitted",
  ).length;
  const nothingYet = plan.gaps - needsDetail - notPermitted;

  if (needsDetail > 0) {
    lines.push(
      `${needsDetail} ${needsDetail === 1 ? "step needs" : "steps need"} a detail I cannot ask for on ${needsDetail === 1 ? "its" : "their"} own, so ${needsDetail === 1 ? "it stays" : "they stay"} out of the chain. Ask me for ${needsDetail === 1 ? "it" : "them"} directly and I will do ${needsDetail === 1 ? "it" : "them"}.`,
    );
  }
  if (notPermitted > 0) {
    lines.push(
      `${notPermitted} ${notPermitted === 1 ? "step has" : "steps have"} a tool your role cannot run, so ${notPermitted === 1 ? "it is" : "they are"} not in the chain.`,
    );
  }
  if (nothingYet > 0) {
    lines.push(
      `${nothingYet} ${nothingYet === 1 ? "step has" : "steps have"} nothing behind ${nothingYet === 1 ? "it" : "them"} yet. I have left ${nothingYet === 1 ? "it" : "them"} out rather than building a chain that stops halfway.`,
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
    "For each step, either name ONE tool from the list below that would do it, or mark it as something only a person can do (a conversation, a decision, judgment, preparation, anything physical).",
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
