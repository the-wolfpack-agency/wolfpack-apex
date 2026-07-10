/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * ExecuteAgentWidget — the agent control plane in chat. Tests pin:
 *   1. Renders the agent picker + template fields.
 *   2. Run is gated until Objective AND Success criteria are filled.
 *   3. Submit POSTs the template (+ source: chat_widget) to the task API for
 *      the selected agent and renders the terminal result.
 *   4. A 403 surfaces a clear permission error.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExecuteAgentWidget } from "@/components/widgets/ExecuteAgentWidget";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const spec = {
  kind: "execute_agent",
  agents: [
    { id: "a1", name: "Aria", state: "active" },
    { id: "a2", name: "Bob", state: "paused" },
  ],
  submitUrlTemplate: "/api/admin/agents/{id}/tasks",
} as any;

/** Route analytics calls to ok; return `taskRes` for the task POST. */
function wire(taskRes: any) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/api/analytics")) return Promise.resolve(mkRes({}));
    return Promise.resolve(taskRes);
  });
}

beforeEach(() => mockFetchWithRefresh.mockReset());

it("renders the picker and template fields, gated until required fields are filled", () => {
  wire(mkRes({ task: {} }, { status: 201 }));
  render(<ExecuteAgentWidget spec={spec} />);

  expect(screen.getByTestId("execute-agent-select")).toBeInTheDocument();
  expect(screen.getByTestId("execute-agent-objective")).toBeInTheDocument();
  expect(screen.getByTestId("execute-agent-successCriteria")).toBeInTheDocument();
  expect(screen.getByTestId("execute-agent-context")).toBeInTheDocument();

  const submit = screen.getByTestId("execute-agent-submit");
  expect(submit).toBeDisabled();

  fireEvent.change(screen.getByTestId("execute-agent-objective"), {
    target: { value: "Reconcile June invoices" },
  });
  // objective alone is not enough
  expect(submit).toBeDisabled();

  fireEvent.change(screen.getByTestId("execute-agent-successCriteria"), {
    target: { value: "All 31 matched or flagged" },
  });
  expect(submit).not.toBeDisabled();
});

it("submits the template to the selected agent and shows the result", async () => {
  wire(
    mkRes(
      {
        task: {
          id: "t1",
          status: "succeeded",
          steps: [{ index: 0, instruction: "x", tool: "search", outcome: "ran", detail: "ok" }],
          resultSummary: "Reconciled 31 invoices.",
        },
      },
      { status: 201 },
    ),
  );
  render(<ExecuteAgentWidget spec={spec} />);

  fireEvent.change(screen.getByTestId("execute-agent-objective"), {
    target: { value: "Reconcile June invoices" },
  });
  fireEvent.change(screen.getByTestId("execute-agent-successCriteria"), {
    target: { value: "All 31 matched or flagged" },
  });

  await act(async () => {
    fireEvent.click(screen.getByTestId("execute-agent-submit"));
  });

  await waitFor(() =>
    expect(screen.getByTestId("execute-agent-result")).toBeInTheDocument(),
  );
  expect(screen.getByTestId("execute-agent-result").textContent).toContain("succeeded");
  expect(screen.getByText("Reconciled 31 invoices.")).toBeInTheDocument();

  const taskCall = mockFetchWithRefresh.mock.calls.find((c) =>
    String(c[0]).includes("/tasks"),
  );
  expect(taskCall?.[0]).toBe("/api/admin/agents/a1/tasks"); // default = first active
  const body = JSON.parse((taskCall?.[1] as any).body);
  expect(body).toMatchObject({
    objective: "Reconcile June invoices",
    successCriteria: "All 31 matched or flagged",
    source: "chat_widget",
  });
});

it("surfaces a 403 as a permission error", async () => {
  wire(mkRes({ error: "forbidden" }, { ok: false, status: 403 }));
  render(<ExecuteAgentWidget spec={spec} />);

  fireEvent.change(screen.getByTestId("execute-agent-objective"), {
    target: { value: "do it" },
  });
  fireEvent.change(screen.getByTestId("execute-agent-successCriteria"), {
    target: { value: "done" },
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("execute-agent-submit"));
  });

  await waitFor(() =>
    expect(screen.getByTestId("execute-agent-error")).toBeInTheDocument(),
  );
  expect(screen.getByTestId("execute-agent-error").textContent).toMatch(/permission/i);
});
