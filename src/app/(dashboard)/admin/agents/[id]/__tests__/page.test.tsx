/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the agent-principal profile page (/admin/agents/[id]).
 *
 * Asserts: the profile renders identity + role + owner + state + scan status
 * from the mocked GET, the 404 state shows when the agent is missing, the
 * revoke lifecycle action arms an inline confirm then fires a PATCH with
 * { action: "revoke" } and reflects the returned state, and the OGIAM link is
 * present so an operator can jump to the agent's gated actions.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import AgentProfilePage from "@/app/(dashboard)/admin/agents/[id]/page";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

function makeAgent(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ag-1",
    workspaceId: "default",
    name: "Research Scout",
    role: "dev",
    ownerUserId: "u-cto",
    state: "active",
    identityProvider: "instinct",
    externalSubject: "sub-123",
    scanStatus: "complete",
    description: "Scouts research sources",
    createdBy: "u-cto",
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    revokedAt: null,
    ...over,
  };
}

const params = Promise.resolve({ id: "ag-1" });

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/admin/agents/[id]: profile", () => {
  it("renders identity, role, owner, state and scan status from the fetch", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agent: makeAgent() }));

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-name")).toBeInTheDocument());
    expect(screen.getByTestId("agent-name")).toHaveTextContent("Research Scout");
    expect(screen.getByTestId("agent-id")).toHaveTextContent("ag-1");
    expect(screen.getByTestId("agent-identity-provider")).toHaveTextContent("instinct");
    expect(screen.getByTestId("agent-external-subject")).toHaveTextContent("sub-123");
    expect(screen.getByTestId("agent-role")).toHaveTextContent("DEV");
    expect(screen.getByTestId("agent-owner")).toHaveTextContent("u-cto");
    expect(screen.getByTestId("agent-scan-status")).toHaveTextContent(/complete/i);
    expect(screen.getByTestId("agent-state-chip")).toHaveTextContent("active");
    // The bridge to the OGIAM decision explorer.
    const link = screen.getByTestId("agent-ogiam-link");
    expect(link).toHaveAttribute("href", "/admin/ogiam");
    expect(link).toHaveTextContent(/gated actions/i);
  });

  it("renders the not-found state on a 404", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({}, { ok: false, status: 404 }));

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-not-found")).toBeInTheDocument());
    expect(screen.queryByTestId("agent-name")).not.toBeInTheDocument();
  });

  it("revoke arms an inline confirm then PATCHes { action: revoke } and reflects the new state", async () => {
    const active = makeAgent({ state: "active" });
    const revoked = makeAgent({ state: "revoked", revokedAt: new Date().toISOString() });
    mockFetchWithRefresh.mockImplementation((url: unknown, init?: { method?: string }) => {
      if (init?.method === "PATCH") return Promise.resolve(mkRes({ agent: revoked }));
      return Promise.resolve(mkRes({ agent: active }));
    });

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-revoke")).toBeInTheDocument());

    // First click arms the confirm; no PATCH yet.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-revoke"));
    });
    expect(screen.getByTestId("agent-revoke-confirm")).toBeInTheDocument();
    expect(
      mockFetchWithRefresh.mock.calls.some(
        (c) => (c[1] as { method?: string } | undefined)?.method === "PATCH",
      ),
    ).toBe(false);

    // Confirm fires the PATCH.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-revoke-confirm-yes"));
    });

    await waitFor(() => expect(screen.getByTestId("agent-revoked-note")).toBeInTheDocument());

    const patch = mockFetchWithRefresh.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "PATCH",
    );
    expect(patch).toBeTruthy();
    expect(String(patch?.[0])).toContain("/api/admin/agents/ag-1");
    const body = JSON.parse((patch?.[1] as { body: string }).body);
    expect(body.action).toBe("revoke");

    // State chip now reads revoked; revoke button gone.
    expect(screen.getByTestId("agent-state-chip")).toHaveTextContent("revoked");
    expect(screen.queryByTestId("agent-revoke")).not.toBeInTheDocument();
  });
});
