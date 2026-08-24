/**
 * The runner.
 *
 * Three behaviours carry the design, and each is here:
 *
 *   1. It STOPS at a person, and everything already done survives the stop.
 *   2. It counts machine time and human time SEPARATELY. That split is the
 *      reason a run is persisted at all: it is what turns "this feels slow"
 *      into "step four costs eleven minutes a day and nobody ever changes what
 *      it produced".
 *   3. A failed step ends the chain rather than carrying on with a slot the
 *      failed step should have written.
 */
import { advance, resume, startRun, remainingSteps, type RunnerDeps } from "../runner";
import type { Routine } from "../types";

/** A clock the test drives, so the timing assertions are exact. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

const WHO = { runId: "run-1", userId: "u1", workspaceId: "w1" };

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    dispatchTool: async () => ({ ok: true, answer: "done", data: { n: 1 } }),
    askModel: async () => "the model's answer",
    now: () => 0,
    ...over,
  };
}

const routine = (steps: Routine["steps"]): Routine => ({
  id: "t",
  command: "t",
  description: "t",
  audience: "anyone",
  steps,
});

describe("running to the end", () => {
  it("runs every step in order and finishes", async () => {
    const calls: string[] = [];
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "First step here", slot: "one" },
      { kind: "tool", tool: "b", params: {}, label: "Second step here" },
    ]);

    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (tool) => {
        calls.push(tool);
        return { ok: true, answer: "ok", data: tool };
      },
    }));

    expect(calls).toEqual(["a", "b"]);
    expect(run.state).toBe("done");
    expect(run.outcomes).toHaveLength(2);
    expect(run.slots.one).toBe("a");
  });

  it("passes an earlier step's output into a later step", async () => {
    /* The carrying that a person does by hand today. */
    const seen: unknown[] = [];
    const r = routine([
      { kind: "tool", tool: "read", params: {}, label: "Reading the thing", slot: "inbox" },
      { kind: "tool", tool: "use", params: { body: "{{inbox}}" }, label: "Using the thing" },
    ]);

    await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (tool, params) => {
        seen.push(params);
        return { ok: true, data: tool === "read" ? "three emails" : null };
      },
    }));

    expect(seen[1]).toEqual({ body: "three emails" });
  });

  it("sends a model step through the injected model, with slots resolved", async () => {
    let prompt = "";
    const r = routine([
      { kind: "tool", tool: "read", params: {}, label: "Reading the thing", slot: "inbox" },
      { kind: "model", prompt: "summarise {{inbox}}", label: "Summarising it", slot: "summary" },
    ]);

    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async () => ({ ok: true, data: "two threads" }),
      askModel: async (p) => {
        prompt = p;
        return "here is the summary";
      },
    }));

    expect(prompt).toBe("summarise two threads");
    expect(run.slots.summary).toBe("here is the summary");
  });
});

describe("stopping at a person", () => {
  it("pauses at the human step and keeps everything already done", async () => {
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input", slot: "one" },
      { kind: "human", label: "Check this before it goes", show: ["one"] },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);

    const c = clock();
    const run = await advance(r, startRun(r, WHO), deps({ now: c.now }));

    expect(run.state).toBe("waiting_for_human");
    expect(run.cursor).toBe(1);
    expect(run.slots.one).toEqual({ n: 1 });
    expect(run.pausedAt).toBe(1_000);
    /* The step it is sitting on is VISIBLE. A run showing nothing at the point
       it stopped reads as a run that hung. */
    expect(run.outcomes[run.outcomes.length - 1]).toMatchObject({
      kind: "human",
      status: "waiting",
    });
  });

  it("does not run the step after the person until they come back", async () => {
    const calls: string[] = [];
    const r = routine([
      { kind: "human", label: "Have a look at this first" },
      { kind: "tool", tool: "send", params: {}, label: "Sending the thing" },
    ]);

    await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (t) => {
        calls.push(t);
        return { ok: true };
      },
    }));

    expect(calls).toEqual([]);
  });

  it("carries on from the right step when they do", async () => {
    const calls: string[] = [];
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input" },
      { kind: "human", label: "Check this before it goes" },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);
    const d = deps({
      dispatchTool: async (t) => {
        calls.push(t);
        return { ok: true };
      },
    });

    const paused = await advance(r, startRun(r, WHO), d);
    const done = await resume(r, paused, d);

    expect(calls).toEqual(["a", "b"]);
    expect(done.state).toBe("done");
  });
});

describe("counting whose time it was", () => {
  it("keeps machine time and human time apart", async () => {
    /* THE MEASUREMENT THIS WHOLE THING EXISTS TO PRODUCE. Machine time is what
       the tools cost; human time is what the handoff cost. Adding them
       together would hide exactly the number worth acting on. */
    const c = clock();
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input" },
      { kind: "human", label: "Check this before it goes" },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);
    const d: RunnerDeps = {
      now: c.now,
      askModel: async () => "",
      dispatchTool: async () => {
        c.tick(300);
        return { ok: true };
      },
    };

    const paused = await advance(r, startRun(r, WHO), d);
    c.tick(11 * 60 * 1000); // the person takes eleven minutes
    const done = await resume(r, paused, d);

    expect(done.techMs).toBe(600);
    expect(done.humanMs).toBe(660_000);
  });

  it("puts the wait on the human step itself", async () => {
    /* So "which step do people stall on" is a query, not an investigation. */
    const c = clock();
    const r = routine([
      { kind: "human", label: "Check this before it goes" },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);
    const d = deps({ now: c.now });

    const paused = await advance(r, startRun(r, WHO), d);
    c.tick(5_000);
    const done = await resume(r, paused, d);

    expect(done.outcomes[0]).toMatchObject({ kind: "human", status: "ok", durationMs: 5_000 });
  });

  it("never counts negative human time when a clock disagrees with itself", async () => {
    /* Two machines, two clocks. A negative wait would quietly flatter every
       routine it touched, and flattering numbers are worse than none. */
    const c = clock(10_000);
    const r = routine([{ kind: "human", label: "Check this before it goes" }]);
    const paused = await advance(r, startRun(r, WHO), deps({ now: c.now }));
    const done = await resume(r, paused, deps({ now: () => 1 }), { pausedAt: 10_000 });

    expect(done.humanMs).toBe(0);
  });
});

describe("when a step does not work", () => {
  it("stops the chain rather than carrying on without the output", async () => {
    /* Carrying on is how a chain reaches "send this to the client" holding
       half of what it needed. */
    const calls: string[] = [];
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input", slot: "one" },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);

    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (t) => {
        calls.push(t);
        return t === "a" ? { ok: false, error: "the mailbox is unreachable" } : { ok: true };
      },
    }));

    expect(run.state).toBe("failed");
    expect(calls).toEqual(["a"]);
    expect(run.outcomes[0]).toMatchObject({ status: "failed", error: "the mailbox is unreachable" });
  });

  it("keeps every step that already succeeded", async () => {
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input", slot: "one" },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);

    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (t) => (t === "a" ? { ok: true, data: "kept" } : { ok: false, error: "no" }),
    }));

    expect(run.slots.one).toBe("kept");
    expect(run.outcomes[0].status).toBe("ok");
  });

  it("says which step to edit when a routine outlives its tool", async () => {
    const r = routine([{ kind: "tool", tool: "removed_tool", params: {}, label: "Doing the old thing" }]);

    const run = await advance(r, startRun(r, WHO), deps({ dispatchTool: async () => null }));

    expect(run.state).toBe("failed");
    expect(run.outcomes[0].error).toMatch(/not a tool any more/i);
    expect(run.outcomes[0].error).toContain("removed_tool");
  });

  it("fails the step, not the run, when a tool throws", async () => {
    const r = routine([{ kind: "tool", tool: "a", params: {}, label: "Doing the thing" }]);

    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async () => {
        throw new Error("connector exploded");
      },
    }));

    expect(run.state).toBe("failed");
    expect(run.outcomes[0].error).toBe("connector exploded");
  });

  it("names a missing slot as the routine's problem, not the tool's", async () => {
    const r = routine([{ kind: "tool", tool: "a", params: { body: "{{never}}" }, label: "Doing the thing" }]);

    const run = await advance(r, startRun(r, WHO), deps());

    expect(run.outcomes[0].error).toMatch(/no earlier step wrote/i);
  });
});

describe("what a run refuses to do twice", () => {
  it("will not re-run a finished routine", async () => {
    /* Re-running "send the client an update" because a caller asked twice has
       to be impossible rather than unlikely. */
    const calls: string[] = [];
    const r = routine([{ kind: "tool", tool: "send", params: {}, label: "Sending the thing" }]);
    const d = deps({
      dispatchTool: async (t) => {
        calls.push(t);
        return { ok: true };
      },
    });

    const done = await advance(r, startRun(r, WHO), d);
    const again = await advance(r, done, d);

    expect(calls).toEqual(["send"]);
    expect(again).toBe(done);
  });

  it("will not resume a run that is not waiting on anybody", async () => {
    const r = routine([{ kind: "tool", tool: "a", params: {}, label: "Doing the thing" }]);
    const done = await advance(r, startRun(r, WHO), deps());
    expect(await resume(r, done, deps())).toBe(done);
  });

  it("reports what never ran when a chain stopped early", async () => {
    const r = routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input" },
      { kind: "human", label: "Check this before it goes" },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);
    const paused = await advance(r, startRun(r, WHO), deps());
    expect(remainingSteps(r, paused)).toHaveLength(1);
  });
});

describe("a human step somebody did not do", () => {
  const withHuman = (action: "review" | "do") =>
    routine([
      { kind: "tool", tool: "a", params: {}, label: "Gathering the input" },
      { kind: "human", label: "Rehearse the opening out loud", action },
      { kind: "tool", tool: "b", params: {}, label: "Sending the thing" },
    ]);

  it("carries on rather than blocking until somebody ticks a box", async () => {
    /* A routine that blocks teaches people to tick the box, and a ticked box
       that means nothing is worse than an honest skip. */
    const calls: string[] = [];
    const d = deps({
      dispatchTool: async (t) => {
        calls.push(t);
        return { ok: true };
      },
    });
    const r = withHuman("do");
    const paused = await advance(r, startRun(r, WHO), d);
    const done = await resume(r, paused, d, { skipped: true });

    expect(calls).toEqual(["a", "b"]);
    expect(done.state).toBe("done");
  });

  it("records the skip on the step", async () => {
    const d = deps();
    const r = withHuman("do");
    const paused = await advance(r, startRun(r, WHO), d);
    const done = await resume(r, paused, d, { skipped: true });

    expect(done.outcomes[1]).toMatchObject({ kind: "human", status: "skipped", skipped: true });
  });

  it("does not count a skipped step as time somebody spent", async () => {
    /* Counting elapsed time on the runs where nobody did the work would make a
       step look expensive using exactly the runs where it did not happen. */
    const c = clock();
    const r = withHuman("do");
    const d = deps({ now: c.now });
    const paused = await advance(r, startRun(r, WHO), d);
    c.tick(10 * 60 * 1000);
    const done = await resume(r, paused, d, { skipped: true });

    expect(done.humanMs).toBe(0);
  });

  it("counts the time when they did do it", async () => {
    const c = clock();
    const r = withHuman("do");
    const d = deps({ now: c.now });
    const paused = await advance(r, startRun(r, WHO), d);
    c.tick(4 * 60 * 1000);
    const done = await resume(r, paused, d);

    expect(done.humanMs).toBe(240_000);
    expect(done.outcomes[1].status).toBe("ok");
  });

  it("marks an unlabelled human step as a review, not as missed work", async () => {
    /* An ordinary checkpoint miscounted as a missed human action would put a
       false signal into the insight this distinction exists to produce. */
    const r = routine([{ kind: "human", label: "Check this before it goes" }]);
    const paused = await advance(r, startRun(r, WHO), deps());
    expect(paused.outcomes[0].action).toBe("review");
  });
});

describe("a step that has to ask for a value", () => {
  /* THE CEILING THIS REMOVES. Searching mail needs to know what to search for
     and listing CI runs needs a repository. Neither has a sensible default, so
     until now they could not be steps at all: a chain could gather things but
     never look anything up. */
  const asking = () =>
    routine([
      {
        kind: "tool",
        tool: "search_mail",
        params: {},
        ask: { topic: "What should I search your mail for?" },
        label: "Searching your mail",
        slot: "mail",
      },
      { kind: "human", label: "Read what came back", action: "review" },
    ]);

  it("pauses and asks, instead of failing validation", async () => {
    /* Reported as a failure it would read as the tool being broken, when it is
       a question nobody has been asked yet. */
    const calls: string[] = [];
    const r = asking();
    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (t) => {
        calls.push(t);
        return { ok: true };
      },
    }));

    expect(run.state).toBe("waiting_for_human");
    expect(run.pendingAsk).toMatchObject({
      stepIndex: 0,
      key: "topic",
      question: "What should I search your mail for?",
    });
    /* The tool has NOT run. */
    expect(calls).toEqual([]);
  });

  it("runs the step it asked about, not the one after it", async () => {
    /* Advancing the cursor on resume would skip the very step the question was
       for, and the chain would carry on having never done the thing. */
    const seen: unknown[] = [];
    const r = asking();
    const d = deps({
      dispatchTool: async (_t, params) => {
        seen.push(params);
        return { ok: true, data: "three threads" };
      },
    });

    const paused = await advance(r, startRun(r, WHO), d);
    const next = await resume(r, paused, d, { answer: "the Henderson account" });

    expect(seen).toEqual([{ topic: "the Henderson account" }]);
    expect(next.slots.mail).toBe("three threads");
  });

  it("keeps the answer, so a later pause does not ask twice", async () => {
    const r = asking();
    const d = deps();
    const paused = await advance(r, startRun(r, WHO), d);
    const next = await resume(r, paused, d, { answer: "invoices" });

    expect(next.answers).toEqual({ "0:topic": "invoices" });
  });

  it("the person's answer wins over anything the routine carried", async () => {
    /* The whole reason for asking is that the routine could not know. */
    const seen: unknown[] = [];
    const r = routine([
      {
        kind: "tool",
        tool: "search_mail",
        params: { topic: "whatever the author guessed" },
        ask: { topic: "What should I search for?" },
        label: "Searching",
      },
    ]);
    const d = deps({
      dispatchTool: async (_t, params) => {
        seen.push(params);
        return { ok: true };
      },
    });

    const paused = await advance(r, startRun(r, WHO), d);
    await resume(r, paused, d, { answer: "the renewal" });

    expect(seen).toEqual([{ topic: "the renewal" }]);
  });

  it("stays put when the answer is empty, rather than running with nothing", async () => {
    const r = asking();
    const d = deps();
    const paused = await advance(r, startRun(r, WHO), d);
    const still = await resume(r, paused, d, { answer: "   " });

    expect(still.state).toBe("waiting_for_human");
    expect(still.pendingAsk?.key).toBe("topic");
  });

  it("does not ask about a value the routine already supplies", async () => {
    const seen: unknown[] = [];
    const r = routine([
      { kind: "tool", tool: "runs", params: { repo: "wolfpack-apex" }, label: "Checking CI" },
    ]);
    const run = await advance(r, startRun(r, WHO), deps({
      dispatchTool: async (_t, params) => {
        seen.push(params);
        return { ok: true };
      },
    }));

    expect(run.state).toBe("done");
    expect(seen).toEqual([{ repo: "wolfpack-apex" }]);
  });
});

/**
 * Which tool ran that step.
 *
 * The step definition has always known, and the outcome did not, so the
 * store wrote null rather than guess. Right call at the time, and it left
 * the column empty in every run ever recorded.
 *
 * Confirmed against production on 2026-08-24: "look at the week ahead"
 * ran five steps, three of them tools, 4.9s of machine time against 55.8s
 * of human time, and every tool column was null. It is the column that
 * answers which tool is only ever reached from a routine, and the one a
 * step-by-step view of a chain has to read to say which system each step
 * touched.
 */
describe("the record says which tool ran", () => {
  it("carries the tool name on a tool step", async () => {
    const r = routine([
      { kind: "tool", slot: "a", tool: "calendar_widget", params: {}, label: "Reading the calendar" },
    ]);
    const run = await advance(r, startRun(r, WHO), deps());
    expect(run.outcomes[0]).toMatchObject({ kind: "tool", tool: "calendar_widget" });
  });

  it("leaves it off a model or human step", async () => {
    /* A model or human step carrying a tool name would make the table lie
       about what touched the client's systems, which is the one thing
       this record exists to be right about. */
    const r = routine([
      { kind: "model", slot: "m", prompt: "say something", label: "Thinking" },
      { kind: "human", label: "Decide", action: "do" },
    ]);
    const run = await advance(r, startRun(r, WHO), deps());
    for (const o of run.outcomes) expect(o.tool).toBeUndefined();
  });
});
