/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import EditOkrButton from "@/components/goals/EditOkrButton";

function renderBtn(over: Partial<Parameters<typeof EditOkrButton>[0]> = {}) {
  return render(
    <EditOkrButton
      okrId="o1"
      currentObjective="Launch MVP"
      currentQuarter="2026-Q2"
      userRole="ceo"
      onSaved={over.onSaved ?? (() => {})}
      {...over}
    />,
  );
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("EditOkrButton", () => {
  test("hidden for non-admin roles", () => {
    const { container } = renderBtn({ userRole: "dev" });
    expect(container.innerHTML).toBe("");
  });

  test("admin sees trigger and can open the form", () => {
    renderBtn();
    fireEvent.click(screen.getByTestId("edit-okr-open-o1"));
    expect(screen.getByTestId("edit-okr-form-o1")).toBeInTheDocument();
  });

  test("submit disabled until SOMETHING changes (and stays valid)", () => {
    renderBtn();
    fireEvent.click(screen.getByTestId("edit-okr-open-o1"));
    const submit = screen.getByTestId("edit-okr-submit-o1") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nothing changed yet
    fireEvent.change(screen.getByTestId("edit-okr-objective-o1"), {
      target: { value: "New objective" },
    });
    expect(submit.disabled).toBe(false);
  });

  test("rejects malformed quarter (re-disables submit)", () => {
    renderBtn();
    fireEvent.click(screen.getByTestId("edit-okr-open-o1"));
    fireEvent.change(screen.getByTestId("edit-okr-quarter-o1"), {
      target: { value: "Q2-2026" },
    });
    const submit = screen.getByTestId("edit-okr-submit-o1") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  test("PATCHes /api/goals/okrs/:id and fires onSaved", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ okr: { id: "o1" } }),
    });
    const onSaved = jest.fn();
    renderBtn({ onSaved });
    fireEvent.click(screen.getByTestId("edit-okr-open-o1"));
    fireEvent.change(screen.getByTestId("edit-okr-objective-o1"), {
      target: { value: "Tight MVP" },
    });
    fireEvent.click(screen.getByTestId("edit-okr-submit-o1"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/okrs/o1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      objective: "Tight MVP",
      quarter: "2026-Q2",
    });
    expect(screen.queryByTestId("edit-okr-form-o1")).toBeNull();
  });

  test("surfaces server error on non-ok response", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "okr_not_found" }),
    });
    renderBtn();
    fireEvent.click(screen.getByTestId("edit-okr-open-o1"));
    fireEvent.change(screen.getByTestId("edit-okr-objective-o1"), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByTestId("edit-okr-submit-o1"));
    await waitFor(() =>
      expect(screen.getByTestId("edit-okr-error-o1")).toHaveTextContent("okr_not_found"),
    );
  });
});
