/** @jest-environment jsdom */
/**
 * OpenPullRequests: the in-tool approval surface renders the workspace's open
 * factory PRs, disables the merge button until CI is green, merges from the tool,
 * and surfaces a GitHub refusal (branch protection) inline instead of swallowing it.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockLoad = jest.fn();
const mockMerge = jest.fn();
jest.mock("../client", () => ({
  loadOpenPulls: (...a: unknown[]) => mockLoad(...a),
  mergePull: (...a: unknown[]) => mockMerge(...a),
}));

import OpenPullRequests from "../OpenPullRequests";

const greenPr = { repo: "o/r", number: 5, title: "Add x", url: "https://github.com/o/r/pull/5", branch: "factory/x", base: "main", ciGreen: true, ciReadable: true, gateOutcome: "allow" as const, touchesSensitiveSurface: false, hasTests: true, fileCount: 2, eligible: true, eligibilityReason: "ok" };
const redPr = { ...greenPr, number: 6, title: "Not green", url: "https://github.com/o/r/pull/6", ciGreen: false, eligible: false, gateOutcome: "escalate" as const };

beforeEach(() => jest.clearAllMocks());

it("renders nothing when there are no open PRs", async () => {
  mockLoad.mockResolvedValue([]);
  const { container } = render(<OpenPullRequests repo="o/r" />);
  await waitFor(() => expect(mockLoad).toHaveBeenCalled());
  expect(container.querySelector('[data-testid="open-pulls"]')).toBeNull();
});

it("lists open PRs with a link and status badges", async () => {
  mockLoad.mockResolvedValue([greenPr]);
  render(<OpenPullRequests repo="o/r" />);
  await screen.findByTestId("pull-5");
  const link = screen.getByText(/#5 Add x/);
  expect(link).toHaveAttribute("href", "https://github.com/o/r/pull/5");
  expect(screen.getByText("CI green")).toBeInTheDocument();
  expect(screen.getByText("gate allow")).toBeInTheDocument();
  expect(screen.getByText("auto-eligible")).toBeInTheDocument();
});

it("disables Approve & merge until CI is green", async () => {
  mockLoad.mockResolvedValue([redPr]);
  render(<OpenPullRequests repo="o/r" />);
  await screen.findByTestId("pull-6");
  expect(screen.getByTestId("approve-6")).toBeDisabled();
});

it("merges from the tool and removes the row on success", async () => {
  mockLoad.mockResolvedValue([greenPr]);
  mockMerge.mockResolvedValue({ ok: true, sha: "deadbeef" });
  render(<OpenPullRequests repo="o/r" />);
  await screen.findByTestId("approve-5");
  fireEvent.click(screen.getByTestId("approve-5"));
  await waitFor(() => expect(mockMerge).toHaveBeenCalledWith("o/r", 5));
  await waitFor(() => expect(screen.queryByTestId("pull-5")).toBeNull());
});

it("surfaces a GitHub refusal (branch protection) inline, row stays", async () => {
  mockLoad.mockResolvedValue([greenPr]);
  mockMerge.mockResolvedValue({ ok: false, error: "GitHub refused the merge (HTTP 405): review required" });
  render(<OpenPullRequests repo="o/r" />);
  await screen.findByTestId("approve-5");
  fireEvent.click(screen.getByTestId("approve-5"));
  await screen.findByTestId("note-5");
  expect(screen.getByTestId("note-5")).toHaveTextContent(/review required/i);
  expect(screen.getByTestId("pull-5")).toBeInTheDocument();
});
