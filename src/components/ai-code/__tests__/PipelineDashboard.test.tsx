/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import PipelineDashboard, { type CiDashboard } from "@/components/ai-code/PipelineDashboard";

const dash: CiDashboard = {
  overall: "fail",
  summary: { total: 4, passed: 3, failed: 1, pending: 0 },
  categories: [
    { key: "unit", label: "Unit tests", status: "pass", passed: 3, failed: 0, pending: 0, checks: ["unit (1/4)"] },
    { key: "security", label: "Security", status: "fail", passed: 0, failed: 1, pending: 0, checks: ["CodeQL"] },
    { key: "build-deploy", label: "Build & deploy", status: "pending", passed: 0, failed: 0, pending: 1, checks: ["Vercel"] },
    { key: "other", label: "Other checks", status: "absent", passed: 0, failed: 0, pending: 0, checks: [] },
  ],
};

test("renders product-agnostic checkpoints with status, never leaking the tool", () => {
  render(<PipelineDashboard dashboard={dash} />);
  expect(screen.getByTestId("pipeline-overall")).toHaveTextContent(/attention needed/i);
  expect(screen.getByTestId("pipeline-cat-unit")).toHaveTextContent(/Unit tests.*Passed/s);
  expect(screen.getByTestId("pipeline-cat-security")).toHaveTextContent(/Failed/);
  expect(screen.getByTestId("pipeline-cat-build-deploy")).toHaveTextContent(/Running/);
  // reusable + honest: the underlying tools (CodeQL/Vercel) never appear
  expect(screen.getByTestId("pipeline-dashboard")).not.toHaveTextContent(/codeql|vercel|jest/i);
});

test("hides an absent 'Other' bucket (a dark gauge with nothing in it)", () => {
  render(<PipelineDashboard dashboard={dash} />);
  expect(screen.queryByTestId("pipeline-cat-other")).not.toBeInTheDocument();
});
