/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the OGIAM decision explorer page.
 *
 * Asserts: summary header + decision rows render from a mocked fetch, the empty
 * state shows when there are no decisions, and the would-block filter toggle
 * triggers a refetch carrying would_block=1.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import OgiamPage from "@/app/(dashboard)/admin/ogiam/page";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

const sampleSummary = {
  total: 4,
  would_block: 1,
  by_tier: { low: 2, high: 1, critical: 1 },
  by_outcome: { allow: 3, deny: 1 },
};

const sampleRow = {
  id: "dec-abc123",
  created_at: new Date().toISOString(),
  principal_agent: "assistant",
  on_behalf_user_id: "u-1",
  on_behalf_role: "cto",
  tool: "mail.send",
  capability: "mail.send",
  is_mutation: true,
  surface: "/assistant",
  risk_tier: "high",
  intended_outcome: "deny",
  effective_outcome: "allow",
  enforced: false,
  would_block: true,
  rule_id: "R-001",
  reason: "high-risk mutation",
  policy_version: "v0",
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/admin/ogiam — decision explorer", () => {
  it("renders the summary header and decision rows from the fetch", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({ workspace_id: "default", summary: sampleSummary, decisions: [sampleRow] }),
    );

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId(`ogiam-decision-row-${sampleRow.id}`)).toBeInTheDocument(),
    );

    // Summary surfaces total + would-block + the shadow-mode framing.
    expect(screen.getByTestId("ogiam-summary-total")).toHaveTextContent("4");
    expect(screen.getByTestId("ogiam-summary-would-block")).toHaveTextContent("1");
    expect(screen.getByTestId("ogiam-shadow-banner")).toHaveTextContent(/shadow mode/i);
    expect(screen.getByTestId("ogiam-tier-count-high")).toBeInTheDocument();

    // Row surfaces tool, the would-block badge, the tier chip and the rule id.
    const row = screen.getByTestId(`ogiam-decision-row-${sampleRow.id}`);
    expect(row).toHaveTextContent("mail.send");
    expect(screen.getByTestId(`ogiam-would-block-badge-${sampleRow.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ogiam-tier-chip-${sampleRow.id}`)).toHaveTextContent("high");
    expect(screen.getByTestId(`ogiam-rule-${sampleRow.id}`)).toHaveTextContent("R-001");
  });

  it("renders the empty state when there are no decisions", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      mkRes({
        workspace_id: "default",
        summary: { total: 0, would_block: 0, by_tier: {}, by_outcome: {} },
        decisions: [],
      }),
    );

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("ogiam-decisions-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId(`ogiam-decision-row-${sampleRow.id}`)).not.toBeInTheDocument();
  });

  it("the would-block filter triggers a refetch with would_block=1", async () => {
    // First load (no filter), then the refetch after the toggle.
    mockFetchWithRefresh
      .mockResolvedValueOnce(
        mkRes({ workspace_id: "default", summary: sampleSummary, decisions: [sampleRow] }),
      )
      .mockResolvedValueOnce(
        mkRes({ workspace_id: "default", summary: sampleSummary, decisions: [sampleRow] }),
      );

    await act(async () => {
      render(<OgiamPage />);
    });
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    // Initial fetch carries no would_block filter.
    expect(String(mockFetchWithRefresh.mock.calls[0][0])).not.toContain("would_block=1");

    await act(async () => {
      fireEvent.click(screen.getByTestId("ogiam-filter-would-block"));
    });

    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2));
    expect(String(mockFetchWithRefresh.mock.calls[1][0])).toContain("would_block=1");
  });

  it("renders an error state on a 403", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(mkRes({}, { ok: false, status: 403 }));

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("ogiam-decisions-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ogiam-decisions-error")).toHaveTextContent(/permission/i);
  });
});
