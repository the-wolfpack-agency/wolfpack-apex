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
