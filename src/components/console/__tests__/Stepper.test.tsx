/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { Stepper } from "@/components/console/Stepper";

const STEPS = [
  { key: "ci", label: "CI checks", status: "passed" as const, detail: "ok" },
  { key: "merge", label: "Merge", status: "failed" as const, detail: "conflict", url: "https://x" },
  { key: "build", label: "Build", status: "running" as const },
  { key: "verify", label: "Verify", status: "skipped" as const },
];

it("renders a labeled, status-tagged node per step", () => {
  render(<Stepper steps={STEPS} testId="s" />);
  expect(screen.getByTestId("s")).toBeInTheDocument();
  expect(screen.getByTestId("s-label-ci")).toHaveTextContent("CI checks");
  expect(screen.getByTestId("s-step-ci")).toHaveAttribute("data-status", "passed");
  expect(screen.getByTestId("s-step-merge")).toHaveAttribute("data-status", "failed");
  expect(screen.getByTestId("s-step-build")).toHaveAttribute("data-status", "running");
  expect(screen.getByTestId("s-step-verify")).toHaveAttribute("data-status", "skipped");
});

it("wraps a step with a url in a click-through link", () => {
  render(<Stepper steps={STEPS} testId="s" />);
  const link = screen.getByTestId("s-step-merge").querySelector("a");
  expect(link).toHaveAttribute("href", "https://x");
});

it("renders one fewer connector than steps", () => {
  render(<Stepper steps={STEPS} testId="s" />);
  expect(screen.getByTestId("s-connector-0")).toBeInTheDocument();
  expect(screen.getByTestId("s-connector-2")).toBeInTheDocument();
  // No trailing connector after the last step.
  expect(screen.queryByTestId(`s-connector-${STEPS.length - 1}`)).not.toBeInTheDocument();
});
