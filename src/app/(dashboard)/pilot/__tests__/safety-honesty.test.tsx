/** @jest-environment jsdom */
/**
 * The safety numbers on /pilot must not be read as more than they are.
 *
 * WHAT WAS WRONG. The page led with "Answers flagged for review: 0". Measured
 * against the production event store on 2026-08-30:
 *
 *   ai.response_flagged    0   never fired
 *   ai.response_redacted   0   never fired
 *   ai.prompt_redacted    52   2026-08-05 .. 2026-08-30, still firing
 *
 * Both zeros are honest for what they measure, which is what a MODEL sent
 * back, and for a product answering questions about documents that shape is
 * genuinely rare. But a client reading "0" beside a promise about safety
 * concludes the safety check found nothing, when a different check had been
 * catching real things for a month and nothing on the page showed it.
 *
 * The inbound control was then verified end to end through the real assistant
 * against the production database: a pasted card number, a national ID inside
 * a genuine question, bank details, and an API key. None reached the answer.
 * Bank details pasted alongside a real question had the details removed and
 * the question answered from the SOW, which is the behavior worth having.
 */

import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctUser = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: (...a: unknown[]) => mockGetInstinctUser(...a),
}));

import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import PilotPage from "@/app/(dashboard)/pilot/page";

const base = {
  readable: true,
  passages: 1200,
  libraries: 4,
  deterministicAnswers: 40,
  modelAnswers: 10,
  declined: 3,
};

/* The real situation this page has been in: a zero outbound count beside a
   non-zero inbound one. */
function capabilityWith(inbound: number | null, flagged: number) {
  return {
    windowDays: 30,
    gate: { actionsAuthorized: { value: 5, detail: "" }, checkpointsSigned: { value: 2, detail: "" } },
    efficiency: {
      deterministicSharePct: { value: 80, detail: "" },
      modelCalls: { value: 167, detail: "" },
      cheapTierPct: { value: 87, detail: "" },
      spendUsd: { value: 0.77, detail: "" },
    },
    retrieval: {
      chunksEmbeddedPct: { value: 90, detail: "" },
      answerableDocuments: { value: 100, detail: "" },
    },
    safety: {
      responsesRedacted: { value: 0, detail: "" },
      responsesFlagged: { value: flagged, detail: "" },
      sensitiveInputsRedacted:
        inbound === null
          ? { value: null, detail: "The event store could not be read." }
          : { value: inbound, detail: "" },
      inspectorProven: true,
    },
  };
}

function respond(body: Record<string, unknown>) {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => body });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetInstinctUser.mockReturnValue({ id: "u1", email: "a@b.co" });
});

async function renderWith(inbound: number | null, flagged = 0) {
  respond({ ...base, capability: capabilityWith(inbound, flagged) });
  render(<PilotPage />);
  await waitFor(() => expect(screen.getByTestId("pilot-cap-inputs-redacted")).toBeInTheDocument());
}

describe("the safety tiles say what they measure", () => {
  it("shows the control that actually fires", async () => {
    await renderWith(52);
    const tile = screen.getByTestId("pilot-cap-inputs-redacted");
    expect(tile.textContent).toMatch(/52/);
    expect(tile.textContent).toMatch(/removed from questions/i);
  });

  /* Removing data must not mean refusing to help: the measured behavior is
     that the question is still answered. */
  it("promises the question is still answered", async () => {
    await renderWith(52);
    expect(screen.getByTestId("pilot-cap-inputs-redacted").textContent).toMatch(/still answered/i);
  });

  /* A zero beside a safety promise must explain itself, or it reads as the
     safety check having found nothing. */
  it("explains the outbound zero and points at the tile that fires", async () => {
    await renderWith(52);
    const flagged = screen.getByTestId("pilot-cap-flagged");
    expect(flagged.textContent).toMatch(/what the model sends back/i);
    expect(flagged.textContent).toMatch(/tile above/i);
  });

  it("does not show a count when the event store cannot be read", async () => {
    await renderWith(null);
    expect(screen.getByTestId("pilot-cap-inputs-redacted").textContent).not.toMatch(/\b0\b/);
  });
});

describe("what happens when something breaks is stated", () => {
  it("tells a reader an outage never means their documents are gone", async () => {
    await renderWith(52);
    const block = screen.getByTestId("pilot-resilience").textContent ?? "";
    expect(block).toMatch(/nothing has been lost/i);
    expect(block).toMatch(/nothing needs re-uploading/i);
  });

  it("states that a brief failure is retried rather than surfaced", async () => {
    await renderWith(52);
    expect(screen.getByTestId("pilot-resilience").textContent).toMatch(/retried/i);
  });

  /* Every claim there is a shipped control. If one leaves the product it must
     leave this page, and this fails loudly rather than let the page keep
     promising something gone. */
  it("makes exactly the four claims the product can back", async () => {
    await renderWith(52);
    expect(screen.getByTestId("pilot-resilience").querySelectorAll("li")).toHaveLength(4);
  });
});
