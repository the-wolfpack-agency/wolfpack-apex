/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the OGIAM decision explorer page.
 *
 * Asserts: summary header + decision rows render from a mocked fetch, the empty
 * state shows when there are no decisions, the would-block filter toggle
 * triggers a refetch carrying would_block=1, and the notarization banner
 * renders the verified-and-signed, verified-but-not-notarized, and failed
 * states from the /api/admin/ogiam/verify fetch.
 *
 * The page fires two independent fetches on mount (decisions + verify). The
 * helper below routes each mocked response by URL so the two effects can race
 * without flaking.
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

const verifiedSignedChain = {
  workspace_id: "default",
  verification: {
    ok: true,
    verifiedCount: 12,
    legacyCount: 0,
    brokenAtSeq: null,
    headSeq: 12,
    headHash: "abc",
  },
  checkpoint: {
    id: "cp-1",
    workspaceId: "default",
    throughSeq: 10,
    headHash: "abc",
    algorithm: "ES256",
    keyId: "https://vault.azure.net/keys/ogiam-key",
    signed: true,
    signedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  },
};

/**
 * Route mocked responses by URL so the decisions + verify effects can resolve
 * in any order. `verify` is the verification body (or null to suppress the
 * banner via a non-ok response); `decisions` is the decisions body.
 */
function routeFetch(decisions: unknown, verify: unknown | "fail") {
  mockFetchWithRefresh.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes("/api/admin/ogiam/verify")) {
      return Promise.resolve(
        verify === "fail" ? mkRes({}, { ok: false, status: 500 }) : mkRes(verify),
      );
    }
    return Promise.resolve(mkRes(decisions));
  });
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

describe("/admin/ogiam: decision explorer", () => {
  it("renders the summary header and decision rows from the fetch", async () => {
    routeFetch(
      { workspace_id: "default", summary: sampleSummary, decisions: [sampleRow] },
      "fail",
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
    routeFetch(
      {
        workspace_id: "default",
        summary: { total: 0, would_block: 0, by_tier: {}, by_outcome: {} },
        decisions: [],
      },
      "fail",
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
    // The verify fetch fires alongside the decisions fetch; route by URL so the
    // toggle assertion looks only at the /decisions calls.
    routeFetch(
      { workspace_id: "default", summary: sampleSummary, decisions: [sampleRow] },
      "fail",
    );
    const decisionCalls = () =>
      mockFetchWithRefresh.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/admin/ogiam/decisions"));

    await act(async () => {
      render(<OgiamPage />);
    });
    await waitFor(() => expect(decisionCalls()).toHaveLength(1));
    // Initial decisions fetch carries no would_block filter.
    expect(decisionCalls()[0]).not.toContain("would_block=1");

    await act(async () => {
      fireEvent.click(screen.getByTestId("ogiam-filter-would-block"));
    });

    await waitFor(() => expect(decisionCalls()).toHaveLength(2));
    expect(decisionCalls()[1]).toContain("would_block=1");
  });

  it("renders an error state on a 403", async () => {
    mockFetchWithRefresh.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/api/admin/ogiam/verify")) {
        return Promise.resolve(mkRes({}, { ok: false, status: 500 }));
      }
      return Promise.resolve(mkRes({}, { ok: false, status: 403 }));
    });

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("ogiam-decisions-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ogiam-decisions-error")).toHaveTextContent(/permission/i);
  });
});

describe("/admin/ogiam: notarization banner", () => {
  const decisionsBody = {
    workspace_id: "default",
    summary: { total: 0, would_block: 0, by_tier: {}, by_outcome: {} },
    decisions: [],
  };

  it("verified and signed: shows verified counts and the notarized line", async () => {
    routeFetch(decisionsBody, verifiedSignedChain);

    await act(async () => {
      render(<OgiamPage />);
    });

    const banner = await screen.findByTestId("ogiam-chain-status");
    expect(banner).toHaveTextContent(/Chain verified: 12 decisions, head sequence 12/i);
    expect(banner).toHaveTextContent(/Notarized through sequence 10/i);
    // Key id is shortened to the trailing segment, not the full vault URL.
    expect(banner).toHaveTextContent(/ogiam-key/);
    expect(banner).not.toHaveTextContent(/vault\.azure\.net/);
  });

  it("verified but not notarized: shows the tamper-evident line", async () => {
    routeFetch(decisionsBody, {
      workspace_id: "default",
      verification: {
        ok: true,
        verifiedCount: 3,
        legacyCount: 0,
        brokenAtSeq: null,
        headSeq: 3,
        headHash: "h3",
      },
      checkpoint: { ...verifiedSignedChain.checkpoint, signed: false, signedAt: null },
    });

    await act(async () => {
      render(<OgiamPage />);
    });

    const banner = await screen.findByTestId("ogiam-chain-status");
    expect(banner).toHaveTextContent(/Chain verified: 3 decisions/i);
    expect(banner).toHaveTextContent(/Tamper-evident, notarization not yet configured/i);
    expect(banner).not.toHaveTextContent(/Notarized through/i);
  });

  it("no checkpoint yet: shows the tamper-evident line", async () => {
    routeFetch(decisionsBody, {
      workspace_id: "default",
      verification: {
        ok: true,
        verifiedCount: 1,
        legacyCount: 0,
        brokenAtSeq: null,
        headSeq: 1,
        headHash: "h1",
      },
      checkpoint: null,
    });

    await act(async () => {
      render(<OgiamPage />);
    });

    const banner = await screen.findByTestId("ogiam-chain-status");
    expect(banner).toHaveTextContent(/Tamper-evident, notarization not yet configured/i);
  });

  it("integrity failed: shows the red FAILED warning at the broken sequence", async () => {
    routeFetch(decisionsBody, {
      workspace_id: "default",
      verification: {
        ok: false,
        verifiedCount: 4,
        legacyCount: 0,
        brokenAtSeq: 5,
        headSeq: 7,
        headHash: "h7",
      },
      checkpoint: null,
    });

    await act(async () => {
      render(<OgiamPage />);
    });

    const banner = await screen.findByTestId("ogiam-chain-status");
    expect(banner).toHaveTextContent(/Chain integrity check FAILED at sequence 5/i);
    expect(banner).not.toHaveTextContent(/Chain verified/i);
  });

  it("hides the banner when the verify fetch fails", async () => {
    routeFetch(decisionsBody, "fail");

    await act(async () => {
      render(<OgiamPage />);
    });

    // Decisions empty-state lands; the banner stays absent.
    await waitFor(() =>
      expect(screen.getByTestId("ogiam-decisions-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("ogiam-chain-status")).not.toBeInTheDocument();
  });
});
