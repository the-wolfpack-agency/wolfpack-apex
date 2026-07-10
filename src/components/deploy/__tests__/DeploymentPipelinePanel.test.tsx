/** @jest-environment jsdom */

import "@testing-library/jest-dom";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetch as (...x: unknown[]) => unknown)(...a),
}));

import { render, screen, waitFor } from "@testing-library/react";
import { DeploymentPipelinePanel } from "@/components/deploy/DeploymentPipelinePanel";

function mkRes(body: unknown, ok = true): any {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function livePipeline() {
  return {
    id: "sha1", title: "Live change", url: "u", author: "nick", commitSha: "sha1", prNumber: null,
    ageHours: null, hasMigration: false, live: true, status: "deployed", currentStage: "health",
    stages: [
      { key: "ci", label: "CI checks", status: "passed", detail: "" },
      { key: "merge", label: "Merge", status: "passed", detail: "" },
      { key: "build", label: "Build + migrate", status: "passed", detail: "" },
      { key: "promote", label: "Promote", status: "passed", detail: "" },
      { key: "verify", label: "Prod verify", status: "passed", detail: "" },
      { key: "health", label: "Health", status: "passed", detail: "" },
    ],
  };
}

const TID = "deployment-pipeline";
beforeEach(() => mockFetch.mockReset());

it("renders one pipeline row per change with the summary metrics", async () => {
  mockFetch.mockResolvedValue(mkRes({ ok: true, pipelines: [livePipeline()], servingSha: "sha1", degraded: [] }));
  render(<DeploymentPipelinePanel testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-row-sha1`)).toBeInTheDocument());
  expect(screen.getByTestId(`${TID}-row-sha1`)).toHaveTextContent("Live change");
  expect(screen.getByTestId(`${TID}-total`)).toHaveTextContent("1");
});

it("surfaces a degrade banner instead of a false all-clear", async () => {
  mockFetch.mockResolvedValue(
    mkRes({ ok: true, pipelines: [], servingSha: null, degraded: [{ source: "vercel", detail: "Set VERCEL_API_TOKEN to see build and deploy stages." }] }),
  );
  render(<DeploymentPipelinePanel testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-degraded`)).toBeInTheDocument());
  expect(screen.getByTestId(`${TID}-degraded`)).toHaveTextContent(/VERCEL_API_TOKEN/);
  expect(screen.getByTestId(`${TID}-empty`)).toBeInTheDocument();
});

it("shows an error state on a non-ok response (never blanks)", async () => {
  mockFetch.mockResolvedValue(mkRes({}, false));
  render(<DeploymentPipelinePanel testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-error`)).toBeInTheDocument());
});

it("treats a malformed body as an error, not a crash", async () => {
  mockFetch.mockResolvedValue(mkRes({ ok: true, pipelines: "nope" }));
  render(<DeploymentPipelinePanel testId={TID} />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-error`)).toBeInTheDocument());
});
