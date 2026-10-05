/**
 * @jest-environment jsdom
 */
/**
 * Model Fitness page: renders the per-model leaderboard from the /fitness payload,
 * shows an empty state when nothing is measured, renders drift, and fires the view
 * event. The unauthenticated redirect is covered by the E2E spec (window.location).
 */
import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";

let user: unknown = { role: "admin" };
const mockFetch = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => user,
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import ModelFitnessPage from "../page";

const model = (over: Record<string, unknown> = {}) => ({
  model: "gpt-4o", n: 6, readyRate: 0.67, firstPassRate: 0.67, value: 85.8,
  observedTier: "mid", confident: true, declaredTier: "large", verdict: "below",
  topFailure: "broken imports 33%", ...over,
});

function payload(models: unknown[], drift: unknown[] = []) {
  return { overall: { readyRate: 0.6, firstPassRate: 0.5, escalationRate: 0.2, models: models.length }, models, drift };
}

function wireFetch(models: unknown[], drift: unknown[] = []) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes("/fitness")) {
      return Promise.resolve({ ok: true, json: async () => payload(models, drift) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) }); // analytics POST
  });
}

beforeEach(() => { mockFetch.mockReset(); user = { role: "admin" }; });

it("renders the leaderboard with a model row and fires the view event", async () => {
  wireFetch([model()]);
  await act(async () => { render(<ModelFitnessPage />); });
  await waitFor(() => expect(screen.getByTestId("model-leaderboard")).toBeInTheDocument());
  expect(screen.getByTestId("mf-row-gpt-4o")).toBeInTheDocument();
  expect(screen.getByText("(below)")).toBeInTheDocument(); // declared-vs-observed verdict
  await waitFor(() =>
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/api/analytics"))).toBe(true),
  );
});

it("shows the empty state when no models are measured", async () => {
  wireFetch([]);
  await act(async () => { render(<ModelFitnessPage />); });
  await waitFor(() => expect(screen.getByTestId("model-fitness-empty")).toBeInTheDocument());
});

it("renders drift flags when present", async () => {
  wireFetch([model()], [{ model: "gpt-4o", priorReadyRate: 0.9, recentReadyRate: 0.5, drop: 0.4, priorN: 10, recentN: 10 }]);
  await act(async () => { render(<ModelFitnessPage />); });
  await waitFor(() => expect(screen.getByTestId("mf-drift-gpt-4o")).toBeInTheDocument());
});
