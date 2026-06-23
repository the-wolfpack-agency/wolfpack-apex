/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the shared agent-memory page (/admin/agents/memory).
 *
 * Asserts: a promoted row (with its reuse/hit count) and a quarantined row
 * render with the correct status chips; the plan expands to show its steps; a
 * human promote on the quarantined row PATCHes the API and the row reflects
 * the promoted status in place; the status filter refetches with ?status; a
 * rejected row renders its reject reason; and the empty state shows when there
 * is no memory.
 *
 * fetchWithRefresh is mocked and routed by URL + method so the GET list and
 * the PATCH override calls can be asserted independently.
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
import AgentMemoryPage from "@/app/(dashboard)/admin/agents/memory/page";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

function makeEntry(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "mem-1",
    workspaceId: "default",
    goalKey: "draft-weekly-brief",
    goal: "Draft the weekly client brief from the latest meeting notes",
    plan: [
      { instruction: "Pull the latest meeting notes", tool: "onenote.read" },
      { instruction: "Summarize into a brief", tool: "assistant.summarize" },
    ],
    status: "promoted",
    learnedByAgent: "Research Scout",
    sourceTaskId: "task-9",
    hitCount: 7,
    rejectReason: null,
    createdAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/admin/agents/memory: list", () => {
  it("renders a promoted row with its reuse count and a quarantined row with correct chips", async () => {
    const promoted = makeEntry();
    const quarantined = makeEntry({
      id: "mem-2",
      goal: "Reconcile the QuickBooks invoice export",
      status: "quarantined",
      learnedByAgent: "Ops Helper",
      hitCount: 0,
    });
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ workspace_id: "default", memory: [promoted, quarantined] }),
    );

    await act(async () => {
      render(<AgentMemoryPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId(`memory-row-${promoted.id}`)).toBeInTheDocument(),
    );

    // Framing makes the inheritance + safety-gate model clear.
    const page = screen.getByTestId("admin-agent-memory-page");
    expect(page).toHaveTextContent(/shared procedural memory/i);
    expect(page).toHaveTextContent(/inherit/i);

    // Promoted row: green chip, learned-by, and the reuse/hit count signal.
    expect(screen.getByTestId(`memory-status-chip-${promoted.id}`)).toHaveTextContent("promoted");
    const promotedRow = screen.getByTestId(`memory-row-${promoted.id}`);
    expect(promotedRow).toHaveTextContent("Research Scout");
    expect(screen.getByTestId(`memory-hits-${promoted.id}`)).toHaveTextContent(/reused 7 times/i);

    // Quarantined row: amber chip.
    expect(screen.getByTestId(`memory-status-chip-${quarantined.id}`)).toHaveTextContent(
      "quarantined",
    );
    expect(screen.getByTestId("memory-list")).toBeInTheDocument();
  });

  it("renders a rejected row with its reject reason", async () => {
    const rejected = makeEntry({
      id: "mem-r",
      status: "rejected",
      rejectReason: "calls a destructive tool without confirmation",
    });
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ workspace_id: "default", memory: [rejected] }),
    );

    await act(async () => {
      render(<AgentMemoryPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId(`memory-status-chip-${rejected.id}`)).toHaveTextContent(
        "rejected",
      ),
    );
    expect(screen.getByTestId(`memory-reject-reason-${rejected.id}`)).toHaveTextContent(
      /calls a destructive tool/i,
    );
    // A rejected row offers promote (override up) but not another reject.
    expect(screen.getByTestId(`memory-promote-${rejected.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`memory-reject-${rejected.id}`)).not.toBeInTheDocument();
  });

  it("expands the plan to show its instruction + tool steps", async () => {
    const entry = makeEntry();
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ workspace_id: "default", memory: [entry] }),
    );

    await act(async () => {
      render(<AgentMemoryPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`memory-expand-${entry.id}`)).toBeInTheDocument(),
    );

    // Plan is collapsed by default.
    expect(screen.queryByTestId(`memory-plan-${entry.id}`)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId(`memory-expand-${entry.id}`));
    });

    const plan = screen.getByTestId(`memory-plan-${entry.id}`);
    expect(plan).toBeInTheDocument();
    expect(screen.getByTestId(`memory-plan-step-${entry.id}-0`)).toHaveTextContent(
      "Pull the latest meeting notes",
    );
    expect(screen.getByTestId(`memory-plan-step-${entry.id}-0`)).toHaveTextContent("onenote.read");
    expect(screen.getByTestId(`memory-plan-step-${entry.id}-1`)).toHaveTextContent(
      "assistant.summarize",
    );
  });

  it("renders the empty state when there is no memory", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ workspace_id: "default", memory: [] }));

    await act(async () => {
      render(<AgentMemoryPage />);
    });

    await waitFor(() => expect(screen.getByTestId("memory-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("memory-row-mem-1")).not.toBeInTheDocument();
  });

  it("surfaces a permission error on a 403", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({}, { ok: false, status: 403 }));

    await act(async () => {
      render(<AgentMemoryPage />);
    });

    await waitFor(() => expect(screen.getByTestId("memory-error")).toBeInTheDocument());
    expect(screen.getByTestId("memory-error")).toHaveTextContent(/permission/i);
  });
});

describe("/admin/agents/memory: human override", () => {
  it("promoting a quarantined row PATCHes the action and the row reflects promoted", async () => {
    const quarantined = makeEntry({
      id: "mem-q",
      status: "quarantined",
      hitCount: 0,
    });
    const promotedBack = { ...quarantined, status: "promoted", verifiedAt: new Date().toISOString() };

    mockFetchWithRefresh.mockImplementation((url: unknown, init?: { method?: string }) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(mkRes({ memory: promotedBack }));
      }
      return Promise.resolve(mkRes({ workspace_id: "default", memory: [quarantined] }));
    });

    await act(async () => {
      render(<AgentMemoryPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId(`memory-promote-${quarantined.id}`)).toBeInTheDocument(),
    );
    expect(screen.getByTestId(`memory-status-chip-${quarantined.id}`)).toHaveTextContent(
      "quarantined",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId(`memory-promote-${quarantined.id}`));
    });

    // Chip flips to promoted in place.
    await waitFor(() =>
      expect(screen.getByTestId(`memory-status-chip-${quarantined.id}`)).toHaveTextContent(
        "promoted",
      ),
    );
    // The promote button is gone now that it is promoted; reject remains.
    expect(screen.queryByTestId(`memory-promote-${quarantined.id}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`memory-reject-${quarantined.id}`)).toBeInTheDocument();

    // A PATCH fired to the right endpoint with action=promote.
    const patch = mockFetchWithRefresh.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === "PATCH",
    );
    expect(patch).toBeTruthy();
    expect(String(patch?.[0])).toContain(`/api/admin/agents/memory/${quarantined.id}`);
    const body = JSON.parse((patch?.[1] as { body: string }).body);
    expect(body.action).toBe("promote");
  });
});

describe("/admin/agents/memory: status filter", () => {
  it("selecting Promoted refetches the list with ?status=promoted", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ workspace_id: "default", memory: [makeEntry()] }),
    );

    const listCalls = () =>
      mockFetchWithRefresh.mock.calls
        .filter((c) => (c[1] as { method?: string } | undefined)?.method !== "PATCH")
        .map((c) => String(c[0]));

    await act(async () => {
      render(<AgentMemoryPage />);
    });
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    // Initial "all" fetch carries no status filter.
    expect(listCalls()[0]).not.toContain("status=");

    await act(async () => {
      fireEvent.click(screen.getByTestId("memory-filter-promoted"));
    });

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1]).toContain("status=promoted");
  });
});
