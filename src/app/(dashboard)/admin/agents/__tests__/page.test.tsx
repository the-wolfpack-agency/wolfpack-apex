/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the agent-principal roster + onboard page (/admin/agents).
 *
 * Asserts: roster rows render from a mocked fetch, the empty state shows when
 * there are no agents, a 403 surfaces the permission error, and the onboard
 * happy path POSTs the form, shows the one-time secret panel with the
 * shown-once warning, and refetches the roster. A 409 (name taken) and a 400
 * (invalid) surface inline without showing a secret.
 *
 * fetchWithRefresh is mocked and routed by URL + method so the GET roster and
 * POST onboard calls can be asserted independently.
 */

const mockFetchWithRefresh = jest.fn();
const mockPush = jest.fn();
// The authenticated user the page's redirect guard reads. Set to null in the
// auth-redirect test to assert the unauthenticated path.
let mockUser: unknown = { id: "u-cto", role: "admin" };

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: () => mockUser,
}));

// The router object is stable across renders (as the real Next router is), so
// the page's auth-guard effect, keyed on the router identity, does not re-run
// every render.
const mockRouter = { push: mockPush };
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

// next/link renders a plain anchor in jsdom.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import AgentsPage from "@/app/(dashboard)/admin/agents/page";

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

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockPush.mockReset();
  mockUser = { id: "u-cto", role: "admin" };
});

describe("/admin/agents: roster", () => {
  it("renders agent rows with name, role and state chip from the fetch", async () => {
    const agent = makeAgent();
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [agent] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId(`agent-row-${agent.id}`)).toBeInTheDocument(),
    );
    const row = screen.getByTestId(`agent-row-${agent.id}`);
    expect(row).toHaveTextContent("Research Scout");
    expect(row).toHaveTextContent("dev");
    expect(screen.getByTestId(`agent-state-chip-${agent.id}`)).toHaveTextContent("active");
    expect(screen.getByTestId("agents-roster")).toBeInTheDocument();
    // The roster page framing makes clear these are AI principals.
    expect(screen.getByTestId("admin-agents-page")).toHaveTextContent(/AI principals/i);
    expect(screen.getByTestId("admin-agents-page")).toHaveTextContent(/OGIAM/i);
  });

  it("each agent card links into its per-agent detail page", async () => {
    const agent = makeAgent({ id: "ag-link" });
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [agent] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId(`agent-row-${agent.id}`)).toBeInTheDocument(),
    );
    // The card is the navigation into /admin/agents/[id]; the href is exact.
    expect(screen.getByTestId(`agent-row-${agent.id}`)).toHaveAttribute(
      "href",
      `/admin/agents/${agent.id}`,
    );
  });

  it("renders the fleet-overview metric tiles with counts derived from the roster", async () => {
    // Two active, one paused, one invited; one of the active has a connection.
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({
        agents: [
          makeAgent({ id: "a1", state: "active", connections: ["salesforce"] }),
          makeAgent({ id: "a2", state: "active", connections: [] }),
          makeAgent({ id: "a3", state: "paused", connections: [] }),
          makeAgent({ id: "a4", state: "invited", connections: [] }),
        ],
      }),
    );

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agents-fleet-metrics")).toBeInTheDocument(),
    );
    // Count-up animates from 0 to the real value; assert the final value lands.
    await waitFor(() =>
      expect(screen.getByTestId("fleet-metric-total")).toHaveTextContent("4"),
    );
    expect(screen.getByTestId("fleet-metric-active")).toHaveTextContent("2");
    expect(screen.getByTestId("fleet-metric-paused")).toHaveTextContent("1");
    expect(screen.getByTestId("fleet-metric-invited")).toHaveTextContent("1");
    expect(screen.getByTestId("fleet-metric-connected")).toHaveTextContent("1");
    // The fleet panel carries an activity sparkline (real trend data only).
    expect(screen.getByTestId("fleet-trend-sparkline")).toBeInTheDocument();
  });

  it("renders the agent's bound services as chips when it has connections", async () => {
    const agent = makeAgent({ id: "ag-sf", connections: ["salesforce", "jira"] });
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [agent] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-services-ag-sf")).toBeInTheDocument(),
    );
    const services = screen.getByTestId("agent-services-ag-sf");
    expect(services).toHaveTextContent("salesforce");
    expect(services).toHaveTextContent("jira");
    // The chips are the services, not the no-service hint.
    expect(services).not.toHaveTextContent(/no service/i);
  });

  it("shows the no-service hint for an agent with no connections", async () => {
    const agent = makeAgent({ id: "ag-bare", connections: [] });
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [agent] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-services-ag-bare")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("agent-services-ag-bare")).toHaveTextContent(/no service/i);
  });

  it("links to the shared agent-memory view", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("agents-memory-link")).toBeInTheDocument(),
    );
    const link = screen.getByTestId("agents-memory-link");
    expect(link).toHaveTextContent(/shared memory/i);
    expect(link).toHaveAttribute("href", "/admin/agents/memory");
  });

  it("renders the empty state when there are no agents", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() => expect(screen.getByTestId("agents-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("agent-row-ag-1")).not.toBeInTheDocument();
  });

  it("surfaces a permission error on a 403", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({}, { ok: false, status: 403 }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() => expect(screen.getByTestId("agents-error")).toBeInTheDocument());
    expect(screen.getByTestId("agents-error")).toHaveTextContent(/permission/i);
  });

  it("redirects an unauthenticated visitor to /login and does not fetch the roster", async () => {
    mockUser = null;
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/agents");
    // The guard returns before loading, so no roster fetch fires.
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  it("nav actions row wraps and carries the mobile full-width rule so the buttons never overflow the right edge", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() => expect(screen.getByTestId("agents-nav-actions")).toBeInTheDocument());
    const nav = screen.getByTestId("agents-nav-actions");
    // The row wraps onto the next line instead of clipping the rightmost
    // control, and carries the class the mobile media query targets.
    expect(nav.style.flexWrap).toBe("wrap");
    expect(nav.className).toContain("wp-agents-nav");
    // Every existing nav control is preserved inside the wrapping row.
    expect(screen.getByTestId("agents-approvals-link")).toBeInTheDocument();
    expect(screen.getByTestId("agents-platform-scans-link")).toBeInTheDocument();
    expect(screen.getByTestId("agents-connectors-link")).toBeInTheDocument();
    expect(screen.getByTestId("agents-memory-link")).toBeInTheDocument();
    // The mobile rule that stacks the nav buttons full-width is in the document.
    const styleText = document.head.innerHTML + document.body.innerHTML;
    expect(styleText).toContain("max-width:480px");
    expect(styleText).toContain(".wp-agents-nav");
  });
});

describe("/admin/agents: engagement analytics", () => {
  // Every analytics POST the page fires through fetchWithRefresh -> /api/analytics.
  const analyticsBodies = () =>
    mockFetchWithRefresh.mock.calls
      .filter(
        (c) =>
          String(c[0]) === "/api/analytics" &&
          (c[1] as { method?: string } | undefined)?.method === "POST",
      )
      .map((c) => JSON.parse(String((c[1] as { body: string }).body)));

  it("fires agent.fleet_viewed ONCE after a successful roster load with the lifecycle buckets", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({
        agents: [
          makeAgent({ id: "a1", state: "active", connections: ["salesforce"] }),
          makeAgent({ id: "a2", state: "active", connections: [] }),
          makeAgent({ id: "a3", state: "paused", connections: [] }),
          makeAgent({ id: "a4", state: "invited", connections: [] }),
        ],
      }),
    );

    await act(async () => {
      render(<AgentsPage />);
    });

    await waitFor(() =>
      expect(analyticsBodies().filter((b) => b.event === "agent.fleet_viewed").length).toBe(1),
    );
    const viewed = analyticsBodies().find((b) => b.event === "agent.fleet_viewed");
    expect(viewed.metadata).toEqual({ total: 4, active: 2, paused: 1, invited: 1, connected: 1 });
  });

  it("does NOT re-fire agent.fleet_viewed when the roster refetches (Refresh)", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [makeAgent({ id: "a1" })] }));

    await act(async () => {
      render(<AgentsPage />);
    });
    await waitFor(() =>
      expect(analyticsBodies().filter((b) => b.event === "agent.fleet_viewed").length).toBe(1),
    );

    // Refresh refetches the roster; fleet_viewed must stay at exactly one.
    await act(async () => {
      fireEvent.click(screen.getByText("Refresh"));
    });
    await waitFor(() =>
      expect(mockFetchWithRefresh.mock.calls.filter((c) => (c[1] as any)?.method !== "POST").length).toBeGreaterThanOrEqual(2),
    );
    expect(analyticsBodies().filter((b) => b.event === "agent.fleet_viewed").length).toBe(1);
  });

  it("fires agent.detail_opened with the agent id + state when a card is clicked", async () => {
    const agent = makeAgent({ id: "ag-open", state: "paused" });
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [agent] }));

    await act(async () => {
      render(<AgentsPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`agent-row-${agent.id}`)).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId(`agent-row-${agent.id}`));
    });

    const opened = analyticsBodies().find((b) => b.event === "agent.detail_opened");
    expect(opened).toBeTruthy();
    expect(opened.metadata).toEqual({ agent_id: "ag-open", state: "paused" });
  });

  it("fires NO analytics on the auth-redirect (logged-out) path", async () => {
    mockUser = null;
    mockFetchWithRefresh.mockResolvedValue(mkRes({ agents: [] }));

    await act(async () => {
      render(<AgentsPage />);
    });

    expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/agents");
    // The guard returns before loading, so neither roster nor analytics fire.
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });
});

describe("/admin/agents: onboard form", () => {
  /**
   * Route GET roster vs POST onboard. `postResult` is what the POST returns;
   * the GET always returns the given roster (refetched after a 201).
   */
  function route(roster: unknown[], postResult: any) {
    mockFetchWithRefresh.mockImplementation((url: unknown, init?: { method?: string }) => {
      // Engagement analytics (fleet_viewed) fires its own fire-and-forget POST to
      // /api/analytics; keep it distinct from the onboard POST so it never gets
      // the onboard result and the onboard assertions stay precise.
      if (String(url) === "/api/analytics") return Promise.resolve(mkRes({ ok: true }));
      if (init?.method === "POST") return Promise.resolve(postResult);
      return Promise.resolve(mkRes({ agents: roster }));
    });
  }

  it("submitting the form shows the one-time secret panel and refetches the roster", async () => {
    const created = makeAgent({ id: "ag-new", name: "New Agent", state: "invited" });
    route(
      [created],
      mkRes({ agent: created, onboarding_secret: "sek_one_time_abc123" }, { status: 201 }),
    );

    await act(async () => {
      render(<AgentsPage />);
    });
    // initial roster load (empty list path still shows form)
    await waitFor(() =>
      expect(screen.getByTestId("agent-onboard-form")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-onboard-name"), {
        target: { value: "New Agent" },
      });
      fireEvent.change(screen.getByTestId("agent-onboard-role"), {
        target: { value: "ops" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-onboard-submit"));
    });

    // The one-time secret panel appears with the value and the shown-once warning.
    const panel = await screen.findByTestId("agent-onboarding-secret");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId("agent-onboarding-secret-value")).toHaveTextContent(
      "sek_one_time_abc123",
    );
    expect(screen.getByTestId("agent-onboarding-secret-warning")).toHaveTextContent(
      /shown once/i,
    );
    expect(screen.getByTestId("agent-onboarding-secret-copy")).toBeInTheDocument();

    // A POST fired to the agents endpoint with the form payload (the analytics
    // beacon also POSTs, so scope the lookup to the agents endpoint).
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/agents"),
    );
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toContain("/api/admin/agents");
    const body = JSON.parse((post?.[1] as { body: string }).body);
    expect(body.name).toBe("New Agent");
    expect(body.role).toBe("ops");

    // The roster refetched after the 201 (at least one GET after the POST).
    const gets = mockFetchWithRefresh.mock.calls.filter(
      (c) => (c[1] as { method?: string } | undefined)?.method !== "POST",
    );
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a name-taken error on a 409 and shows no secret", async () => {
    route([], mkRes({ error: "name_taken" }, { ok: false, status: 409 }));

    await act(async () => {
      render(<AgentsPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("agent-onboard-form")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-onboard-name"), {
        target: { value: "Dup" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-onboard-submit"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-onboard-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("agent-onboard-error")).toHaveTextContent(/already taken/i);
    expect(screen.queryByTestId("agent-onboarding-secret")).not.toBeInTheDocument();
  });

  it("surfaces an inline error on a 400 invalid", async () => {
    route([], mkRes({ error: "role_invalid" }, { ok: false, status: 400 }));

    await act(async () => {
      render(<AgentsPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("agent-onboard-form")).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-onboard-name"), {
        target: { value: "Bad" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-onboard-submit"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-onboard-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("agent-onboard-error")).toHaveTextContent(/invalid/i);
    expect(screen.queryByTestId("agent-onboarding-secret")).not.toBeInTheDocument();
  });
});
