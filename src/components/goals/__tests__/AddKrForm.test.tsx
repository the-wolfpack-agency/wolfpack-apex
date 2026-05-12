/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * AddKrForm — per-OKR "add supplemental KR" form (all-role).
 *
 * Locks:
 *   - available to every authenticated user (no role gate)
 *   - submit disabled until metric + numeric target
 *   - POSTs to /api/goals/okrs/:id/krs with normalized body
 *   - server + network errors surface
 *   - fires onAdded + resets + collapses on success
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AddKrForm from "@/components/goals/AddKrForm";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("AddKrForm", () => {
  test("every user sees the trigger — no role gate", () => {
    render(<AddKrForm okrId="o-1" onAdded={() => {}} />);
    expect(screen.getByTestId("add-kr-open-o-1")).toBeInTheDocument();
  });

  test("submit disabled until metric + numeric target", () => {
    render(<AddKrForm okrId="o-1" onAdded={() => {}} />);
    fireEvent.click(screen.getByTestId("add-kr-open-o-1"));
    const submit = screen.getByTestId("add-kr-submit-o-1") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("add-kr-metric-o-1"), { target: { value: "signups" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("add-kr-target-o-1"), { target: { value: "abc" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("add-kr-target-o-1"), { target: { value: "42" } });
    expect(submit.disabled).toBe(false);
  });

  test("POSTs to /api/goals/okrs/:id/krs with normalized body and fires onAdded", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ kr: { id: "kr-new", okr_id: "o-1", metric: "m" } }),
    });
    const onAdded = jest.fn();
    render(<AddKrForm okrId="o-1" onAdded={onAdded} />);
    fireEvent.click(screen.getByTestId("add-kr-open-o-1"));
    fireEvent.change(screen.getByTestId("add-kr-metric-o-1"), {
      target: { value: "  signups  " },
    });
    fireEvent.change(screen.getByTestId("add-kr-target-o-1"), { target: { value: "250" } });
    fireEvent.change(screen.getByTestId("add-kr-unit-o-1"), { target: { value: "users" } });
    fireEvent.change(screen.getByTestId("add-kr-cadence-o-1"), { target: { value: "monthly" } });

    fireEvent.click(screen.getByTestId("add-kr-submit-o-1"));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/okrs/o-1/krs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      metric: "signups",
      target: 250,
      unit: "users",
      cadence: "monthly",
    });
    // Collapses back to the +Add KR button after success
    expect(screen.queryByTestId("add-kr-form-o-1")).toBeNull();
    expect(screen.getByTestId("add-kr-open-o-1")).toBeInTheDocument();
  });

  test("surfaces server error and keeps the form open", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "okr_not_found_or_archived" }),
    });
    const onAdded = jest.fn();
    render(<AddKrForm okrId="gone" onAdded={onAdded} />);
    fireEvent.click(screen.getByTestId("add-kr-open-gone"));
    fireEvent.change(screen.getByTestId("add-kr-metric-gone"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("add-kr-target-gone"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("add-kr-submit-gone"));
    await waitFor(() =>
      expect(screen.getByTestId("add-kr-error-gone")).toHaveTextContent("okr_not_found_or_archived"),
    );
    expect(screen.getByTestId("add-kr-form-gone")).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
  });

  test("surfaces Network error when fetch rejects", async () => {
    mockFetchWithRefresh.mockRejectedValue(new Error("down"));
    render(<AddKrForm okrId="o-1" onAdded={() => {}} />);
    fireEvent.click(screen.getByTestId("add-kr-open-o-1"));
    fireEvent.change(screen.getByTestId("add-kr-metric-o-1"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("add-kr-target-o-1"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("add-kr-submit-o-1"));
    await waitFor(() =>
      expect(screen.getByTestId("add-kr-error-o-1")).toHaveTextContent("Network error"),
    );
  });
});
