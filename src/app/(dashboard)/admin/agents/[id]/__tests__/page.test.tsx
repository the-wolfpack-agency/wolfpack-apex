/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the agent-principal profile page (/admin/agents/[id]).
 *
 * Asserts: the profile renders identity + role + owner + state + scan status
 * from the mocked GET, the 404 state shows when the agent is missing, the
 * revoke lifecycle action arms an inline confirm then fires a PATCH with
 * { action: "revoke" } and reflects the returned state, and the activity link
 * is present (pointing at the agent-filtered OGIAM explorer) so an operator can
 * jump to the agent's gated actions.
 *
 * The page fires TWO GETs on mount: the agent fetch (/api/admin/agents/{id})
 * and the self-onboarding scan fetch (/api/admin/agents/{id}/scan). The mock is
 * routed by URL so the scan can be present, absent (404 no_scan), or errored
 * independently of the agent load.
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

function makeScan(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "scan-1",
    agentId: "ag-1",
    workspaceId: "default",
    scanVersion: "v1",
    toolCount: 3,
    allowedToolCount: 2,
    capabilityCount: 2,
    createdAt: new Date().toISOString(),
    model: {
      capabilities: ["mail.read", "calendar.read"],
      tools: [
        { name: "search_mail", description: "Search mail", capability: "mail.read", isMutation: false, allowed: true },
        { name: "create_event", description: "Create event", capability: "calendar.write", isMutation: true, allowed: true },
        { name: "send_mail", description: "Send mail", capability: "mail.send", isMutation: true, allowed: false },
      ],
      summary: { toolCount: 3, allowedToolCount: 2, mutationCount: 2, capabilityCount: 2 },
    },
    ...over,
  };
}

const SCAN_PATH = "/scan";

/**
 * Routes the mock by URL: the page fires the agent GET and the scan GET on
 * mount. `agent` is the response for /api/admin/agents/{id} (and any PATCH),
 * `scan` is the response for /api/admin/agents/{id}/scan.
 */
function routeByUrl(opts: {
  agent: () => any;
  scan: () => any;
  onPatch?: () => any;
}) {
  return (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    if (init?.method === "PATCH" && opts.onPatch) return Promise.resolve(opts.onPatch());
    if (u.endsWith(SCAN_PATH)) return Promise.resolve(opts.scan());
    return Promise.resolve(opts.agent());
  };
}

const params = Promise.resolve({ id: "ag-1" });

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/admin/agents/[id]: profile", () => {
  it("renders identity, role, owner, state and scan status from the fetch", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
      }),
    );

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
    // The bridge to the OGIAM decision explorer, filtered to this agent.
    const link = screen.getByTestId("agent-activity-link");
    expect(link).toHaveAttribute("href", "/admin/ogiam?agent=ag-1");
    expect(link).toHaveTextContent(/gated actions/i);
  });

  it("renders the not-found state on a 404", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({}, { ok: false, status: 404 }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-not-found")).toBeInTheDocument());
    expect(screen.queryByTestId("agent-name")).not.toBeInTheDocument();
  });

  it("revoke arms an inline confirm then PATCHes { action: revoke } and reflects the new state", async () => {
    const active = makeAgent({ state: "active" });
    const revoked = makeAgent({ state: "revoked", revokedAt: new Date().toISOString() });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: active }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        onPatch: () => mkRes({ agent: revoked }),
      }),
    );

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

describe("/admin/agents/[id]: system model (self-onboarding scan)", () => {
  it("renders the summary line and only the allowed tools when a scan is present", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({ scan: makeScan() }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-scan-summary")).toBeInTheDocument(),
    );

    // Summary reflects the scan model's summary counts.
    const summary = screen.getByTestId("agent-scan-summary");
    expect(summary).toHaveTextContent(/Learned/i);
    expect(summary).toHaveTextContent("3");
    expect(summary).toHaveTextContent("2");

    // Allowed tools appear in the list.
    const tools = screen.getByTestId("agent-scan-tools");
    expect(tools).toHaveTextContent("search_mail");
    expect(tools).toHaveTextContent("create_event");

    // The disallowed tool is NOT rendered in the allowed list.
    expect(tools).not.toHaveTextContent("send_mail");
    expect(screen.queryByTestId("agent-scan-tool-send_mail")).not.toBeInTheDocument();

    // The one hidden (disallowed) tool is acknowledged.
    expect(screen.getByTestId("agent-scan-hidden-note")).toHaveTextContent(/1 more/i);

    // The empty state must not show when a scan is present.
    expect(screen.queryByTestId("agent-scan-empty")).not.toBeInTheDocument();
  });

  it("renders the calm empty state when the agent has no scan yet (404 no_scan)", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({ error: "no_scan" }, { ok: false, status: 404 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-scan-empty")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("agent-scan-empty")).toHaveTextContent(
      /has not run its onboarding scan yet/i,
    );
    expect(screen.queryByTestId("agent-scan-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-scan-tools")).not.toBeInTheDocument();
  });

  it("points the activity link at the agent-filtered OGIAM explorer", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({ scan: makeScan() }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-activity-link")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("agent-activity-link")).toHaveAttribute(
      "href",
      "/admin/ogiam?agent=ag-1",
    );
  });
});
