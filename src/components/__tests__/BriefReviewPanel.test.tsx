/**
 * @jest-environment jsdom
 */

/**
 * The panel's job is to hand back questions, not a verdict. These tests hold
 * the two things that would make it worse than nothing: a grade, and a result
 * that cannot come back clean.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import BriefReviewPanel from "../BriefReviewPanel";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

const respond = (body: unknown, ok = true, status = 200) =>
  mockFetch.mockResolvedValue({ ok, status, json: async () => body });

const DIRTY = {
  findings: [
    {
      dimension: "environment",
      missing: "where it has to work",
      ask: "Does this have to work on the deployed URL, or is local enough? Which URL?",
      cost: "Local green and production green are different claims.",
    },
  ],
  suggested: "Make it better\n\n- Does this have to work on the deployed URL?",
  headline: "1 thing the work will have to guess at: where it has to work.",
};

const CLEAN = { findings: [], suggested: "x", headline: "This brief carries everything the work needs. Nothing to add." };

beforeEach(() => jest.clearAllMocks());

it("will not review an empty brief", () => {
  render(<BriefReviewPanel />);
  expect(screen.getByTestId("brief-review-run")).toBeDisabled();
});

it("asks the question rather than grading the writing", async () => {
  respond(DIRTY);
  render(<BriefReviewPanel />);
  fireEvent.change(screen.getByTestId("brief-input"), { target: { value: "Make it better" } });
  fireEvent.click(screen.getByTestId("brief-review-run"));

  const result = await screen.findByTestId("brief-review-result");
  expect(result).toHaveTextContent(/Does this have to work on the deployed URL/);
  // No score, no grade, no percentage: a number invites optimizing the number.
  expect(result.textContent ?? "").not.toMatch(/\b\d+\s*(%|\/\s*\d+|out of)\b/);
  expect(result.textContent ?? "").not.toMatch(/\b(score|grade|rating)\b/i);
});

it("can come back with nothing to say", async () => {
  respond(CLEAN);
  render(<BriefReviewPanel />);
  fireEvent.change(screen.getByTestId("brief-input"), { target: { value: "A complete brief" } });
  fireEvent.click(screen.getByTestId("brief-review-run"));
  expect(await screen.findByTestId("brief-review-headline")).toHaveTextContent(/nothing to add/i);
});

it("says out loud that the brief is not stored, next to the box", () => {
  // Nobody pastes a real brief into a box that might be logging it.
  render(<BriefReviewPanel />);
  expect(screen.getByText(/never stored/i)).toBeInTheDocument();
});

it("surfaces a failure instead of leaving the button spinning", async () => {
  respond({}, false, 500);
  render(<BriefReviewPanel />);
  fireEvent.change(screen.getByTestId("brief-input"), { target: { value: "x" } });
  fireEvent.click(screen.getByTestId("brief-review-run"));
  expect(await screen.findByTestId("brief-review-error")).toHaveTextContent(/HTTP 500/);
});
