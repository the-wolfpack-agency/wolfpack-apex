/**
 * Turning somebody's description of their day into a plan.
 *
 * ONE BOUNDARY CARRIES THIS WHOLE FEATURE: the model proposes and the registry
 * decides. A model naming a plausible-sounding tool would produce a chain that
 * fails at step three in front of the person who just explained their job, and
 * they would not come back.
 *
 * So most of these tests are about what happens when the model is WRONG, which
 * is the case that will actually occur.
 */
import {
  mapDay,
  draftRoutine,
  renderPlan,
  parseExtraction,
  buildExtractionPrompt,
  type DescribedStep,
} from "../day-plan";
import { referencedSlots } from "../slots";
import type { ToolDef } from "@/lib/assistant/tools/types";

/** A stand-in registry, so these tests do not move when the real one does. */
const tool = (name: string, capability = "*"): ToolDef<unknown, unknown> =>
  ({
    name,
    description: `Do the ${name} thing. Second sentence that should not be shown.`,
    capability,
    paramSchema: { safeParse: () => ({ success: true, data: {} }) },
    handler: async () => ({ ok: true, data: {}, answer: "" }),
  }) as unknown as ToolDef<unknown, unknown>;

const TOOLS = [tool("search_mail"), tool("calendar_widget"), tool("get_financials_metric", "cto")];

const step = (over: Partial<DescribedStep> = {}): DescribedStep => ({
  text: "Read my email",
  tool: "search_mail",
  humanOnly: false,
  ...over,
});

describe("the model proposes, the registry decides", () => {
  it("keeps a step whose tool actually exists", () => {
    const plan = mapDay([step()], TOOLS, "cto");
    expect(plan.steps[0]).toMatchObject({ kind: "tool", tool: "search_mail" });
    expect(plan.covered).toBe(1);
  });

  it("turns an INVENTED tool name into a gap rather than a step", () => {
    /* The failure this exists to prevent: a chain that dies at step three in
       front of somebody who just described their job. */
    const plan = mapDay([step({ tool: "send_slack_message" })], TOOLS, "cto");
    expect(plan.steps[0]).toEqual({
      kind: "gap",
      text: "Read my email",
      reason: "no_tool",
    });
    expect(plan.covered).toBe(0);
  });

  it("turns a tool this role cannot run into a gap, not a promise", () => {
    /* Proposing a chain somebody is not allowed to run is worse than proposing
       a shorter one. */
    const plan = mapDay([step({ text: "Check revenue", tool: "get_financials_metric" })], TOOLS, "sales");
    expect(plan.steps[0]).toMatchObject({ kind: "gap", reason: "not_permitted" });
  });

  it("keeps that same step for a role that can run it", () => {
    const plan = mapDay([step({ text: "Check revenue", tool: "get_financials_metric" })], TOOLS, "cto");
    expect(plan.steps[0]).toMatchObject({ kind: "tool", tool: "get_financials_metric" });
  });

  it("REFUSES a tool that cannot run without a detail", () => {
    /* Found in production. "run my day" contained "read the overnight email"
       as a search_mail step with no parameters, and the chain failed at step
       one with a validation message about the tool rather than about the
       chain. A drafted step carries no parameters by design, so a tool that
       needs one before it can do anything cannot be a step. */
    const needy = tool("search_mail");
    (needy.paramSchema as unknown as { safeParse: (v: unknown) => unknown }).safeParse = (v: unknown) =>
      Object.keys((v ?? {}) as object).length > 0
        ? { success: true, data: v }
        : { success: false, error: { issues: [] } };

    const plan = mapDay([step({ text: "Read the overnight email", tool: "search_mail" })], [needy], "cto");
    expect(plan.steps[0]).toEqual({
      kind: "gap",
      text: "Read the overnight email",
      reason: "needs_detail",
    });
    expect(plan.covered).toBe(0);
  });

  it("ASKS for a value the schema names, instead of giving up on the step", () => {
    /* Most of the registry needs exactly one value: who to look up, what
       metric, which client. All of it used to be unreachable from a chain.
       The schema names the field, so the question comes from the tool rather
       than from a list somebody maintains. */
    const needy = tool("who_is");
    (needy.paramSchema as unknown as { safeParse: (v: unknown) => unknown }).safeParse = (v: unknown) =>
      (v as { query?: string })?.query
        ? { success: true, data: v }
        : { success: false, error: { issues: [{ path: ["query"] }] } };

    const plan = mapDay([step({ text: "Look up the client", tool: "who_is" })], [needy], "cto");
    expect(plan.steps[0]).toMatchObject({
      kind: "tool",
      tool: "who_is",
      ask: { query: 'For "Look up the client", what query should I use?' },
    });
    /* It counts as covered, because it is a step now rather than a hole. */
    expect(plan.covered).toBe(1);
  });

  it("says up front that it will ask, and for what", () => {
    /* Somebody agreeing to a chain should know where it will turn to them.
       Finding out at run time is a surprise in something they were told was
       automatic. */
    const needy = tool("who_is");
    (needy.paramSchema as unknown as { safeParse: (v: unknown) => unknown }).safeParse = (v: unknown) =>
      (v as { query?: string })?.query
        ? { success: true, data: v }
        : { success: false, error: { issues: [{ path: ["query"] }] } };

    const out = renderPlan(
      mapDay([step({ text: "Look up the client", tool: "who_is" })], [needy], "cto"),
      false,
    );
    expect(out).toMatch(/I will ask you for the query when it runs/i);
  });

  it("keeps the gap, with the schema's own words, when no field is named", () => {
    /* A rule spanning several fields ("at least one of from, to or topic")
       cannot be turned into one question, and the schema says why better than
       we could. */
    const needy = tool("search_mail");
    (needy.paramSchema as unknown as { safeParse: (v: unknown) => unknown }).safeParse = () => ({
      success: false,
      error: { issues: [{ path: [], message: "mail search needs at least one of 'from', 'to', or 'topic'" }] },
    });
    const out = renderPlan(
      mapDay([step({ text: "Read the overnight email", tool: "search_mail" })], [needy], "cto"),
      false,
    );
    expect(out).toMatch(/needs at least one of 'from', 'to', or 'topic'/);
    expect(out).not.toMatch(/nothing here does this yet/i);
  });

  it("treats a step with no tool as the person's own work", () => {
    const plan = mapDay([step({ text: "Rehearse the pitch", tool: null })], TOOLS, "cto");
    expect(plan.steps[0]).toEqual({ kind: "human", text: "Rehearse the pitch" });
    expect(plan.humanOnly).toBe(1);
  });

  it("honours humanOnly even when a tool was also named", () => {
    /* Erring toward "a person does this" is always safe. Erring the other way
       hands their work to software that should not have it. */
    const plan = mapDay([step({ humanOnly: true })], TOOLS, "cto");
    expect(plan.steps[0].kind).toBe("human");
  });

  it("drops empty steps rather than rendering blank lines", () => {
    expect(mapDay([step({ text: "   " })], TOOLS, "cto").steps).toEqual([]);
  });
});

describe("the chain it offers to build", () => {
  const plan = (steps: DescribedStep[]) => mapDay(steps, TOOLS, "cto");

  it("builds a routine from the steps that can actually run", () => {
    const r = draftRoutine(
      plan([step(), step({ text: "Check the calendar", tool: "calendar_widget" })]),
      "d",
      "run my day",
    );
    /* The thinking step is what makes it a chain rather than a list. Without
       it a described day is N independent lookups, which is what the person
       could already do by asking N times. */
    expect(r!.steps.map((s) => s.kind)).toEqual(["tool", "tool", "model"]);
  });

  it("NEVER puts a gap in the chain", () => {
    /* A routine with a hole in it stops halfway and leaves the person worse off
       than before they described their day. */
    const r = draftRoutine(
      plan([
        step(),
        step({ text: "Post to the intranet", tool: "nonexistent_tool" }),
        step({ text: "Check the calendar", tool: "calendar_widget" }),
      ]),
      "d",
      "run my day",
    );
    /* Two tools plus the step that reads them together; the gap is absent. */
    expect(r!.steps.filter((s) => s.kind === "tool")).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain("intranet");
  });

  it("marks their own work as work, not as a checkpoint on ours", () => {
    /* These come from somebody describing their own job. Recording them as
       reviews would count their real work as a pause worth deleting. */
    const r = draftRoutine(
      plan([step(), step({ text: "Call the client", tool: null }), step({ text: "Check the calendar", tool: "calendar_widget" })]),
      "d",
      "run my day",
    );
    const human = r!.steps.find((s) => s.kind === "human");
    expect(human).toMatchObject({ action: "do" });
  });

  it("carries no invented parameters", () => {
    /* A guessed parameter is a wrong action taken confidently. They come from
       the person confirming the chain. */
    const r = draftRoutine(plan([step(), step({ text: "Check the calendar", tool: "calendar_widget" })]), "d", "c");
    for (const s of r!.steps) {
      if (s.kind === "tool") expect(s.params).toEqual({});
    }
  });

  it("BUILDS A CHAIN FROM A DAY THAT IS ENTIRELY THE PERSON'S OWN", () => {
    /* The person this product is most for. Somebody whose morning is "ring the
       two accounts that went quiet, walk the floor before standup" describes a
       real, repeated, valuable sequence, and used to be told there was nothing
       here for them because the bar was two TOOL steps.

       A chain of human steps arrives when it should, remembers what comes
       next, records what was done and what was skipped, and measures what each
       part costs. That measurement is the most differentiated thing here, and
       gating it behind two tool calls gave the people with the least software
       the least of it. */
    const r = draftRoutine(
      plan([
        step({ text: "Ring the two accounts that went quiet", tool: null }),
        step({ text: "Walk the floor before standup", tool: null }),
        step({ text: "Rehearse the opening", tool: null }),
      ]),
      "d",
      "run my morning round",
    );

    expect(r).not.toBeNull();
    expect(r!.steps).toHaveLength(3);
    expect(r!.steps.every((s) => s.kind === "human")).toBe(true);
    /* Their own work, marked as work rather than as a checkpoint on ours. */
    expect(r!.steps.every((s) => s.kind === "human" && s.action === "do")).toBe(true);
  });

  it("says what such a chain would actually give them", () => {
    /* Offering to "chain the parts I can do" to somebody whose day is entirely
       their own reads as an offer of nothing. */
    const out = renderPlan(
      plan([
        step({ text: "Ring the accounts", tool: null }),
        step({ text: "Walk the floor", tool: null }),
      ]),
      true,
    );
    expect(out).toMatch(/keep this as one command/i);
    expect(out).toMatch(/arrives when you want it/i);
    expect(out).not.toMatch(/chain the parts I can do/i);
  });

  it("offers nothing when there is only one thing to chain", () => {
    /* A chain of one is a longer way to do what they already do. */
    /* One is not a sequence, whichever kind it is, and offering to save it is
       offering a longer way to do what they already do. */
    expect(draftRoutine(plan([step()]), "d", "c")).toBeNull();
    expect(draftRoutine(plan([step({ tool: null })]), "d", "c")).toBeNull();
  });
});

describe("saying it back to them", () => {
  it("leads every line with their words, not ours", () => {
    const out = renderPlan(mapDay([step({ text: "Trawl the overnight email" })], TOOLS, "cto"), false);
    expect(out).toContain("**Trawl the overnight email**");
  });

  it("describes their own steps as theirs rather than as a shortfall", () => {
    const out = renderPlan(mapDay([step({ text: "Rehearse", tool: null })], TOOLS, "cto"), false);
    expect(out).toMatch(/yours\. No tool should be doing this one/i);
    expect(out).not.toMatch(/unsupported|not covered|missing/i);
  });

  it("states the gaps instead of quietly leaving them out", () => {
    /* A plan that omits what it cannot do reads as full coverage, and they find
       out at the worst possible moment. */
    const out = renderPlan(mapDay([step({ tool: "made_up" })], TOOLS, "cto"), false);
    expect(out).toMatch(/nothing here does this yet/i);
    expect(out).toMatch(/left it out rather than building a chain that stops halfway/i);
  });

  it("distinguishes a permission gap from a missing tool", () => {
    const out = renderPlan(
      mapDay([step({ text: "Check revenue", tool: "get_financials_metric" })], TOOLS, "sales"),
      false,
    );
    expect(out).toMatch(/your role cannot run it/i);
  });

  it("offers the chain only when there is one to offer", () => {
    const two = mapDay([step(), step({ text: "Calendar", tool: "calendar_widget" })], TOOLS, "cto");
    expect(renderPlan(two, true)).toMatch(/chain the parts I can do into one command/i);
    expect(renderPlan(two, false)).not.toMatch(/chain the parts/i);
  });

  it("says something useful when nothing could be read out of the description", () => {
    const out = renderPlan(mapDay([], TOOLS, "cto"), false);
    expect(out).toMatch(/one thing at a time/i);
  });
});

describe("reading what the model sent back", () => {
  it("parses a clean reply", () => {
    const out = parseExtraction('{"steps":[{"text":"Read email","tool":"search_mail","humanOnly":false}]}');
    expect(out).toEqual([{ text: "Read email", tool: "search_mail", humanOnly: false }]);
  });

  it("finds the JSON inside prose, because models wrap things", () => {
    /* Losing somebody's whole description over a stray sentence would be the
       worst possible first impression of the product. */
    const out = parseExtraction('Sure! Here you go:\n{"steps":[{"text":"A","tool":null,"humanOnly":true}]}\nHope that helps.');
    expect(out).toHaveLength(1);
  });

  it("returns nothing rather than throwing on rubbish", () => {
    for (const bad of ["", "not json at all", "{", '{"steps":"nope"}', "{}"]) {
      expect(parseExtraction(bad)).toEqual([]);
    }
  });

  it('treats the literal string "null" as no tool', () => {
    expect(parseExtraction('{"steps":[{"text":"A","tool":"null"}]}')[0].tool).toBeNull();
  });

  it("caps the number of steps, so one description cannot become a wall", () => {
    const many = { steps: Array.from({ length: 40 }, (_, i) => ({ text: `Step ${i}`, tool: null })) };
    expect(parseExtraction(JSON.stringify(many))).toHaveLength(12);
  });

  it("drops entries with no text", () => {
    expect(parseExtraction('{"steps":[{"text":"","tool":null},{"text":"Real","tool":null}]}')).toHaveLength(1);
  });
});

describe("what we ask the model", () => {
  it("tells it never to invent a name, and to prefer a person when unsure", () => {
    const prompt = buildExtractionPrompt("I read email then call clients", TOOLS);
    expect(prompt).toMatch(/Never invent a name/i);
    expect(prompt).toMatch(/When unsure, use null/i);
  });

  it("lists only the tools it is allowed to choose from", () => {
    const prompt = buildExtractionPrompt("x", [tool("search_mail")]);
    expect(prompt).toContain("search_mail");
    expect(prompt).not.toContain("calendar_widget");
  });

  it("shows one sentence per tool, so a long registry stays readable", () => {
    const prompt = buildExtractionPrompt("x", TOOLS);
    expect(prompt).not.toContain("Second sentence that should not be shown");
  });
});

describe("the step that reads it all together", () => {
  /** Local, because the helper above is scoped to its own block. */
  const p = (steps: DescribedStep[]) => mapDay(steps, TOOLS, "cto");

  const two = () =>
    p([
      step({ text: "Read the overnight email", tool: "search_mail" }),
      step({ text: "Check the calendar", tool: "calendar_widget" }),
    ]);

  it("names each source in the person's own words", () => {
    /* The prompt is built from what they said, so a slot reads as
       "{{read_the_overnight_email_1}}" rather than "{{slot_1}}". The model
       reads this, and a name that says what it holds is worth more than a tidy
       identifier. */
    const r = draftRoutine(two(), "d", "run my day");
    const model = r!.steps.find((x) => x.kind === "model");
    expect(model).toBeDefined();
    if (model && model.kind === "model") {
      expect(model.prompt).toContain("Read the overnight email:");
      expect(model.prompt).toMatch(/\{\{read_the_overnight_email_1\}\}/);
    }
  });

  it("comes BEFORE the person's own step", () => {
    /* So what they are asked to act on is the reading, not the raw material. */
    const r = draftRoutine(
      p([
        step({ text: "Read the email", tool: "search_mail" }),
        step({ text: "Check the calendar", tool: "calendar_widget" }),
        step({ text: "Ring the client", tool: null }),
      ]),
      "d",
      "run my day",
    );
    const kinds = r!.steps.map((x) => x.kind);
    expect(kinds.indexOf("model")).toBeLessThan(kinds.indexOf("human"));
  });

  it("is not added when there is only one thing to read", () => {
    /* One lookup plus a paragraph about that lookup is a slower way to see one
       lookup, and it costs a model call to produce. */
    const r = draftRoutine(
      p([
        step({ text: "Read the email", tool: "search_mail" }),
        step({ text: "Ring the client", tool: null }),
      ]),
      "d",
      "run my day",
    );
    expect(r!.steps.some((x) => x.kind === "model")).toBe(false);
  });

  it("is not added to a day that is entirely the person's own", () => {
    /* Nothing was gathered, so a model call would be spent summarizing an
       empty set. */
    const r = draftRoutine(
      p([
        step({ text: "Ring the accounts", tool: null }),
        step({ text: "Walk the floor", tool: null }),
      ]),
      "d",
      "run my day",
    );
    expect(r!.steps.every((x) => x.kind === "human")).toBe(true);
  });

  it("tells the model to say when nothing needs attention", () => {
    /* The failure this prevents is a manufactured priority on a quiet day. */
    const r = draftRoutine(two(), "d", "run my day");
    const model = r!.steps.find((x) => x.kind === "model");
    if (model && model.kind === "model") {
      expect(model.prompt).toMatch(/rather than manufacturing a priority/i);
    }
  });

  it("reads NOTHING written after it, which is how this shipped broken", () => {
    /* A described day can perfectly well put a tool step after the person's
       own: "check the PRs, look at the deploys, rehearse the opening, then
       message the team". The thinking step goes before the rehearsal, so the
       message step's output does not exist yet.

       Reading it anyway produced a chain that stopped at the thinking step
       complaining about a slot nobody had written. Found by running a real
       described day against production; the fixture here happened to put every
       tool before the human step, so the invariant never bit. */
    const r = draftRoutine(
      p([
        step({ text: "Check the PRs", tool: "search_mail" }),
        step({ text: "Look at the deploys", tool: "calendar_widget" }),
        step({ text: "Rehearse the opening", tool: null }),
        step({ text: "Message the team", tool: "search_mail" }),
      ]),
      "d",
      "run my day",
    )!;

    const model = r.steps.find((x) => x.kind === "model");
    expect(model).toBeDefined();
    if (model && model.kind === "model") {
      expect(model.prompt).toContain("Check the PRs:");
      expect(model.prompt).toContain("Look at the deploys:");
      /* The one written after it must be absent. */
      expect(model.prompt).not.toContain("Message the team:");
    }
  });

  it("is omitted when fewer than two things precede the person's step", () => {
    /* One lookup before the rehearsal is not worth a model call, even though
       two tools exist in the chain overall. */
    const r = draftRoutine(
      p([
        step({ text: "Check the PRs", tool: "search_mail" }),
        step({ text: "Rehearse the opening", tool: null }),
        step({ text: "Message the team", tool: "calendar_widget" }),
      ]),
      "d",
      "run my day",
    )!;
    expect(r.steps.some((x) => x.kind === "model")).toBe(false);
  });

  it("reads every slot it names, so the chain cannot fail on a missing one", () => {
    /* The order invariant, checked on generated output rather than assumed:
       every slot the thinking step reads is written by a step before it. */
    /* Checked on the AWKWARD shape, not the tidy one: a tool step after the
       person's own is exactly where this broke. */
    const r = draftRoutine(
      p([
        step({ text: "Check the PRs", tool: "search_mail" }),
        step({ text: "Look at the deploys", tool: "calendar_widget" }),
        step({ text: "Rehearse the opening", tool: null }),
        step({ text: "Message the team", tool: "search_mail" }),
      ]),
      "d",
      "run my day",
    )!;
    const written = new Set<string>();
    for (const x of r.steps) {
      if (x.kind === "model") {
        for (const slot of referencedSlots(x.prompt)) {
          expect({ slot, writtenBefore: written.has(slot) }).toEqual(
            expect.objectContaining({ writtenBefore: true }),
          );
        }
      }
      if (x.kind !== "human" && x.slot) written.add(x.slot);
    }
  });
});

/* ---------------------------------------------------------------------
 * Reported 2026-08-25 from a real plan. A Wednesday that opened "I check
 * email" came back saying:
 *
 *   1. check email — I can do this, but not inside a chain: ...
 *   ...
 *   0 of 8 steps are something I can already do, and 6 are yours.
 *   2 steps have nothing behind them yet. I have left them out.
 *
 * Three untrue things in four lines. It could do step 1 and said it could,
 * three lines before saying it could do none of them. The two steps were not
 * "left out" - they are printed as items 1 and 3. And "nothing behind them
 * yet" describes a tool that exists and wants a parameter.
 *
 * The counting was the same mistake as the routine step tally: a numerator and
 * a denominator measured on different bases, in front of somebody who can see
 * both.
 * --------------------------------------------------------------- */
describe("the plan summary agrees with the list above it", () => {
  const tools = [
    {
      name: "search_mail",
      description: "Search the mailbox. Filters by sender, topic, or both.",
      capability: "*",
      paramSchema: {
        safeParse: () => ({
          success: false,
          error: { issues: [{ path: [], message: "needs at least one of 'from', 'to', or 'topic'" }] },
        }),
      },
      chainAsk: { topic: "What should I look for?" },
    },
  ];
  const day = [
    { text: "check email", tool: "search_mail", humanOnly: false },
    { text: "go to the gym", tool: null, humanOnly: true },
    { text: "check email again", tool: "search_mail", humanOnly: false },
    { text: "eat lunch", tool: null, humanOnly: true },
  ];

  const plan = mapDay(day as never, tools as never, "cto");

  it("counts a step it can do as a step it can do", () => {
    expect(plan.covered).toBe(2);
    expect(plan.humanOnly).toBe(2);
    expect(plan.gaps).toBe(0);
  });

  /* The arithmetic the reader does without meaning to. */
  it("adds up to the number of steps listed", () => {
    expect(plan.covered + plan.humanOnly + plan.gaps).toBe(plan.steps.length);
  });

  it("never claims to have left out a step it just printed", () => {
    const out = renderPlan(plan, true);
    const listed = out.match(/^\d+\. /gm) ?? [];
    expect(listed).toHaveLength(4);
    expect(out).not.toMatch(/left them out|left it out/);
    expect(out).toContain("2 of 4 steps are something I can already do");
  });

  /* A tool that exists and wants a parameter is not an absence, and saying so
     sends somebody looking for a feature that is already there. */
  it("does not describe a tool that needs a detail as nothing at all", () => {
    const noAsk = [{ ...tools[0], chainAsk: undefined }];
    const p2 = mapDay(day as never, noAsk as never, "cto");
    const out = renderPlan(p2, false);
    expect(p2.gaps).toBe(2);
    expect(out).not.toMatch(/nothing behind/);
    expect(out).toMatch(/needs? a detail/i);
  });
});
