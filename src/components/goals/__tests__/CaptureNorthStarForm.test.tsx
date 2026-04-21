/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

/**
 * CaptureNorthStarForm — admin-only snapshot capture.
 *
 * Locks:
 *   - hides for non-admin
 *   - submit disabled until label + numeric value
 *   - POSTs to /api/goals/north-star with trimmed label, numeric value, optional unit
 *   - surfaces server + network errors
 *   - fires onCaptured + resets on success
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CaptureNorthStarForm from "@/components/goals/CaptureNorthStarForm";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

function openForm() {
  fireEvent.click(screen.getByTestId("capture-north-star-open"));
}

describe("CaptureNorthStarForm", () => {
  test("renders nothing for non-admin", () => {
    const { container } = render(<CaptureNorthStarForm userRole="dev" onCaptured={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  test("admin sees the trigger button and can open the form", () => {
    render(<CaptureNorthStarForm userRole="ceo" onCaptured={() => {}} />);
    expect(screen.getByTestId("capture-north-star-open")).toBeInTheDocument();
    openForm();
    expect(screen.getByTestId("capture-north-star-form")).toBeInTheDocument();
  });

  test("submit disabled until label + numeric value are present", () => {
    render(<CaptureNorthStarForm userRole="ceo" onCaptured={() => {}} />);
    openForm();
    const submit = screen.getByTestId("capture-north-star-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("capture-north-star-label"), { target: { value: "MRR" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("capture-north-star-value"), { target: { value: "bad" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("capture-north-star-value"), { target: { value: "12345" } });
    expect(submit.disabled).toBe(false);
  });

  test("POSTs normalized body and fires onCaptured", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ snapshot: { id: "s-1", label: "MRR", value: 12345 } }),
    });
    const onCaptured = jest.fn();
    render(<CaptureNorthStarForm userRole="cto" onCaptured={onCaptured} />);
    openForm();
    fireEvent.change(screen.getByTestId("capture-north-star-label"), { target: { value: " MRR " } });
    fireEvent.change(screen.getByTestId("capture-north-star-value"), { target: { value: "12345" } });
    fireEvent.change(screen.getByTestId("capture-north-star-unit"), { target: { value: "USD" } });
    fireEvent.click(screen.getByTestId("capture-north-star-submit"));
    await waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/north-star");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ label: "MRR", value: 12345, unit: "USD" });
    // Form closed post-success
    expect(screen.queryByTestId("capture-north-star-form")).toBeNull();
  });

  test("omits unit when blank so the server's null default wins", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ snapshot: { id: "s-1", label: "NPS", value: 42 } }),
    });
    render(<CaptureNorthStarForm userRole="ceo" onCaptured={() => {}} />);
    openForm();
    fireEvent.change(screen.getByTestId("capture-north-star-label"), { target: { value: "NPS" } });
    fireEvent.change(screen.getByTestId("capture-north-star-value"), { target: { value: "42" } });
    fireEvent.click(screen.getByTestId("capture-north-star-submit"));
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    const body = JSON.parse(mockFetchWithRefresh.mock.calls[0][1].body);
    expect(body.unit).toBeUndefined();
  });

  test("surfaces server error on non-ok response", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    });
    render(<CaptureNorthStarForm userRole="ceo" onCaptured={() => {}} />);
    openForm();
    fireEvent.change(screen.getByTestId("capture-north-star-label"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("capture-north-star-value"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("capture-north-star-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("capture-north-star-error")).toHaveTextContent("Forbidden"),
    );
  });
});
