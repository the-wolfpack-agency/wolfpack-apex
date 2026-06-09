/**
 * @jest-environment jsdom
 */
/**
 * UI / near-E2E tests for the public survey ResponderForm.
 *
 * Apex has no Playwright harness, so this RTL flow is the closest thing
 * to end-to-end coverage: it renders the real client component against a
 * 3-question schema and exercises the full render → fill → submit →
 * error/success path with a mocked global fetch (the only boundary).
 *
 * Covered branches:
 *   - required-field validation blocks submit (no fetch fired)
 *   - filling + submit POSTs the assembled answers to /api/s/<slug>
 *   - a 400 response surfaces survey-error and KEEPS the form
 *   - a 200 response shows survey-submitted (form removed)
 *   - a 429 response surfaces a "too many" message
 */

import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import ResponderForm from "../ResponderForm";
import type { SurveySchema } from "@/lib/surveys/types";
import { OTHER_VALUE_PREFIX } from "@/lib/surveys/types";
import {
  weekendWithPorscheSchema,
  Q1_YES,
} from "@/lib/surveys/__fixtures__/weekend-with-porsche";

const SCHEMA: SurveySchema = {
  questions: [
    { id: "name", type: "short_text", label: "Your name", required: true },
    {
      id: "plan",
      type: "single_choice",
      label: "Pick a plan",
      required: false,
      options: ["Basic", "Pro"],
    },
    { id: "score", type: "rating", label: "Rate us", required: false, max: 5 },
  ],
};

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn() as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function renderForm() {
  return render(
    <ResponderForm
      slug="abc1234"
      title="Test survey"
      description="Tell us how we did"
      schema={SCHEMA}
    />,
  );
}

test("renders the form with one block per question", () => {
  renderForm();
  expect(screen.getByTestId("survey-responder")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-name")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-plan")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-score")).toBeInTheDocument();
});

test("required validation blocks submit and fires no fetch", async () => {
  renderForm();
  fireEvent.click(screen.getByTestId("survey-submit"));
  await waitFor(() => {
    expect(screen.getByTestId("survey-error")).toBeInTheDocument();
  });
  expect(screen.getByTestId("survey-error")).toHaveTextContent(/required/i);
  expect(global.fetch).not.toHaveBeenCalled();
  // Form is still present.
  expect(screen.getByTestId("survey-responder")).toBeInTheDocument();
});

test("filling + submit POSTs the assembled answers", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(200, { ok: true, id: "resp-1" }),
  );
  renderForm();

  fireEvent.change(screen.getByTestId("survey-input-name"), {
    target: { value: "Nick" },
  });
  fireEvent.click(screen.getByTestId("survey-radio-plan-Pro"));
  fireEvent.click(screen.getByTestId("survey-rating-score-4"));
  fireEvent.click(screen.getByTestId("survey-submit"));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe("/api/s/abc1234");
  expect(opts.method).toBe("POST");
  expect(JSON.parse(opts.body)).toEqual({
    answers: { name: "Nick", plan: "Pro", score: 4 },
  });
});

test("a 200 response shows the success state", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(200, { ok: true, id: "resp-1" }),
  );
  renderForm();
  fireEvent.change(screen.getByTestId("survey-input-name"), {
    target: { value: "Nick" },
  });
  fireEvent.click(screen.getByTestId("survey-submit"));

  await waitFor(() => {
    expect(screen.getByTestId("survey-submitted")).toBeInTheDocument();
  });
  // Form is gone.
  expect(screen.queryByTestId("survey-responder")).not.toBeInTheDocument();
});

test("a 400 response surfaces survey-error and keeps the form", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(400, { error: '"Your name": this question is required' }),
  );
  renderForm();
  fireEvent.change(screen.getByTestId("survey-input-name"), {
    target: { value: "Nick" },
  });
  fireEvent.click(screen.getByTestId("survey-submit"));

  await waitFor(() => {
    expect(screen.getByTestId("survey-error")).toBeInTheDocument();
  });
  expect(screen.getByTestId("survey-error")).toHaveTextContent(
    /this question is required/i,
  );
  // Form is STILL present so the respondent can fix + resubmit.
  expect(screen.getByTestId("survey-responder")).toBeInTheDocument();
  expect(screen.queryByTestId("survey-submitted")).not.toBeInTheDocument();
});

test("a 429 response surfaces a too-many-submissions message", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(429, { error: "rate_limited" }),
  );
  renderForm();
  fireEvent.change(screen.getByTestId("survey-input-name"), {
    target: { value: "Nick" },
  });
  fireEvent.click(screen.getByTestId("survey-submit"));

  await waitFor(() => {
    expect(screen.getByTestId("survey-error")).toBeInTheDocument();
  });
  expect(screen.getByTestId("survey-error")).toHaveTextContent(/too many/i);
  expect(screen.getByTestId("survey-responder")).toBeInTheDocument();
});

/* ------------------------------------------------------------------ */
/* "A Weekend with Porsche" — full reference-schema near-E2E flow.     */
/*                                                                     */
/* Apex has no Playwright, so this drives the real render →            */
/* conditional-reveal → Other → maxSelections → submit path against    */
/* the production fixture schema. Closest thing to E2E we have.        */
/* ------------------------------------------------------------------ */

function renderPorsche() {
  return render(
    <ResponderForm
      slug="porsche1"
      title="A Weekend with Porsche"
      description="Help shape the pilot."
      schema={weekendWithPorscheSchema}
    />,
  );
}

/** Fill the conditional contact block (only valid after Q1 = Yes). */
function fillContactBlock() {
  fireEvent.change(screen.getByTestId("survey-input-c_first"), {
    target: { value: "Nick" },
  });
  fireEvent.change(screen.getByTestId("survey-input-c_last"), {
    target: { value: "Homyk" },
  });
  fireEvent.change(screen.getByTestId("survey-input-c_center"), {
    target: { value: "Porsche Albany" },
  });
  fireEvent.change(screen.getByTestId("survey-input-c_email"), {
    target: { value: "nick@thewolfpack.agency" },
  });
}

test("sections render as headings (no input) and helpText shows as a sub-prompt", () => {
  renderPorsche();

  // Section content blocks render as headings, not fields.
  expect(screen.getByTestId("survey-q-intro")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-sec_dealer")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", {
      name: /help shape the future of the cayenne experience/i,
    }),
  ).toBeInTheDocument();
  // The intro body paragraph renders.
  expect(
    screen.getByText(/we're inviting a select group of porsche centers/i),
  ).toBeInTheDocument();
  // A section block carries no input.
  expect(
    within(screen.getByTestId("survey-q-intro")).queryByRole("textbox"),
  ).not.toBeInTheDocument();

  // helpText renders as a sub-prompt under the question label.
  expect(screen.getByTestId("survey-help-q2_eliminate")).toHaveTextContent(
    /select one/i,
  );
  expect(screen.getByTestId("survey-help-q3_resources")).toHaveTextContent(
    /select up to three/i,
  );
});

test("contact block is hidden until Q1 = Yes, then appears (incl. the email field)", () => {
  renderPorsche();

  // Hidden initially — visibleIf not satisfied.
  expect(screen.queryByTestId("survey-q-c_first")).not.toBeInTheDocument();
  expect(screen.queryByTestId("survey-q-c_email")).not.toBeInTheDocument();
  expect(screen.queryByTestId("survey-input-c_email")).not.toBeInTheDocument();

  // Selecting Yes reveals the whole contact block.
  fireEvent.click(screen.getByTestId(`survey-radio-q1_interest-${Q1_YES}`));

  expect(screen.getByTestId("survey-q-c_first")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-c_last")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-c_center")).toBeInTheDocument();
  expect(screen.getByTestId("survey-q-c_email")).toBeInTheDocument();
  // The email field renders an email input.
  const email = screen.getByTestId("survey-input-c_email") as HTMLInputElement;
  expect(email).toBeInTheDocument();
  expect(email.type).toBe("email");

  // Choosing a different (non-Yes) answer hides the block again — live recompute.
  fireEvent.click(
    screen.getByTestId("survey-radio-q1_interest-Not at this time"),
  );
  expect(screen.queryByTestId("survey-q-c_first")).not.toBeInTheDocument();
  expect(screen.queryByTestId("survey-input-c_email")).not.toBeInTheDocument();
});

test('choosing "Other" on Q2 reveals a text box; submitted answer is other:<text>', async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(200, { ok: true, id: "resp-2" }),
  );
  renderPorsche();

  // Other text box hidden until "Other" is picked.
  expect(
    screen.queryByTestId("survey-other-input-q2_eliminate"),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId("survey-radio-q2_eliminate-__other__"));
  const otherBox = screen.getByTestId("survey-other-input-q2_eliminate");
  expect(otherBox).toBeInTheDocument();
  fireEvent.change(otherBox, { target: { value: "Vendor onboarding" } });

  // Fill the rest of the required path so submit goes through.
  fireEvent.click(screen.getByTestId(`survey-radio-q1_interest-${Q1_YES}`));
  fillContactBlock();
  fireEvent.click(
    screen.getByTestId("survey-checkbox-q3_resources-Customer invitation templates"),
  );
  fireEvent.click(
    screen.getByTestId("survey-radio-q5_owner-Sales Manager"),
  );

  fireEvent.click(screen.getByTestId("survey-submit"));

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
  const sent = JSON.parse(opts.body).answers;
  expect(sent.q2_eliminate).toBe(`${OTHER_VALUE_PREFIX}Vendor onboarding`);
});

test("Q3 prevents selecting a 4th option (maxSelections = 3)", () => {
  renderPorsche();

  const opts = [
    "Customer invitation templates",
    "Curated road trip guides",
    "Dealer concierge playbook",
  ];
  for (const o of opts) {
    fireEvent.click(screen.getByTestId(`survey-checkbox-q3_resources-${o}`));
  }
  // Three picked, all checked.
  for (const o of opts) {
    expect(
      screen.getByTestId(`survey-checkbox-q3_resources-${o}`),
    ).toBeChecked();
  }

  // The remaining boxes are now disabled — the cap prevents a 4th pick.
  // (A disabled control fires no onChange, so React state can't grow past 3.)
  const fourth = screen.getByTestId(
    "survey-checkbox-q3_resources-Communication templates (email/text)",
  ) as HTMLInputElement;
  expect(fourth).toBeDisabled();
  // Unchecking one re-enables the rest (cap is a live constraint).
  fireEvent.click(
    screen.getByTestId("survey-checkbox-q3_resources-Customer invitation templates"),
  );
  expect(fourth).not.toBeDisabled();

  // "select up to 3" hint is shown.
  expect(screen.getByTestId("survey-maxhint-q3_resources")).toHaveTextContent(
    /up to 3/i,
  );
});

test("a complete valid submission POSTs the right shape and shows survey-submitted", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(200, { ok: true, id: "resp-3" }),
  );
  renderPorsche();

  // Q1 = Yes reveals + fills the contact block.
  fireEvent.click(screen.getByTestId(`survey-radio-q1_interest-${Q1_YES}`));
  fillContactBlock();

  // Q2 single_choice (a real option).
  fireEvent.click(
    screen.getByTestId("survey-radio-q2_eliminate-Customer communication"),
  );

  // Q3 multiple_choice — two picks.
  fireEvent.click(
    screen.getByTestId("survey-checkbox-q3_resources-Curated road trip guides"),
  );
  fireEvent.click(
    screen.getByTestId("survey-checkbox-q3_resources-Dealer concierge playbook"),
  );

  // Q5 required single_choice.
  fireEvent.click(
    screen.getByTestId("survey-radio-q5_owner-Brand Ambassador"),
  );

  fireEvent.click(screen.getByTestId("survey-submit"));

  await waitFor(() => {
    expect(screen.getByTestId("survey-submitted")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("survey-responder")).not.toBeInTheDocument();

  const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
  expect(url).toBe("/api/s/porsche1");
  expect(opts.method).toBe("POST");
  const sent = JSON.parse(opts.body).answers;
  expect(sent).toEqual({
    q1_interest: Q1_YES,
    c_first: "Nick",
    c_last: "Homyk",
    c_center: "Porsche Albany",
    c_email: "nick@thewolfpack.agency",
    q2_eliminate: "Customer communication",
    q3_resources: ["Curated road trip guides", "Dealer concierge playbook"],
    q5_owner: "Brand Ambassador",
  });
  // No section ids, and no hidden questions, made it into the payload.
  expect(sent.intro).toBeUndefined();
  expect(sent.sec_dealer).toBeUndefined();
});

test("hidden (inactive) required questions never block submit, and a 400 surfaces survey-error", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(
    jsonResponse(400, { error: '"Email": enter a valid email address' }),
  );
  renderPorsche();

  // Pick a non-Yes answer so the required contact block stays hidden.
  fireEvent.click(
    screen.getByTestId("survey-radio-q1_interest-Not at this time"),
  );
  // Fill the other required questions.
  fireEvent.click(
    screen.getByTestId("survey-radio-q2_eliminate-Internal buy-in"),
  );
  fireEvent.click(
    screen.getByTestId("survey-checkbox-q3_resources-Luxury touchpoint ideas"),
  );
  fireEvent.click(
    screen.getByTestId("survey-radio-q5_owner-General Sales Manager"),
  );

  fireEvent.click(screen.getByTestId("survey-submit"));

  // Client check must NOT block on the hidden required contact fields —
  // the request actually fires (then we assert the server-error path).
  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.getByTestId("survey-error")).toBeInTheDocument();
  });
  expect(screen.getByTestId("survey-error")).toHaveTextContent(
    /valid email address/i,
  );
  expect(screen.getByTestId("survey-responder")).toBeInTheDocument();

  // Hidden contact fields were not sent.
  const [, opts] = (global.fetch as jest.Mock).mock.calls[0];
  const sent = JSON.parse(opts.body).answers;
  expect(sent.c_first).toBeUndefined();
  expect(sent.c_email).toBeUndefined();
});
