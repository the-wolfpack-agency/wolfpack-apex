/** @jest-environment jsdom */

import "@testing-library/jest-dom";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetch as (...x: unknown[]) => unknown)(...a),
}));

import { render, screen, waitFor } from "@testing-library/react";
import { AgentDeploymentsPanel } from "@/components/deploy/AgentDeploymentsPanel";

function mkRes(body: unknown, ok = true): any {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function inflightPipeline(pr: number) {
  return {
    id: `pr-${pr}`, title: "Fix the deploy", url: "u", author: "a", commitSha: "s", prNumber: pr,
    ageHours: 2, hasMigration: false, live: false, status: "failed", currentStage: "ci",
    stages: [
      { key: "ci", label: "CI checks", status: "failed", detail: "a check failed" },
      { key: "merge", label: "Merge", status: "pending", detail: "" },
      { key: "build", label: "Build + migrate", status: "pending", detail: "" },
      { key: "promote", label: "Promote", status: "pending", detail: "" },
      { key: "verify", label: "Prod verify", status: "pending", detail: "" },
      { key: "health", label: "Health", status: "pending", detail: "" },
    ],
  };
}

const TID = "agent-deployments";
beforeEach(() => mockFetch.mockReset());

it("renders the in-flight PR pipeline and a resolved line for a vanished one", async () => {
  mockFetch.mockResolvedValue(
    mkRes({
      ok: true,
      degraded: [],
      links: [
        { prNumber: 42, stateAtTriage: "checks_failing", triagedAt: "t", pipeline: inflightPipeline(42), resolved: false },
        { prNumber: 7, stateAtTriage: "awaiting_approval", triagedAt: "t", pipeline: null, resolved: true },
      ],
    }),
  );
  render(<AgentDeploymentsPanel agentId="agt-1" testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-row-42`)).toBeInTheDocument());
  expect(screen.getByTestId(`${TID}-row-42`)).toHaveTextContent("#42 Fix the deploy");
  const resolved = screen.getByTestId(`${TID}-resolved-7`);
  expect(resolved).toHaveTextContent("#7");
  expect(resolved).toHaveTextContent(/resolved since triage/i);
  expect(resolved).toHaveTextContent(/awaiting approval/i);
});

it("shows the empty state when the agent triaged nothing", async () => {
  mockFetch.mockResolvedValue(mkRes({ ok: true, links: [], degraded: [] }));
  render(<AgentDeploymentsPanel agentId="agt-1" testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-empty`)).toBeInTheDocument());
});

it("shows an error state on a non-ok response", async () => {
  mockFetch.mockResolvedValue(mkRes({}, false));
  render(<AgentDeploymentsPanel agentId="agt-1" testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-error`)).toBeInTheDocument());
});
