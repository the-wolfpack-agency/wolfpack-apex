/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ArchiveOkrButton from "@/components/goals/ArchiveOkrButton";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("ArchiveOkrButton", () => {
  test("hidden for non-admin roles", () => {
    const { container } = render(
      <ArchiveOkrButton okrId="o1" userRole="dev" onArchived={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  test("admin sees trigger and a confirm step before DELETE fires", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ okr: { id: "o1", status: "archived" } }),
    });
    const onArchived = jest.fn();
    render(<ArchiveOkrButton okrId="o1" userRole="ceo" onArchived={onArchived} />);

    fireEvent.click(screen.getByTestId("archive-okr-open-o1"));
    expect(screen.getByTestId("archive-okr-confirm-o1")).toBeInTheDocument();
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("archive-okr-submit-o1"));
    await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/goals/okrs/o1");
    expect(init.method).toBe("DELETE");
  });

  test("cancel button aborts without hitting the API", () => {
    render(<ArchiveOkrButton okrId="o1" userRole="cto" onArchived={() => {}} />);
    fireEvent.click(screen.getByTestId("archive-okr-open-o1"));
    fireEvent.click(screen.getByTestId("archive-okr-cancel-o1"));
    expect(screen.queryByTestId("archive-okr-confirm-o1")).toBeNull();
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  test("surfaces server error on non-ok", async () => {
    mockFetchWithRefresh.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "okr_not_found" }),
    });
    render(<ArchiveOkrButton okrId="gone" userRole="ceo" onArchived={() => {}} />);
    fireEvent.click(screen.getByTestId("archive-okr-open-gone"));
    fireEvent.click(screen.getByTestId("archive-okr-submit-gone"));
    await waitFor(() =>
      expect(screen.getByTestId("archive-okr-error-gone")).toHaveTextContent("okr_not_found"),
    );
  });
});
