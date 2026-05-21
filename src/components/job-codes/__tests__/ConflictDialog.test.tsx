/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * Pins the ConflictDialog UI:
 *   1. Renders null when conflicts is null / empty
 *   2. Renders one row per conflict
 *   3. Clicking the three buttons calls onResolve with the right choice
 *      AND fires `system.job_code_conflict_resolved` analytics
 *   4. Escape key = cancel
 *   5. Backdrop click = cancel
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { fireEvent, render, screen } from "@testing-library/react";
import { ConflictDialog, type ConflictRow } from "@/components/job-codes/ConflictDialog";

const sample: ConflictRow[] = [
  {
    column: "PO Number",
    currentValue: "PO-99",
    expectedValue: "PO-1",
    requestedValue: "PO-2",
  },
];

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("<ConflictDialog />", () => {
  it("renders nothing when conflicts is null", () => {
    render(<ConflictDialog code="X" conflicts={null} onResolve={jest.fn()} />);
    expect(screen.queryByTestId("conflict-dialog")).not.toBeInTheDocument();
  });

  it("renders nothing when conflicts is empty", () => {
    render(<ConflictDialog code="X" conflicts={[]} onResolve={jest.fn()} />);
    expect(screen.queryByTestId("conflict-dialog")).not.toBeInTheDocument();
  });

  it("renders one row per conflict and shows current/requested values", () => {
    render(<ConflictDialog code="WPA-1" conflicts={sample} onResolve={jest.fn()} />);
    expect(screen.getByTestId("conflict-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-row-PO Number")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-current-PO Number").textContent).toBe("PO-99");
    expect(screen.getByTestId("conflict-requested-PO Number").textContent).toBe("PO-2");
  });

  it("renders the recentEditorHint verbatim when provided", () => {
    render(
      <ConflictDialog
        code="WPA-1"
        conflicts={sample}
        recentEditorHint="Hoxsie set PO Number to PO-99 18s ago."
        onResolve={jest.fn()}
      />,
    );
    expect(screen.getByTestId("conflict-dialog-hint").textContent).toMatch(/Hoxsie set PO Number to PO-99 18s ago/);
  });

  it.each([
    ["conflict-keep-theirs", "keep_theirs"],
    ["conflict-cancel", "cancel"],
    ["conflict-overwrite", "overwrite"],
  ])("button %p calls onResolve with %p AND fires the resolution analytics", (testid, expected) => {
    mockFetchWithRefresh.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const onResolve = jest.fn();
    render(<ConflictDialog code="WPA-1" conflicts={sample} onResolve={onResolve} />);
    fireEvent.click(screen.getByTestId(testid));
    expect(onResolve).toHaveBeenCalledWith(expected);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(`"resolved_as":"${expected}"`),
      }),
    );
  });

  it("Escape key triggers cancel + analytics", () => {
    mockFetchWithRefresh.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const onResolve = jest.fn();
    render(<ConflictDialog code="WPA-1" conflicts={sample} onResolve={onResolve} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onResolve).toHaveBeenCalledWith("cancel");
  });
});
