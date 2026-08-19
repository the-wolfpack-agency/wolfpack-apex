/**
 * @jest-environment jsdom
 *
 * The explanation of how a question reaches a model.
 *
 * Asked for on 2026-08-19: show the flow of a prompt through the router in a
 * way a non-technical person can follow. The page reported "decisions",
 * "tiers" and "fallbacks" to a reader with no way of knowing what a decision
 * was.
 *
 * The assertion that matters is the second one. Most questions never reach a
 * model at all, and a diagram that implied they did would be tidier and would
 * misrepresent the product to the person most likely to repeat it in a meeting.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import RouterFlow from "@/components/admin/RouterFlow";

describe("RouterFlow", () => {
  test("walks the whole path, from the question to the answer", () => {
    render(<RouterFlow />);
    expect(screen.getByTestId("router-flow")).toBeInTheDocument();
    for (const step of [
      "You ask",
      "Answer it without a model?",
      "How much model does this need?",
      "The router picks",
      "The model answers",
    ]) {
      expect(screen.getByText(step)).toBeInTheDocument();
    }
  });

  test("SAYS THAT MOST QUESTIONS NEVER REACH A MODEL", () => {
    render(<RouterFlow />);
    expect(screen.getByText(/Most questions stop here: no model, no cost/i)).toBeInTheDocument();
  });

  test("explains the choice in terms of cost, not of model names", () => {
    render(<RouterFlow />);
    expect(screen.getByText(/cheapest one that meets that tier/i)).toBeInTheDocument();
    expect(
      screen.getByText(/recorded from the provider's own numbers, not estimated/i),
    ).toBeInTheDocument();
  });

  test("a screen reader gets the flow in words, not a shrug", () => {
    render(<RouterFlow />);
    const label = screen.getByTestId("router-flow").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/most questions stop there at no cost/i);
    expect(label.length).toBeGreaterThan(200);
  });
});
