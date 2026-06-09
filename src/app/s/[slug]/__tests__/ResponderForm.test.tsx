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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import ResponderForm from "../ResponderForm";
import type { SurveySchema } from "@/lib/surveys/types";

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
