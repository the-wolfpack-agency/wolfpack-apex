/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PipelineRow } from "@/components/deploy/PipelineRow";
import type { DeploymentPipeline } from "@/lib/deploy/pipeline";

function pipeline(over: Partial<DeploymentPipeline> = {}): DeploymentPipeline {
  return {
    id: "sha1",
    title: "Ship the thing",
    url: "https://gh/pr/1",
    author: "nick",
    commitSha: "sha1",
    prNumber: 42,
    ageHours: 2,
    hasMigration: false,
    live: false,
    status: "in_progress",
    currentStage: "build",
    stages: [
      { key: "ci", label: "CI checks", status: "passed", detail: "ok" },
      { key: "merge", label: "Merge", status: "passed", detail: "merged" },
      { key: "build", label: "Build + migrate", status: "running", detail: "Building" },
      { key: "promote", label: "Promote", status: "pending", detail: "wait" },
      { key: "verify", label: "Prod verify", status: "pending", detail: "wait" },
      { key: "health", label: "Health", status: "pending", detail: "wait" },
    ],
    ...over,
  };
}

it("renders the title, PR number, status and the current-stage line", () => {
  render(<PipelineRow pipeline={pipeline()} testId="row" />);
  expect(screen.getByTestId("row")).toHaveAttribute("data-status", "in_progress");
  expect(screen.getByTestId("row")).toHaveTextContent("#42 Ship the thing");
  expect(screen.getByTestId("row-status")).toHaveTextContent("In progress");
  // current stage is build -> its detail is surfaced
  expect(screen.getByTestId("row-current")).toHaveTextContent("Build + migrate: Building");
  // the stepper rendered all six stages
  expect(screen.getByTestId("row-stepper-step-health")).toBeInTheDocument();
});

it("shows the LIVE badge only when live", () => {
  const { rerender } = render(<PipelineRow pipeline={pipeline({ live: false })} testId="row" />);
  expect(screen.queryByTestId("row-live")).not.toBeInTheDocument();
  rerender(<PipelineRow pipeline={pipeline({ live: true })} testId="row" />);
  expect(screen.getByTestId("row-live")).toHaveTextContent("LIVE");
});

it("shows the MIGRATION badge when the change carries a migration", () => {
  render(<PipelineRow pipeline={pipeline({ hasMigration: true })} testId="row" />);
  expect(screen.getByTestId("row-migration")).toHaveTextContent("MIGRATION");
});
