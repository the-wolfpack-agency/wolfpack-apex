/**
 * @jest-environment jsdom
 *
 * BenchmarkPanel: loads the available models, runs the battery across them via
 * the real pipeline endpoint (mocked here), and renders the per-model comparison
 * graded by the shared gradeRuns.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import BenchmarkPanel from "@/components/ai-code/BenchmarkPanel";

const resp = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** A pipeline response for one run. cheap-model fails, strong-model is clean. */
function pipelineResp(pin: string) {
  const clean = pin === "strong-model";
  return resp(200, {
    run: {
      status: clean ? "ready_for_pr" : "needs_human",
      remediation: { attempts: clean ? [] : [{}, {}] },
      review: { verdict: { outcome: clean ? "allow" : "block" } },
    },
    deepScan: { critical: clean ? 0 : 1 },
    selfHealed: false,
    cost: { actualUsd: pin === "cheap-model" ? 0.0004 : 0.02 },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockImplementation((url: string, opts?: { body?: string }) => {
    if (url.includes("/benchmark/models")) {
      return Promise.resolve(
        resp(200, {
          models: [
            { pin: "cheap-model", provider: "azure", tier: "small", label: "cheap-model" },
            { pin: "strong-model", provider: "anthropic", tier: "large", label: "strong-model" },
          ],
        }),
      );
    }
    if (url.includes("/pipeline")) {
      const body = JSON.parse(opts?.body ?? "{}");
      return Promise.resolve(pipelineResp(body.executorProviderPin));
    }
    return Promise.resolve(resp(404, {}));
  });
});

it("loads the available models", async () => {
  render(<BenchmarkPanel />);
  await waitFor(() => expect(screen.getByText(/cheap-model/)).toBeInTheDocument());
  expect(screen.getByText(/strong-model/)).toBeInTheDocument();
});

it("runs the battery across models and renders a graded comparison", async () => {
  render(<BenchmarkPanel />);
  await waitFor(() => expect(screen.getByTestId("run-benchmark")).toBeEnabled());
  fireEvent.click(screen.getByTestId("run-benchmark"));
  await waitFor(() => expect(screen.getByTestId("benchmark-results")).toBeInTheDocument(), { timeout: 5000 });
  // Both models graded; strong-model (100% ready) ranks first (★).
  const table = screen.getByTestId("benchmark-results");
  expect(table).toHaveTextContent("strong-model");
  expect(table).toHaveTextContent("cheap-model");
  // 2 models x 2 battery prompts = 1 models GET + 4 pipeline POSTs.
  const pipelineCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/pipeline"));
  expect(pipelineCalls).toHaveLength(4);
});
