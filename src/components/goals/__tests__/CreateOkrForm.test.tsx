/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * CreateOkrForm — admin-only OKR creation UI.
 *
 * Locks:
 *   - hides entirely for non-admin roles
 *   - validates quarter format + non-empty objective + per-KR metric+target
 *   - POSTs the normalized body to /api/goals/okrs
 *   - surfaces server error strings
 *   - allows add/remove of KR rows; the last KR can't be removed
 *   - resets + closes + fires onCreated on success
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateOkrForm from "@/components/goals/CreateOkrForm";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

function openForm() {
  fireEvent.click(screen.getByTestId("create-okr-open"));
}

describe("CreateOkrForm", () => {
  test("renders nothing for non-admin roles (sales)", () => {
    const { container } = render(<CreateOkrForm userRole="sales" onCreated={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  test("renders nothing for unauthenticated / null role", () => {
    const { container } = render(<CreateOkrForm userRole={null} onCreated={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  test("admin sees the +New OKR button which opens the form", () => {
    render(<CreateOkrForm userRole="ceo" onCreated={() => {}} />);
    expect(screen.getByTestId("create-okr-open")).toBeInTheDocument();
    openForm();
    expect(screen.getByTestId("create-okr-form")).toBeInTheDocument();
  });

  test("submit is disabled until quarter + objective + one valid KR are present", () => {
    render(<CreateOkrForm userRole="ceo" onCreated={() => {}} />);
    openForm();
    const submit = screen.getByTestId("create-okr-submit") as HTMLButtonElement;
    // Default quarter is filled; objective + kr metric/target empty → disabled
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("create-okr-objective"), {
      target: { value: "Launch MVP" },
    });
    expect(submit.disabled).toBe(true); // KR still empty
    fireEvent.change(screen.getByTestId("create-okr-kr-0-metric"), {
      target: { value: "signups" },
    });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-target"), {
      target: { value: "100" },
    });
    expect(submit.disabled).toBe(false);
  });

  test("rejects malformed quarter strings", () => {
    render(<CreateOkrForm userRole="ceo" onCreated={() => {}} />);
    openForm();
    fireEvent.change(screen.getByTestId("create-okr-quarter"), {
      target: { value: "Q2-2026" }, // wrong order
    });
    fireEvent.change(screen.getByTestId("create-okr-objective"), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-metric"), {
      target: { value: "m" },
    });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-target"), {
      target: { value: "1" },
    });
    expect((screen.getByTestId("create-okr-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  test("rejects non-numeric target", () => {
    render(<CreateOkrForm userRole="ceo" onCreated={() => {}} />);
    openForm();
    fireEvent.change(screen.getByTestId("create-okr-objective"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-metric"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-target"), { target: { value: "abc" } });
    expect((screen.getByTestId("create-okr-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  test("adds + removes KR rows; the last KR cannot be removed", () => {
    render(<CreateOkrForm userRole="ceo" onCreated={() => {}} />);
    openForm();
    expect(screen.getByTestId("create-okr-kr-0")).toBeInTheDocument();
    expect((screen.getByTestId("create-okr-kr-0-remove") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("create-okr-add-kr"));
    expect(screen.getByTestId("create-okr-kr-1")).toBeInTheDocument();
    // Now that there are 2 KRs, both remove buttons are enabled
    expect((screen.getByTestId("create-okr-kr-0-remove") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("create-okr-kr-1-remove"));
    expect(screen.queryByTestId("create-okr-kr-1")).toBeNull();
  });

  test("POSTs the normalized body and fires onCreated on success", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ okr: { id: "o-1", quarter: "2026-Q2", objective: "x", krs: [] } }),
    });
    const onCreated = jest.fn();
    render(<CreateOkrForm userRole="cto" onCreated={onCreated} />);
    openForm();
    fireEvent.change(screen.getByTestId("create-okr-quarter"), { target: { value: "2026-Q2" } });
    fireEvent.change(screen.getByTestId("create-okr-objective"), {
      target: { value: "Launch MVP" },
    });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-metric"), {
      target: { value: "signups" },
    });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-target"), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-unit"), {
      target: { value: "users" },
    });

    fireEvent.click(screen.getByTestId("create-okr-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/okrs");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.quarter).toBe("2026-Q2");
    expect(body.objective).toBe("Launch MVP");
    expect(body.krs).toEqual([
      { metric: "signups", target: 250, unit: "users", cadence: "weekly" },
    ]);
    // Form closes after success
    expect(screen.queryByTestId("create-okr-form")).toBeNull();
    expect(screen.getByTestId("create-okr-open")).toBeInTheDocument();
  });

  test("surfaces server error body.error on non-ok response", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "objective is required" }),
    });
    const onCreated = jest.fn();
    render(<CreateOkrForm userRole="ceo" onCreated={onCreated} />);
    openForm();
    fireEvent.change(screen.getByTestId("create-okr-objective"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-metric"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-target"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("create-okr-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("create-okr-error")).toHaveTextContent("objective is required"),
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  test("surfaces Network error when fetch throws", async () => {
    mockFetchWithRefresh.mockRejectedValue(new Error("down"));
    render(<CreateOkrForm userRole="ceo" onCreated={() => {}} />);
    openForm();
    fireEvent.change(screen.getByTestId("create-okr-objective"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-metric"), { target: { value: "m" } });
    fireEvent.change(screen.getByTestId("create-okr-kr-0-target"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("create-okr-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("create-okr-error")).toHaveTextContent("Network error"),
    );
  });
});
