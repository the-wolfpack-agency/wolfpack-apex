/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ManageNorthStarButton from "@/components/goals/ManageNorthStarButton";

function renderBtn(over: Partial<Parameters<typeof ManageNorthStarButton>[0]> = {}) {
  return render(
    <ManageNorthStarButton
      snapshotId="s1"
      currentValue={100}
      currentLabel="MRR"
      currentUnit="USD"
      userRole="ceo"
      onChanged={over.onChanged ?? (() => {})}
      {...over}
    />,
  );
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("ManageNorthStarButton", () => {
  test("hidden for non-admin", () => {
    const { container } = renderBtn({ userRole: "sales" });
    expect(container.innerHTML).toBe("");
  });

  test("admin opens the form and can PATCH the snapshot", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ snapshot: { id: "s1", value: 250 } }),
    });
    const onChanged = jest.fn();
    renderBtn({ onChanged });
    fireEvent.click(screen.getByTestId("manage-north-star-open-s1"));
    fireEvent.change(screen.getByTestId("manage-north-star-value-s1"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByTestId("manage-north-star-save-s1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/north-star/s1");
    expect(init.method).toBe("PATCH");
  });

  test("delete button DELETEs the snapshot (after confirm)", async () => {
    const origConfirm = window.confirm;
    window.confirm = jest.fn(() => true);
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ snapshot: { id: "s1" } }),
    });
    const onChanged = jest.fn();
    renderBtn({ onChanged });
    fireEvent.click(screen.getByTestId("manage-north-star-open-s1"));
    fireEvent.click(screen.getByTestId("manage-north-star-delete-s1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockFetchWithRefresh.mock.calls[0][1].method).toBe("DELETE");
    window.confirm = origConfirm;
  });

  test("delete aborts when user declines confirm", async () => {
    const origConfirm = window.confirm;
    window.confirm = jest.fn(() => false);
    renderBtn();
    fireEvent.click(screen.getByTestId("manage-north-star-open-s1"));
    fireEvent.click(screen.getByTestId("manage-north-star-delete-s1"));
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
    window.confirm = origConfirm;
  });

  test("surfaces server error on PATCH failure", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "not_found" }),
    });
    renderBtn();
    fireEvent.click(screen.getByTestId("manage-north-star-open-s1"));
    fireEvent.change(screen.getByTestId("manage-north-star-value-s1"), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByTestId("manage-north-star-save-s1"));
    await waitFor(() =>
      expect(screen.getByTestId("manage-north-star-error-s1")).toHaveTextContent("not_found"),
    );
  });
});
