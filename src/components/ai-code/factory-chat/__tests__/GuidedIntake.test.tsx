/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import GuidedIntake from "@/components/ai-code/factory-chat/GuidedIntake";

beforeEach(() => jest.clearAllMocks());

it("leads the user: pick a goal -> answer -> preview -> start emits a well-formed request", () => {
  const onSubmit = jest.fn();
  render(<GuidedIntake onSubmit={onSubmit} />);
  // goal selection is the default (no blank box)
  expect(screen.getByTestId("intake-goals")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("goal-feature"));
  // required 'what' not answered yet -> Start disabled
  expect(screen.getByTestId("intake-start")).toBeDisabled();
  fireEvent.change(screen.getByTestId("input-what"), { target: { value: "list a customer's invoices" } });
  // defaults are pre-filled (auth=yes, tests=yes) and shown in the preview
  expect(screen.getByTestId("intake-preview")).toHaveTextContent(/Require authentication/);
  expect(screen.getByTestId("intake-preview")).toHaveTextContent(/Include tests/);
  // start -> composed request
  expect(screen.getByTestId("intake-start")).toBeEnabled();
  fireEvent.click(screen.getByTestId("intake-start"));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0][0]).toMatch(/Add a new feature: list a customer's invoices/);
});

it("choosing 'No' on auth flips the composed request to public", () => {
  const onSubmit = jest.fn();
  render(<GuidedIntake onSubmit={onSubmit} />);
  fireEvent.click(screen.getByTestId("goal-feature"));
  fireEvent.change(screen.getByTestId("input-what"), { target: { value: "a status page" } });
  fireEvent.click(screen.getByTestId("opt-auth-no"));
  expect(screen.getByTestId("intake-preview")).toHaveTextContent(/can be public/);
});

it("offers an escape hatch to freeform", () => {
  const onFreeform = jest.fn();
  render(<GuidedIntake onSubmit={jest.fn()} onFreeform={onFreeform} />);
  fireEvent.click(screen.getByTestId("freeform"));
  expect(onFreeform).toHaveBeenCalled();
});

it("'change' returns to goal selection", () => {
  render(<GuidedIntake onSubmit={jest.fn()} />);
  fireEvent.click(screen.getByTestId("goal-fix"));
  expect(screen.getByTestId("intake-steps")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("intake-back"));
  expect(screen.getByTestId("intake-goals")).toBeInTheDocument();
});
