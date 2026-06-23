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
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
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
});

describe("/admin/agents: onboard form", () => {
  /**
   * Route GET roster vs POST onboard. `postResult` is what the POST returns;
   * the GET always returns the given roster (refetched after a 201).
   */
  function route(roster: unknown[], postResult: any) {
    mockFetchWithRefresh.mockImplementation((url: unknown, init?: { method?: string }) => {
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

    // A POST fired to the agents endpoint with the form payload.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
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
