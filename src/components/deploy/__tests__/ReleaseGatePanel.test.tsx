/** @jest-environment jsdom */

import "@testing-library/jest-dom";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetch as (...x: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { ReleaseGatePanel } from "@/components/deploy/ReleaseGatePanel";

function mkRes(body: unknown, ok = true): any {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

const TID = "release-gate-panel";
beforeEach(() => mockFetch.mockReset());

it("renders blocking PRs with their state and author", async () => {
  mockFetch.mockResolvedValue(
    mkRes({
      ok: true,
      gate: {
        productionBranch: "main",
        checkedAt: "2026-07-10T00:00:00Z",
        blocking: [
          { number: 42, title: "Fix the thing", url: "https://gh/42", author: "nhomyk", state: "checks_failing", reason: "checks failing", ageHours: 3 },
          { number: 43, title: "Add a feature", url: "https://gh/43", author: "dev", state: "ready_to_merge", reason: "ready", ageHours: 1 },
        ],
      },
    }),
  );
  render(<ReleaseGatePanel />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-pr-42`)).toBeInTheDocument());
  expect(screen.getByTestId(`${TID}-pr-42`)).toHaveTextContent("Fix the thing");
  expect(screen.getByTestId(`${TID}-pr-42`)).toHaveTextContent("Checks failing");
  expect(screen.getByTestId(`${TID}-pr-43`)).toHaveTextContent("Ready to promote");
  expect(screen.getByTestId(`${TID}-open-full`)).toHaveAttribute("href", "/admin/deployment");
});

it("shows an all-clear when nothing is blocking", async () => {
  mockFetch.mockResolvedValue(
    mkRes({ ok: true, gate: { productionBranch: "main", checkedAt: "x", blocking: [] } }),
  );
  render(<ReleaseGatePanel />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-all-clear`)).toBeInTheDocument());
  expect(screen.queryByTestId(`${TID}-list`)).not.toBeInTheDocument();
});

it("surfaces an honest degrade (never a false all-clear)", async () => {
  mockFetch.mockResolvedValue(
    mkRes({ ok: true, gate: { productionBranch: "main", checkedAt: "x", blocking: [], degraded: { detail: "GitHub 502" } } }),
  );
  render(<ReleaseGatePanel />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-degraded`)).toBeInTheDocument());
  expect(screen.getByTestId(`${TID}-degraded`)).toHaveTextContent(/GitHub 502/);
  expect(screen.queryByTestId(`${TID}-all-clear`)).not.toBeInTheDocument();
});

it("dispatches a read-only triage task to a chosen active agent", async () => {
  mockFetch.mockImplementation((url: unknown, init?: { method?: string }) => {
    const u = String(url);
    if (u.includes("/api/admin/deployment/release-gate")) {
      return Promise.resolve(
        mkRes({
          ok: true,
          gate: {
            productionBranch: "main",
            checkedAt: "x",
            blocking: [{ number: 42, title: "Fix", url: "https://gh/42", author: "n", state: "checks_failing", reason: "a check is failing", ageHours: 2 }],
          },
        }),
      );
    }
    if (u === "/api/admin/agents") {
      return Promise.resolve(mkRes({ agents: [{ id: "a1", name: "Aria", state: "active" }, { id: "a2", name: "Bob", state: "paused" }] }));
    }
    if (u.includes("/api/analytics")) return Promise.resolve(mkRes({}));
    if (u.includes("/tasks") && init?.method === "POST") {
      return Promise.resolve(mkRes({ task: { status: "succeeded", resultSummary: "Assessed: needs a rebase." } }));
    }
    return Promise.resolve(mkRes({}));
  });

  render(<ReleaseGatePanel />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-pr-42`)).toBeInTheDocument());

  await act(async () => {
    fireEvent.click(screen.getByTestId("triage-open-42"));
  });
  await waitFor(() => expect(screen.getByTestId("triage-agent-42")).toBeInTheDocument());
  // Only the ACTIVE agent is offered (paused Bob excluded), preselected.
  expect(screen.getByTestId("triage-agent-42")).toHaveValue("a1");
  expect(screen.queryByText("Bob")).not.toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByTestId("triage-dispatch-42"));
  });
  await waitFor(() => expect(screen.getByTestId("triage-result-42")).toBeInTheDocument());
  expect(screen.getByTestId("triage-result-42")).toHaveTextContent("succeeded");

  const post = mockFetch.mock.calls.find(
    (c) => String(c[0]).includes("/api/admin/agents/a1/tasks") && (c[1] as { method?: string })?.method === "POST",
  );
  expect(post).toBeTruthy();
  const body = JSON.parse((post![1] as { body: string }).body);
  expect(body.source).toBe("deploy_gate");
  expect(body.objective).toContain("Triage PR #42");
  expect(body.successCriteria).toBeTruthy();
});

it("shows an error state when the gate cannot be loaded", async () => {
  mockFetch.mockResolvedValue(mkRes({ error: "denied" }, false));
  render(<ReleaseGatePanel />);
  await waitFor(() => expect(screen.getByTestId(`${TID}-error`)).toBeInTheDocument());
});
