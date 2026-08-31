/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * /pilot — the adoption panel.
 *
 * WHY THIS TEST EXISTS. Every other figure on this page describes the product
 * working; the adoption panel is the only one that can embarrass us, and it is
 * the one a client will read hardest. Three things have to hold:
 *
 *   - unreadable is not zero. "Nobody used it" and "we could not tell" are
 *     different sentences, and this repo has shipped the first when it meant
 *     the second more than once.
 *   - a share is never printed when the denominator is absent, because 0% of 0
 *     reads as total failure.
 *   - repeated failures are shown. They are the least flattering thing on the
 *     page and the reason it is worth having.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: (...a: unknown[]) => mockGetInstinctUser(...a),
}));

import { render, screen, waitFor } from "@testing-library/react";
import PilotPage from "@/app/(dashboard)/pilot/page";

const base = {
  readable: true,
  passages: 1200,
  libraries: 4,
  deterministicAnswers: 40,
  modelAnswers: 10,
  declined: 3,
};

function respond(body: Record<string, unknown>) {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetInstinctUser.mockReturnValue({ id: "u1", email: "a@b.co" });
});

it("shows reach, never-started and the verdict when adoption is readable", async () => {
  respond({
    ...base,
    adoption: {
      readable: true,
      invited: 10,
      everAsked: 6,
      activeRecently: 4,
      lapsed: 1,
      unansweredQuestions: 12,
      repeatedFailures: [],
    },
  });

  render(<PilotPage />);

  const reach = await screen.findByTestId("pilot-adoption-reach");
  expect(reach).toHaveTextContent("6 of 10");
  expect(reach).toHaveTextContent("60%");
  expect(await screen.findByTestId("pilot-adoption-never")).toHaveTextContent("4");
  expect(await screen.findByTestId("pilot-adoption-active")).toHaveTextContent("4");
});

/* THE DISTINCTION THE WHOLE PANEL RESTS ON. A failed read must not render as
   a team that never showed up. */
it("says the figures could not be read rather than showing zeros", async () => {
  respond({
    ...base,
    adoption: {
      readable: false,
      invited: 0,
      everAsked: 0,
      activeRecently: 0,
      lapsed: 0,
      unansweredQuestions: 0,
      repeatedFailures: [],
    },
  });

  render(<PilotPage />);

  expect(await screen.findByTestId("pilot-adoption-unreadable")).toBeInTheDocument();
  expect(screen.queryByTestId("pilot-adoption-reach")).not.toBeInTheDocument();
});

/* Nobody invited yet is not 0% adoption. It is a pilot that has not started,
   and printing a percentage there invents a denominator. */
it("does not print a percentage when nobody has been given access", async () => {
  respond({
    ...base,
    adoption: {
      readable: true,
      invited: 0,
      everAsked: 0,
      activeRecently: 0,
      lapsed: 0,
      unansweredQuestions: 0,
      repeatedFailures: [],
    },
  });

  render(<PilotPage />);

  const reach = await screen.findByTestId("pilot-adoption-reach");
  expect(reach).toHaveTextContent("No one has been given access yet");
  expect(reach).not.toHaveTextContent("%");
});

it("lists questions asked repeatedly and never answered", async () => {
  respond({
    ...base,
    adoption: {
      readable: true,
      invited: 10,
      everAsked: 6,
      activeRecently: 4,
      lapsed: 1,
      unansweredQuestions: 40,
      repeatedFailures: [
        { question: "find coaching calls spreadsheet", attempts: 36 },
        { question: "what does the sow say about payment terms", attempts: 11 },
      ],
    },
  });

  render(<PilotPage />);

  const failures = await screen.findByTestId("pilot-adoption-failures");
  expect(failures).toHaveTextContent("find coaching calls spreadsheet");
  expect(failures).toHaveTextContent("36");
  expect(failures).toHaveTextContent("what does the sow say about payment terms");
});

/* The panel disappears rather than guessing when the API predates it. An older
   deployment must not render an adoption story built from undefined. */
it("renders nothing at all when the API does not carry adoption", async () => {
  respond({ ...base });

  render(<PilotPage />);

  await screen.findByTestId("pilot-passages");
  expect(screen.queryByTestId("pilot-adoption")).not.toBeInTheDocument();
});

/* WORDS RUNNING INTO EACH OTHER, REPORTED FROM THE LIVE PAGE.
   "...not a churn number.Somebody who used it and stopped..." rendered with no
   gap at all, because the sentence after the bold lead began on the next source
   line and JSX strips a whitespace gap containing a newline. Invisible in
   review, obvious to a reader: the worst combination, so it is asserted rather
   than watched for.

   The other three leads DID have their spaces in the DOM, proven by rendering
   the component and reading textContent, and still read as joined because a
   bold phrase with no terminal punctuation runs visually into what follows.
   Each lead now ends in a full stop. */
it("never runs a bold lead into the sentence after it", async () => {
  respond({
    ...base,
    adoption: {
      readable: true,
      invited: 10,
      everAsked: 6,
      activeRecently: 4,
      lapsed: 1,
      unansweredQuestions: 12,
      repeatedFailures: [],
    },
  });
  render(<PilotPage />);

  const plan = await screen.findByTestId("pilot-adoption-plan");

  /* PER ITEM, NOT ACROSS THE WHOLE BLOCK. textContent concatenates adjacent
     list items with no separator, so reading the block as one string reports
     every boundary between bullets as a missing space. The first version of
     this test did exactly that and failed on correct markup. */
  const items = Array.from(plan.querySelectorAll("li"));
  expect(items.length).toBeGreaterThan(0);
  for (const li of items) {
    const text = li.textContent ?? "";
    /* A letter immediately after a full stop, inside one bullet, is the
       signature of a collapsed gap. */
    expect(text).not.toMatch(/[a-z]\.[A-Za-z]/);
    /* And no bold lead may run straight into its sentence. */
    const lead = li.querySelector("strong")?.textContent ?? "";
    if (lead) {
      const after = text.slice(lead.length);
      expect(after.startsWith(" ")).toBe(true);
    }
  }

  const whole = plan.textContent ?? "";
  for (const join of ["startedget", "requestthat", "number.Somebody", "invitation.When"]) {
    expect(whole).not.toContain(join);
  }
});

/* The plan is the half a client acts on. A scoreboard with no next move is
   the thing this panel was built not to be. */
it("names what we do about the numbers, next to them", async () => {
  respond({
    ...base,
    adoption: {
      readable: true,
      invited: 10,
      everAsked: 6,
      activeRecently: 4,
      lapsed: 1,
      unansweredQuestions: 12,
      repeatedFailures: [],
    },
  });

  render(<PilotPage />);

  expect(await screen.findByTestId("pilot-adoption-plan")).toBeInTheDocument();
});

/**
 * WHAT IT COSTS TO RUN.
 *
 * Moved here from /admin/insights, which is gated to three roles and mixes
 * these figures with our own backlog signals. Those are our questions; what a
 * model costs and how little of the product needs one are the client's, and
 * they were on the wrong page for the wrong audience.
 */
describe("the capability figures", () => {
  const capability = {
    windowDays: 60,
    takenAt: "2026-08-28T00:00:00.000Z",
    gate: {
      actionsAuthorized: { value: 3675, detail: "" },
      checkpointsSigned: { value: 12, detail: "" },
    },
    efficiency: {
      deterministicSharePct: { value: 98, detail: "" },
      modelCalls: { value: 167, detail: "" },
      cheapTierPct: { value: 87, detail: "" },
      spendUsd: { value: 0.77, detail: "" },
    },
    safety: {
      responsesRedacted: { value: 0, detail: "" },
      responsesFlagged: { value: 0, detail: "" },
      inspectorProven: true,
    },
  };

  it("shows what the product costs and what it checked", async () => {
    respond({ ...base, capability });
    render(<PilotPage />);

    expect(await screen.findByTestId("pilot-cap-deterministic")).toHaveTextContent("98%");
    expect(await screen.findByTestId("pilot-cap-spend")).toHaveTextContent("$0.77");
    expect(await screen.findByTestId("pilot-cap-cheap")).toHaveTextContent("87%");
    expect(await screen.findByTestId("pilot-cap-gate")).toHaveTextContent("3,675");
  });

  /* A ZERO IS ONLY GOOD NEWS IF THE CHECK RUNS. Reporting "nothing needed
     redacting" from an inspector that never fired is the same lie as an empty
     library reading as a quiet one, and this product has shipped that mistake
     before: a degrade signal that could not fire read as a healthy system for
     the life of the product. */
  it("will not present an unproven zero as a clean bill of health", async () => {
    respond({
      ...base,
      capability: {
        ...capability,
        safety: { ...capability.safety, inspectorProven: false },
      },
    });
    render(<PilotPage />);

    const section = await screen.findByTestId("pilot-capability");
    expect(section).toHaveTextContent(/cannot currently evidence it firing/i);
    expect(section).not.toHaveTextContent(/0 answers had something removed/i);
  });

  /* A figure that could not be measured reads as n/a, never as zero. */
  it("renders an unmeasurable figure as n/a rather than zero", async () => {
    respond({
      ...base,
      capability: {
        ...capability,
        efficiency: { ...capability.efficiency, spendUsd: { value: null, detail: "" } },
      },
    });
    render(<PilotPage />);

    expect(await screen.findByTestId("pilot-cap-spend")).toHaveTextContent("n/a");
  });

  /* Ported from the admin page when this panel moved: a zero that IS real
     must still be shown. Hiding a genuine zero is as dishonest as inventing
     one, and "nothing needed removing" is a fact worth stating. */
  it("shows a real zero rather than hiding it", async () => {
    respond({ ...base, capability });
    render(<PilotPage />);

    const section = await screen.findByTestId("pilot-capability");
    expect(section).toHaveTextContent(/0 answers had something removed/i);
  });

  /* Also ported: a failed read says so. undefined is an older deployment and
     renders nothing; null is a read that failed and must not be silently
     omitted, which would hide exactly what this page promises to surface. */
  it("says the figures could not be read rather than omitting them", async () => {
    respond({ ...base, capability: null });
    render(<PilotPage />);

    expect(await screen.findByTestId("pilot-capability-unreadable")).toBeInTheDocument();
    expect(screen.queryByTestId("pilot-cap-spend")).not.toBeInTheDocument();
  });

  /* An older deployment without the figures must not render an empty panel. */
  it("renders nothing when the API does not carry capability", async () => {
    respond({ ...base });
    render(<PilotPage />);

    await screen.findByTestId("pilot-passages");
    expect(screen.queryByTestId("pilot-capability")).not.toBeInTheDocument();
  });
});
/**
 * THE COST COMPARISON.
 *
 * "We spent 77 cents" means nothing alone. It means something beside what the
 * identical traffic costs at a premium vendor's list price, which is what a
 * product routing everything to one large model actually pays.
 */
describe("what the same work costs elsewhere", () => {
  const tokenUsage = {
    calls: 905,
    inputTokens: 852969,
    outputTokens: 124050,
    actualUsd: 0.7714,
  };

  it("shows what we paid alongside what the alternatives would have cost", async () => {
    respond({ ...base, tokenUsage });
    render(<PilotPage />);

    const section = await screen.findByTestId("pilot-cost-comparison");
    expect(section).toHaveTextContent("$0.77");
    expect(section).toHaveTextContent("Claude Opus");
    expect(section).toHaveTextContent("$22.10");
    expect(section).toHaveTextContent("GPT-4o");
  });

  /* "across 905model calls" appeared on the live page: the number and the word
     after it ran together because the interpolation ended a JSX line and the
     text resumed on the next, where a whitespace gap containing a newline is
     stripped. Same class as the bold-lead join, in a different section. */
  it("never runs a number into the word after it", async () => {
    respond({ ...base, tokenUsage });
    render(<PilotPage />);

    const section = await screen.findByTestId("pilot-cost-comparison");
    const text = section.textContent ?? "";
    expect(text).not.toMatch(/\d(?:model|calls|tokens|out|in)\b/i);
    expect(text).toMatch(/905\s+model calls/i);
  });

  it("shows the traffic the comparison is based on", async () => {
    respond({ ...base, tokenUsage });
    render(<PilotPage />);

    const section = await screen.findByTestId("pilot-cost-comparison");
    expect(section).toHaveTextContent("852,969");
    expect(section).toHaveTextContent("124,050");
  });

  /* THE ASSUMPTION HAS TO BE ON THE PAGE, not just in the code comment. Holding
     the token count fixed and changing only the price is the only comparison
     our own data supports, and presenting it as a forecast of another
     product's bill would be a guess about their behaviour. */
  it("states its own assumption and dates its prices", async () => {
    respond({ ...base, tokenUsage });
    render(<PilotPage />);

    const section = await screen.findByTestId("pilot-cost-comparison");
    /* Asserts the CLAIM, not the sentence. Written first as "holds the token
       count fixed", which broke when the copy was reworded to "holds that
       token count fixed" - a test pinning exact wording pins the wording, and
       this repo has already been bitten by one that pinned a wrong product
       name into place for four months. */
    expect(section).toHaveTextContent(/holds\s+\w*\s*token count fixed/i);
    expect(section).toHaveTextContent(/list prices recorded/i);
    /* AND IT CREDITS THE BIGGER SAVINGS, WHICH ARE NOT ON THE TABLE.
       This asserted the exact phrase "without a model in the first place",
       which broke when the copy was corrected: saying only that most questions
       skip a model credited the routing and said nothing about the answers
       that DID need one being kept rather than bought again. That reuse is
       what makes the saving compound. The assertion now covers both claims by
       meaning rather than by wording. */
    expect(section).toHaveTextContent(/straight from connected systems/i);
    expect(section).toHaveTextContent(/kept rather than bought again/i);
  });

  /* No usage is not a finding about pricing. A table of zeros would read as
     "every model is free". */
  it("renders nothing when there is no usage to compare", async () => {
    respond({ ...base, tokenUsage: { calls: 0, inputTokens: 0, outputTokens: 0, actualUsd: 0 } });
    render(<PilotPage />);

    await screen.findByTestId("pilot-passages");
    expect(screen.queryByTestId("pilot-cost-comparison")).not.toBeInTheDocument();
  });

  it("renders nothing when the token log could not be read", async () => {
    respond({ ...base, tokenUsage: null });
    render(<PilotPage />);

    await screen.findByTestId("pilot-passages");
    expect(screen.queryByTestId("pilot-cost-comparison")).not.toBeInTheDocument();
  });
});


/**
 * The page counted our own testing as the client's usage.
 *
 * Measured over thirty days on 2026-08-31: eleven per cent of the tool
 * answers and twenty-nine per cent of the model answers came from eval
 * harnesses, transcript probes and demo accounts. The headline share of
 * answers served without a model read 67.9 per cent where the truth for
 * people was 72.7.
 */
/**
 * The page counted our own testing as the client's usage.
 *
 * Measured over thirty days on 2026-08-31: eleven per cent of the tool
 * answers and twenty-nine per cent of the model answers came from eval
 * harnesses, transcript probes and demo accounts. The headline share of
 * answers served without a model read 67.9 per cent where the truth for
 * people was 72.7. It understated us, which is the luckier direction and not
 * a reason to leave it.
 */
it("names what was excluded as testing rather than quietly shrinking", async () => {
  respond({ ...base, excludedAsTesting: 686 });
  render(<PilotPage />);
  const note = await screen.findByTestId("pilot-excluded-testing");
  expect(note).toHaveTextContent("686");
  expect(note).toHaveTextContent(/testing and tooling rather than from a person/i);
});

/* A deployment with no testing traffic must not carry a sentence about it. */
it("says nothing about testing when there was none", async () => {
  respond({ ...base, excludedAsTesting: 0 });
  render(<PilotPage />);
  await screen.findByTestId("pilot-answers");
  expect(screen.queryByTestId("pilot-excluded-testing")).toBeNull();
});

/**
 * What the gate stops, asked for rather than assumed.
 *
 * Run over our own corpus: 623 of 5,006 passages carry something removed
 * before it reaches a model, and 59 documents hold a value that never reaches
 * a provider at all. The panel is the client-facing half of that, and the
 * thing it must never do is show what it found.
 */
describe("the corpus exposure panel", () => {
  const exposure = {
    chunksScanned: 5006,
    chunksWithSomething: 623,
    byKind: [{ kind: "credit_card", occurrences: 60, neverSend: true }],
    documentsWithSomething: 214,
    documentsWithNeverSend: 59,
    documents: [
      {
        documentId: "d1",
        filename: "UPS Invoice 941.14.PDF",
        kinds: [{ kind: "credit_card", occurrences: 2, neverSend: true }],
        holdsNeverSend: true,
      },
    ],
    truncated: false,
    durationMs: 1200,
  };

  /* ON DEMAND. Scanning every passage because somebody opened a tab would make
     the page slow and would run a full scan on a whim. */
  it("does not scan until asked", async () => {
    respond({ ...base });
    render(<PilotPage />);
    await screen.findByTestId("pilot-exposure-run");
    expect(screen.queryByTestId("pilot-exposure-result")).toBeNull();
  });

  it("shows what was found when asked", async () => {
    respond({ ...base });
    render(<PilotPage />);
    const button = await screen.findByTestId("pilot-exposure-run");

    mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => exposure });
    button.click();

    const result = await screen.findByTestId("pilot-exposure-result");
    expect(result).toHaveTextContent("623");
    expect(result).toHaveTextContent("59");
    expect(result).toHaveTextContent("UPS Invoice 941.14.PDF");
    expect(result).toHaveTextContent("credit_card");
  });

  /* THE ONE RULE THIS PANEL EXISTS UNDER. A list naming which document holds a
     card number is a work queue. The same list with the number beside it is a
     copy of the exposure, in a page easier to read than the original. */
  it("never renders a value it found", async () => {
    respond({ ...base });
    render(<PilotPage />);
    const button = await screen.findByTestId("pilot-exposure-run");
    mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => exposure });
    button.click();

    const result = await screen.findByTestId("pilot-exposure-result");
    expect(result.textContent ?? "").not.toMatch(/\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/);
  });

  /* A button that does nothing and reports nothing is indistinguishable from a
     corpus with nothing in it, which is the opposite finding. */
  it("says the scan failed rather than showing an empty result", async () => {
    respond({ ...base });
    render(<PilotPage />);
    const button = await screen.findByTestId("pilot-exposure-run");
    mockFetchWithRefresh.mockResolvedValue({ ok: false, status: 500 });
    button.click();

    const failed = await screen.findByTestId("pilot-exposure-failed");
    expect(failed).toHaveTextContent(/not the same as finding nothing/i);
  });

  /* It proves the boundary, not that anybody did anything wrong. */
  it("does not read as an accusation", async () => {
    respond({ ...base });
    render(<PilotPage />);
    const button = await screen.findByTestId("pilot-exposure-run");
    mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => exposure });
    button.click();

    const result = await screen.findByTestId("pilot-exposure-result");
    expect(result).toHaveTextContent(/not that anybody did anything wrong/i);
  });
});

/**
 * The capability has to be findable and the button has to look pressable.
 *
 * It shipped inside another panel, styled with a class that did not exist, so
 * it rendered as plain text between two paragraphs and read as a heading.
 * A feature nobody can see is worse than no feature: the page appears to
 * claim something it does not offer.
 */
describe("the exposure scan is discoverable", () => {
  it("has a heading of its own rather than trailing another panel", async () => {
    respond({ ...base });
    render(<PilotPage />);
    /* By role, because the button's own label contains the same words and a
       text match finds both. */
    expect(
      await screen.findByRole("heading", { name: /What never reaches a model/i }),
    ).toBeInTheDocument();
  });

  /* A person has to know what pressing it will do before they press it. */
  it("says what the scan does before it is run", async () => {
    respond({ ...base });
    render(<PilotPage />);
    await screen.findByTestId("pilot-exposure-run");
    expect(screen.getByText(/read every indexed passage/i)).toBeInTheDocument();
  });

  /* An element that is not a button cannot be reached by keyboard, and a div
     with an onClick is the usual way that happens. */
  it("is a real button", async () => {
    respond({ ...base });
    render(<PilotPage />);
    const el = await screen.findByTestId("pilot-exposure-run");
    expect(el.tagName).toBe("BUTTON");
    expect(el).toHaveClass("wp-pilot-button");
  });
});

/**
 * A hundred results must not push the page down.
 *
 * The scan returns up to a hundred documents and the first version rendered
 * all of them inline, so pressing the button buried every section below it
 * under a wall somebody had to scroll past to get anywhere.
 */
describe("the exposure list stays in its own box", () => {
  const manyDocuments = Array.from({ length: 100 }, (_, i) => ({
    documentId: `d${i}`,
    filename: `Invoice ${i}.pdf`,
    kinds: [{ kind: "credit_card", occurrences: 1, neverSend: true }],
    holdsNeverSend: true,
  }));

  const exposure = {
    chunksScanned: 5006,
    chunksWithSomething: 623,
    byKind: [{ kind: "credit_card", occurrences: 60, neverSend: true }],
    documentsWithSomething: 214,
    documentsWithNeverSend: 59,
    documents: manyDocuments,
    truncated: true,
    durationMs: 1200,
  };

  async function runScan() {
    respond({ ...base });
    render(<PilotPage />);
    const button = await screen.findByTestId("pilot-exposure-run");
    mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => exposure });
    button.click();
    return screen.findByTestId("pilot-exposure-result");
  }

  it("puts the results in a scrolling region rather than inline", async () => {
    await runScan();
    expect(await screen.findByTestId("pilot-exposure-scroll")).toHaveClass("wp-pilot-scroll");
  });

  /* Scrolls rather than truncates: the point of the panel is finding the
     document you care about, and a "show more" hiding ninety of them makes
     that worse. */
  it("still renders every document it was given", async () => {
    const result = await runScan();
    expect(result).toHaveTextContent("Invoice 0.pdf");
    expect(result).toHaveTextContent("Invoice 99.pdf");
  });

  /* Somebody has to know there is more below the fold of a box. */
  it("says how many are listed and that the box scrolls", async () => {
    const result = await runScan();
    expect(result).toHaveTextContent(/100 document\(s\) listed above/i);
    expect(result).toHaveTextContent(/Scroll the box/i);
  });
});

/**
 * What people asked and did not get.
 *
 * A build backlog written by the people using it rather than guessed at in a
 * planning meeting, and the one panel here that says what to do next rather
 * than what happened.
 */
describe("the gaps panel", () => {
  const gaps = {
    wouldConnect: [{ question: "how many cayennes are on the lot", asked: 9, system: "dealer-system" }],
    missing: [{ question: "what is our refund policy", asked: 5, system: "documents" }],
    closed: [{ question: "what are the payment terms in our sow?", asked: 18 }],
    wanted: { actions: [{ action: "schedule a meeting", asked: 3 }], other: 2 },
    statements: 4,
    readable: true,
  };

  /* THE SPLIT THE PANEL EXISTS FOR. One is a decision somebody makes in an
     afternoon, the other is somebody writing a document. A single list of
     failures mixes a sales conversation with a content backlog. */
  it("keeps connect-this apart from write-this", async () => {
    respond({ ...base, gaps });
    render(<PilotPage />);
    const connect = await screen.findByTestId("pilot-gaps-connect");
    expect(connect).toHaveTextContent("how many cayennes are on the lot");
    expect(connect).toHaveTextContent("dealer-system");

    const missing = screen.getByTestId("pilot-gaps-missing");
    expect(missing).toHaveTextContent("what is our refund policy");
    expect(missing).not.toHaveTextContent("cayennes");
  });

  /* Unmet demand for an ACTION is invisible everywhere else: nobody files a
     request for something they assumed would work. */
  it("shows what somebody expected the product to do", async () => {
    respond({ ...base, gaps });
    render(<PilotPage />);
    const wanted = await screen.findByTestId("pilot-gaps-wanted");
    expect(wanted).toHaveTextContent("schedule a meeting");
    /* Requests whose verb is not on the list are counted. Dropping them
       silently would read as nobody having wanted anything. */
    expect(screen.getByTestId("pilot-gaps-wanted-other")).toHaveTextContent(/2 further requests/i);
  });

  /* NO INSTRUCTION IS QUOTED, EVER. The measured reason: "book me 30 minutes
     with dana tomorrow" was on the live page, and neither that colleague nor
     the client named in the next entry appears in any table this workspace
     holds, so no mask could have reached them. */
  it("never renders the words of an instruction", async () => {
    respond({ ...base, gaps });
    render(<PilotPage />);
    const wanted = await screen.findByTestId("pilot-gaps-wanted");
    expect(wanted).not.toHaveTextContent(/dana|30 minutes|tomorrow/i);
  });

  /* A shortened question and a short one look identical, and a reader who
     cannot tell them apart reads a truncation as the whole question. */
  it("marks a line that is not what somebody typed", async () => {
    respond({
      ...base,
      gaps: {
        ...gaps,
        wouldConnect: [
          { question: "a person's name", asked: 15, system: "directory", withheld: "name" },
        ],
        closed: [{ question: "analyze the survey data in the workbook and…", asked: 1, withheld: "paste" }],
      },
    });
    render(<PilotPage />);
    expect(await screen.findByTestId("pilot-gaps-connect")).toHaveTextContent("name withheld");
    expect(screen.getByTestId("pilot-gaps-closed")).toHaveTextContent("shortened");
  });

  /* An exclusion nobody can see is indistinguishable from nobody having
     asked, which is the failure this whole page is built around. */
  it("reports how many entries were left out as remarks", async () => {
    respond({ ...base, gaps });
    render(<PilotPage />);
    expect(await screen.findByTestId("pilot-gaps-statements")).toHaveTextContent(
      /4 further entries were left out as remarks/i,
    );
  });

  /* The best evidence there is that uploading changed something. */
  it("shows gaps that have since closed", async () => {
    respond({ ...base, gaps });
    render(<PilotPage />);
    expect(await screen.findByTestId("pilot-gaps-closed")).toHaveTextContent(
      "what are the payment terms in our sow?",
    );
  });

  /* AN UNREADABLE LOG AND A CLIENT WITH NO GAPS ARE THE SAME EMPTY LIST AND
     OPPOSITE FACTS. */
  it("says the figures could not be read rather than showing nothing", async () => {
    respond({ ...base, gaps: { ...gaps, readable: false } });
    render(<PilotPage />);
    expect(await screen.findByTestId("pilot-gaps-unreadable")).toHaveTextContent(
      /not the same as nothing having gone unanswered/i,
    );
    expect(screen.queryByTestId("pilot-gaps-connect")).toBeNull();
  });

  it("says so plainly when everything was answered", async () => {
    respond({
      ...base,
      gaps: {
        wouldConnect: [],
        missing: [],
        closed: [],
        wanted: { actions: [], other: 0 },
        statements: 0,
        readable: true,
      },
    });
    render(<PilotPage />);
    expect(await screen.findByTestId("pilot-gaps-none")).toHaveTextContent(
      /Every question asked in this window was answered/i,
    );
  });
});
