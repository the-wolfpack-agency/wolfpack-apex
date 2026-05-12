/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ManageKrButton from "@/components/goals/ManageKrButton";

function renderBtn(over: Partial<Parameters<typeof ManageKrButton>[0]> = {}) {
  return render(
    <ManageKrButton
      krId="k1"
      currentMetric="signups"
      currentTarget={250}
      currentUnit="users"
      currentCadence="weekly"
      userRole="ceo"
      onChanged={over.onChanged ?? (() => {})}
      {...over}
    />,
  );
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("ManageKrButton", () => {
  test("hidden for non-admin", () => {
    const { container } = renderBtn({ userRole: "dev" });
    expect(container.innerHTML).toBe("");
  });

  test("admin opens the form; save disabled until something changes", () => {
    renderBtn();
    fireEvent.click(screen.getByTestId("manage-kr-open-k1"));
    const save = screen.getByTestId("manage-kr-save-k1") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("manage-kr-metric-k1"), {
      target: { value: "activations" },
    });
    expect(save.disabled).toBe(false);
  });

  test("PATCHes /api/goals/krs/:id with normalized fields", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kr: { id: "k1" } }),
    });
    const onChanged = jest.fn();
    renderBtn({ onChanged });
    fireEvent.click(screen.getByTestId("manage-kr-open-k1"));
    fireEvent.change(screen.getByTestId("manage-kr-target-k1"), { target: { value: "500" } });
    fireEvent.change(screen.getByTestId("manage-kr-cadence-k1"), { target: { value: "monthly" } });
    fireEvent.click(screen.getByTestId("manage-kr-save-k1"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/krs/k1");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body.metric).toBe("signups");
    expect(body.target).toBe(500);
    expect(body.unit).toBe("users");
    expect(body.cadence).toBe("monthly");
  });

  test("Delete hits DELETE after confirm", async () => {
    const origConfirm = window.confirm;
    window.confirm = jest.fn(() => true);
    mockFetchWithRefresh.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const onChanged = jest.fn();
    renderBtn({ onChanged });
    fireEvent.click(screen.getByTestId("manage-kr-open-k1"));
    fireEvent.click(screen.getByTestId("manage-kr-delete-k1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetchWithRefresh.mock.calls[0][1].method).toBe("DELETE");
    window.confirm = origConfirm;
  });

  test("Delete aborts when user declines confirm", () => {
    const origConfirm = window.confirm;
    window.confirm = jest.fn(() => false);
    renderBtn();
    fireEvent.click(screen.getByTestId("manage-kr-open-k1"));
    fireEvent.click(screen.getByTestId("manage-kr-delete-k1"));
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
    window.confirm = origConfirm;
  });

  test("surfaces server error on non-ok PATCH", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    });
    renderBtn();
    fireEvent.click(screen.getByTestId("manage-kr-open-k1"));
    fireEvent.change(screen.getByTestId("manage-kr-target-k1"), { target: { value: "500" } });
    fireEvent.click(screen.getByTestId("manage-kr-save-k1"));
    await waitFor(() =>
      expect(screen.getByTestId("manage-kr-error-k1")).toHaveTextContent("Forbidden"),
    );
  });
});
