/** @jest-environment jsdom */

import "@testing-library/jest-dom";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetch as (...x: unknown[]) => unknown)(...a),
}));

import { render, screen, waitFor } from "@testing-library/react";
import { ModelRegressionPanel } from "@/components/agents/ModelRegressionPanel";

function mkRes(body: unknown, ok = true): any {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function standing(over: Record<string, unknown> = {}) {
  return {
    agentId: "agt-A",
    agentName: "Alpha",
    verdict: "regressed",
    candidateModel: "gpt-new",
    baselineModel: "gpt-old",
    candidateSuccessRate: 0.5,
    baselineSuccessRate: 0.9,
    delta: -0.4,
    candidateSamples: 20,
    baselineSamples: 20,
    ...over,
  };
}

const TID = "model-regression-panel";
beforeEach(() => mockFetch.mockReset());

it("lists a regressed agent with its models, rates, and delta", async () => {
  mockFetch.mockResolvedValue(
    mkRes({ ok: true, standings: [standing()], regressions: [] }),
  );
  render(<ModelRegressionPanel />);
  await waitFor(() =>
    expect(screen.getByTestId(`${TID}-agent-agt-A`)).toBeInTheDocument(),
  );
  const row = screen.getByTestId(`${TID}-agent-agt-A`);
  expect(row).toHaveTextContent("Alpha");
  expect(row).toHaveTextContent("gpt-old (90%)");
  expect(row).toHaveTextContent("gpt-new (50%)");
  expect(screen.getByTestId(`${TID}-delta-agt-A`)).toHaveTextContent("-40 pts");
  expect(screen.getByTestId(`${TID}-regressed-count`)).toHaveTextContent("1");
});

it("counts improvements without listing them as regressions", async () => {
  mockFetch.mockResolvedValue(
    mkRes({
      ok: true,
      standings: [
        standing({ agentId: "agt-B", agentName: "Bravo", verdict: "improved", delta: 0.3 }),
      ],
      regressions: [],
    }),
  );
  render(<ModelRegressionPanel />);
  await waitFor(() =>
    expect(screen.getByTestId(`${TID}-all-clear`)).toBeInTheDocument(),
  );
  expect(screen.getByTestId(`${TID}-improved-count`)).toHaveTextContent("1");
  expect(screen.getByTestId(`${TID}-regressed-count`)).toHaveTextContent("0");
  expect(screen.queryByTestId(`${TID}-agent-agt-B`)).not.toBeInTheDocument();
});

it("shows the not-enough-data message when no agent is evaluable", async () => {
  mockFetch.mockResolvedValue(mkRes({ ok: true, standings: [], regressions: [] }));
  render(<ModelRegressionPanel />);
  await waitFor(() =>
    expect(screen.getByTestId(`${TID}-all-clear`)).toBeInTheDocument(),
  );
  expect(screen.getByTestId(`${TID}-all-clear`)).toHaveTextContent(
    /not enough runs/i,
  );
});

it("shows an error state on a non-ok response (never blanks)", async () => {
  mockFetch.mockResolvedValue(mkRes({}, false));
  render(<ModelRegressionPanel />);
  await waitFor(() =>
    expect(screen.getByTestId(`${TID}-error`)).toBeInTheDocument(),
  );
});

it("treats a malformed body as an error, not a crash", async () => {
  mockFetch.mockResolvedValue(mkRes({ ok: true, standings: "nope" }));
  render(<ModelRegressionPanel />);
  await waitFor(() =>
    expect(screen.getByTestId(`${TID}-error`)).toBeInTheDocument(),
  );
});
