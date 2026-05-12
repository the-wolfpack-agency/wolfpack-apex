/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import UpdateKrProgressForm from "@/components/goals/UpdateKrProgressForm";

function open(krId: string) {
  fireEvent.click(screen.getByTestId(`update-kr-open-${krId}`));
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("UpdateKrProgressForm", () => {
  test("every user can open the form (no role gate)", () => {
    render(<UpdateKrProgressForm krId="k1" currentValue={10} targetValue={100} unit="users" onUpdated={() => {}} />);
    expect(screen.getByTestId("update-kr-open-k1")).toBeInTheDocument();
  });

  test("submit disabled until the value is a finite, changed number", () => {
    render(<UpdateKrProgressForm krId="k1" currentValue={10} targetValue={100} unit={null} onUpdated={() => {}} />);
    open("k1");
    const submit = screen.getByTestId("update-kr-submit-k1") as HTMLButtonElement;
    // Starts at current value → disabled
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("update-kr-value-k1"), { target: { value: "abc" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("update-kr-value-k1"), { target: { value: "25" } });
    expect(submit.disabled).toBe(false);
  });

  test("PATCHes /api/goals/krs/:id with the new current_value + fires onUpdated", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ kr: { id: "k1", current_value: 42 } }),
    });
    const onUpdated = jest.fn();
    render(<UpdateKrProgressForm krId="k1" currentValue={10} targetValue={100} unit="users" onUpdated={onUpdated} />);
    open("k1");
    fireEvent.change(screen.getByTestId("update-kr-value-k1"), { target: { value: "42" } });
    fireEvent.click(screen.getByTestId("update-kr-submit-k1"));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/krs/k1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ current_value: 42 });
    // Collapses after success
    expect(screen.queryByTestId("update-kr-form-k1")).toBeNull();
  });

  test("surfaces server error body.error and keeps the form open", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "KR not found" }),
    });
    render(<UpdateKrProgressForm krId="ghost" currentValue={0} targetValue={10} unit={null} onUpdated={() => {}} />);
    open("ghost");
    fireEvent.change(screen.getByTestId("update-kr-value-ghost"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("update-kr-submit-ghost"));
    await waitFor(() =>
      expect(screen.getByTestId("update-kr-error-ghost")).toHaveTextContent("KR not found"),
    );
  });
});
