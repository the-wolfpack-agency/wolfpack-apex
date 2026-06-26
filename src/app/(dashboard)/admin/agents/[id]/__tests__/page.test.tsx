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
 * The page fires FOUR GETs on mount: the agent fetch (/api/admin/agents/{id}),
 * the self-onboarding scan fetch (/api/admin/agents/{id}/scan), the assigned
 * work fetch (/api/admin/agents/{id}/tasks), and the behavior+drift fetch
 * (/api/admin/agents/{id}/drift). It also POSTs to the tasks endpoint when a
 * human assigns a goal, to .../baseline when an operator captures a baseline,
 * and to .../drift-check when an operator runs a drift check now. The mock is
 * routed by URL + method so each can be present, absent, or errored
 * independently of the others.
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

function makeTask(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "task-1",
    agentId: "ag-1",
    workspaceId: "default",
    assignedBy: "u-cto",
    goal: "Find the latest invoice for ACME",
    status: "succeeded",
    steps: [
      { index: 0, instruction: "Search invoices for ACME", tool: "search_mail", outcome: "ran", detail: null },
    ],
    resultSummary: "Found 1 invoice.",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...over,
  };
}

function makeBaseline(over: Partial<Record<string, unknown>> = {}) {
  return {
    metrics: {
      count: 42,
      blockRate: 0.1,
      tierDist: { low: 30, high: 12 },
      outcomeDist: { ran: 38, blocked: 4 },
      toolDist: { search_mail: 20, create_event: 22 },
    },
    decisionCount: 42,
    capturedAt: new Date().toISOString(),
    ...over,
  };
}

function makeDriftEvent(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "drift-1",
    agentId: "ag-1",
    driftScore: 0.12,
    verdict: "stable",
    action: "none",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * A full agent-log entry from the granular endpoint
 * (/api/admin/agents/{id}/log). Each entry is the complete trail from prompt to
 * response: the redacted input, the governance decision, the redacted result,
 * the acting identity, and the tamper-evident hash chain. The drill-down test
 * suite builds entries off this and overrides the fields it asserts on.
 */
function makeLogEntry(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "log-1",
    seq: 1,
    created_at: new Date().toISOString(),
    tool: "search_mail",
    capability: "mail.read",
    surface: "mail",
    risk_tier: "low",
    intended_outcome: "allow",
    effective_outcome: "allow",
    would_block: false,
    rule_id: "rule-allow-read",
    reason: "read-only capability within ceiling",
    policy_version: "v1",
    on_behalf_user_id: "u-cto",
    on_behalf_role: "admin",
    redacted_params: { query: "invoices from ACME", folder: "inbox" },
    signals: { pii: false, secret: false, injection: false },
    params_hash: "ph_1234567890abcdefdeadbeef",
    entry_hash: "eh_abcdef1234567890cafebabe",
    outcome: { ok: true, code: "ok", result_redacted: { count: 3 }, duration_ms: 142 },
    ...over,
  };
}

// The connected-systems section is scoped to THIS agent: it GETs
// /api/admin/agents/{id}/connections on mount (returning { bound, available }),
// POSTs the same path to bind a connection, and DELETEs it to unbind. Creating a
// brand-new connection still POSTs /api/admin/connectors, after which the page
// binds it by POSTing the agent-connections path. Matched on path fragments so
// unrelated agent/scan/tasks/drift GETs never fall through.
const CONNECTORS_PATH = "/api/admin/connectors";
const AGENT_CONNECTIONS_PATH = "/connections";

// A masked agent-connection (bound or available). The connections endpoint
// returns this shape; the create endpoint (/api/admin/connectors) is mocked
// separately by onCreateConnector.
function makeConnection(over: Partial<Record<string, unknown>> = {}) {
  return {
    connectorName: "acme-portal",
    baseUrl: "https://app.acme.com",
    authType: "username_password",
    ...over,
  };
}

const SCAN_PATH = "/scan";
const BACKUP_PATH = "/backup";
const TASKS_PATH = "/tasks";
const TASKS_RUN_PATH = "/tasks/run";
const DRIFT_PATH = "/drift";
const BASELINE_PATH = "/baseline";
const DRIFT_CHECK_PATH = "/drift-check";
const ANALYTICS_PATH = "/api/analytics";
// The granular agent-log endpoint. The page GETs it with a query string
// (?limit=50), so the router matches on this path fragment rather than a suffix.
const LOG_PATH = "/log";

/**
 * Routes the mock by URL + method: the page fires the agent GET, the scan GET,
 * the tasks GET, and the drift GET on mount, plus a tasks POST when a goal is
 * assigned, a baseline POST when a baseline is set, and a drift-check POST when
 * a drift check is run. `agent` is the response for /api/admin/agents/{id} (and
 * any PATCH), `scan` is for .../scan, `tasks` is the tasks GET, `onAssign` is
 * the tasks POST, `drift` is the drift GET, `onBaseline` is the baseline POST,
 * `onDriftCheck` is the drift-check POST, and `onRun` is the tasks-drain POST
 * (.../tasks/run). The drift GET (and the tasks GET) can be made dynamic (e.g.
 * to return an updated list after a POST or between poll ticks) by having the
 * relevant function close over mutable test state.
 */
function routeByUrl(opts: {
  agent: () => any;
  scan: () => any;
  tasks?: () => any;
  onPatch?: () => any;
  onAssign?: () => any;
  onRun?: () => any;
  onScan?: () => any;
  drift?: () => any;
  onBaseline?: () => any;
  onDriftCheck?: () => any;
  log?: () => any;
  onAnalytics?: () => any;
  connections?: () => any;
  onBind?: () => any;
  onUnbind?: () => any;
  onCreateConnector?: () => any;
  backup?: () => any;
  onBackup?: () => any;
  roster?: () => any;
}) {
  return (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    if (init?.method === "PATCH" && opts.onPatch) return Promise.resolve(opts.onPatch());
    // Backup designation: GET /api/admin/agents/{id}/backup returns
    // { backupAgentId }, POST sets it. Matched before the bare-agents roster GET
    // and the agent fall-through so neither swallows it.
    if (u.endsWith(BACKUP_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onBackup ?? (() => mkRes({ ok: true, backupAgentId: "ag-2" })))());
    }
    if (u.endsWith(BACKUP_PATH)) {
      return Promise.resolve((opts.backup ?? (() => mkRes({ backupAgentId: null })))());
    }
    // The roster GET /api/admin/agents (no id suffix) populates the backup
    // select. Matched on the exact bare-collection path so the per-agent GET
    // (/api/admin/agents/{id}) still falls through to opts.agent().
    if (/\/api\/admin\/agents$/.test(u) && (init?.method ?? "GET") === "GET") {
      return Promise.resolve((opts.roster ?? (() => mkRes({ agents: [] })))());
    }
    // Creating a brand-new connection POSTs /api/admin/connectors. Matched
    // before the agent-connections path so the create stays distinct from the
    // bind. (The path "/api/admin/connectors" does not contain "/connections".)
    if (u.includes(CONNECTORS_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onCreateConnector ?? (() => mkRes({ connector: makeConnection() }, { status: 201 })))());
    }
    // The agent-scoped connections endpoint: GET returns { bound, available },
    // POST binds a connection, DELETE unbinds one. Matched on the "/connections"
    // fragment so the agent GET fall-through below never swallows it.
    if (u.includes(AGENT_CONNECTIONS_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onBind ?? (() => mkRes({ ok: true, bound: [] })))());
    }
    if (u.includes(AGENT_CONNECTIONS_PATH) && init?.method === "DELETE") {
      return Promise.resolve((opts.onUnbind ?? (() => mkRes({ ok: true })))());
    }
    if (u.includes(AGENT_CONNECTIONS_PATH)) {
      return Promise.resolve((opts.connections ?? (() => mkRes({ bound: [], available: [] })))());
    }
    // Analytics POSTs (the agent.log_viewed view event) are best effort; route
    // them first so the fire-and-forget POST never falls through to a data GET.
    if (u.includes(ANALYTICS_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onAnalytics ?? (() => mkRes({ ok: true })))());
    }
    // The granular agent log GETs /api/admin/agents/{id}/log (with a ?limit
    // query string), so we match on the "/log" fragment rather than a suffix.
    if (u.includes(LOG_PATH)) {
      return Promise.resolve((opts.log ?? (() => mkRes({ entries: [] })))());
    }
    // The run endpoint (".../tasks/run") drains queued work. It is checked
    // before the generic "/tasks" suffixes because "/tasks/run" does not end
    // with "/tasks"; route the POST here so the drain stays distinct from the
    // assign POST and the list GET.
    if (u.endsWith(TASKS_RUN_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onRun ?? (() => mkRes({ ran: 0, tasks: [] })))());
    }
    // The manager-triggered scan POSTs to .../scan; route it before the generic
    // scan GET suffix below so the GET loader and the POST trigger stay distinct.
    if (u.endsWith(SCAN_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onScan ?? (() => mkRes({ ok: true, summary: {}, scan_version: "v1", tool_count: 0 })))());
    }
    // Drift-check is checked before the generic /drift suffix below because
    // ".../drift-check" does not end with "/drift" but is method POST.
    if (u.endsWith(DRIFT_CHECK_PATH) && init?.method === "POST") {
      return Promise.resolve(
        (opts.onDriftCheck ?? (() => mkRes({ result: { verdict: "stable", score: 0.1, action: "none" } })))(),
      );
    }
    if (u.endsWith(BASELINE_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onBaseline ?? (() => mkRes({ baseline: makeBaseline() }, { status: 201 })))());
    }
    if (u.endsWith(DRIFT_PATH)) {
      return Promise.resolve(
        (opts.drift ?? (() => mkRes({ baseline: null, events: [], latest: null })))(),
      );
    }
    if (u.endsWith(TASKS_PATH) && init?.method === "POST") {
      return Promise.resolve((opts.onAssign ?? (() => mkRes({ task: makeTask() }, { status: 201 })))());
    }
    if (u.endsWith(TASKS_PATH)) {
      return Promise.resolve((opts.tasks ?? (() => mkRes({ tasks: [] })))());
    }
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

describe("/admin/agents/[id]: run onboarding scan", () => {
  it("renders the Run-scan button when the agent has no scan yet (pending)", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent({ scanStatus: "pending" }) }),
        scan: () => mkRes({ error: "no_scan" }, { ok: false, status: 404 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-scan-empty")).toBeInTheDocument());
    const btn = screen.getByTestId("agent-run-scan");
    expect(btn).toHaveTextContent(/run onboarding scan/i);
    // The helper note explains what the scan does and how to delegate after.
    expect(screen.getByTestId("agent-run-scan-note")).toHaveTextContent(/introspects the platform/i);
    expect(screen.getByTestId("agent-run-scan-note")).toHaveTextContent(/delegate work from the Assistant/i);
  });

  it("clicking Run scan POSTs to the scan endpoint, then refetches scan + agent so the System model appears", async () => {
    // Before the scan: no scan, agent pending. After: a model with tools and the
    // agent flips to scanStatus "complete".
    let scanned = false;
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent({ scanStatus: scanned ? "complete" : "pending" }) }),
        scan: () =>
          scanned
            ? mkRes({ scan: makeScan() })
            : mkRes({ error: "no_scan" }, { ok: false, status: 404 }),
        onScan: () => {
          scanned = true;
          return mkRes({ ok: true, summary: {}, scan_version: "v1", tool_count: 3 });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-run-scan")).toBeInTheDocument());
    expect(screen.getByTestId("agent-scan-status")).toHaveTextContent(/pending/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-run-scan"));
    });

    // A POST went to the scan endpoint.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).endsWith("/scan"),
    );
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toContain("/api/admin/agents/ag-1/scan");

    // The refetched scan renders the System model and the agent's scan status flips.
    await waitFor(() => expect(screen.getByTestId("agent-scan-summary")).toBeInTheDocument());
    expect(screen.getByTestId("agent-scan-tools")).toHaveTextContent("search_mail");
    expect(screen.getByTestId("agent-scan-status")).toHaveTextContent(/complete/i);
    // Once complete, the control offers a re-run rather than a first run.
    expect(screen.getByTestId("agent-run-scan")).toHaveTextContent(/re-run scan/i);
  });

  it("surfaces the must-be-active message on a 409 and does not blank the page", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent({ state: "paused", scanStatus: "pending" }) }),
        scan: () => mkRes({ error: "no_scan" }, { ok: false, status: 404 }),
        onScan: () => mkRes({ error: "agent_not_active" }, { ok: false, status: 409 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-run-scan")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-run-scan"));
    });

    await waitFor(() => expect(screen.getByTestId("agent-run-scan-error")).toBeInTheDocument());
    expect(screen.getByTestId("agent-run-scan-error")).toHaveTextContent(/must be active/i);
    // The rest of the profile still renders: a failed scan never blanks it.
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
    expect(screen.getByTestId("agent-scan-empty")).toBeInTheDocument();
  });
});

describe("/admin/agents/[id]: assigned work (tasks)", () => {
  it("renders the task list with status chips and, when expanded, step outcomes", async () => {
    const succeeded = makeTask({
      id: "task-ok",
      goal: "Find the latest invoice",
      status: "succeeded",
      steps: [
        { index: 0, instruction: "Search invoices", tool: "search_mail", outcome: "ran", detail: null },
      ],
      resultSummary: "Found it.",
    });
    const blocked = makeTask({
      id: "task-blk",
      goal: "Send a follow-up email",
      status: "blocked",
      resultSummary: null,
      steps: [
        { index: 0, instruction: "Draft email", tool: "draft_mail", outcome: "ran", detail: null },
        { index: 1, instruction: "Send email", tool: "send_mail", outcome: "blocked", detail: "owner approval required" },
      ],
    });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [succeeded, blocked] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-tasks-list")).toBeInTheDocument());

    // Both tasks render with the right status chips.
    expect(screen.getByTestId("agent-task-task-ok")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-task-blk")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-status-task-ok")).toHaveTextContent(/succeeded/i);
    expect(screen.getByTestId("agent-task-status-task-blk")).toHaveTextContent(/blocked/i);
    expect(screen.queryByTestId("agent-tasks-empty")).not.toBeInTheDocument();

    // Expanding the blocked task reveals a "blocked" step outcome chip.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-task-toggle-task-blk"));
    });
    expect(screen.getByTestId("agent-task-steps-task-blk")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-task-blk-step-1-outcome")).toHaveTextContent("blocked");
    expect(screen.getByTestId("agent-task-task-blk-step-0-outcome")).toHaveTextContent("ran");
  });

  it("shows the empty state when the agent has no assigned work", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-tasks-empty")).toBeInTheDocument());
    expect(screen.getByTestId("agent-tasks-empty")).toHaveTextContent(/no work assigned yet/i);
    expect(screen.queryByTestId("agent-tasks-list")).not.toBeInTheDocument();
  });

  it("renders a clear Assign call-to-action with how-to guidance and a governance note", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-task-form")).toBeInTheDocument());

    // A descriptive heading + plain-language how-to, not just a bare label.
    expect(screen.getByText(/give this agent a job/i)).toBeInTheDocument();
    expect(screen.getByText(/runs each one through the governance gate/i)).toBeInTheDocument();

    // The CTA reads "Assign" and is a real, enabled action once a goal is typed.
    const submit = screen.getByTestId("agent-task-submit") as HTMLButtonElement;
    expect(submit).toHaveTextContent(/^assign$/i);
    // Disabled while the textarea is empty (nothing to assign yet).
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-task-goal"), {
        target: { value: "Draft a summary" },
      });
    });
    expect(submit.disabled).toBe(false);

    // The governance note explains the Blocked outcome so it does not read as a failure.
    expect(screen.getByTestId("agent-task-governance-note")).toHaveTextContent(
      /asks you to approve/i,
    );
  });

  it("assigns a goal: POSTs to the tasks endpoint and prepends the returned task", async () => {
    // The assign POST now returns a TERMINAL task (steps populated), so the
    // prepended row shows its real status, not a stuck "Queued".
    const created = makeTask({
      id: "task-new",
      goal: "Summarise Q2 numbers",
      status: "succeeded",
      steps: [{ index: 0, instruction: "Summarise", tool: "search_mail", outcome: "ran", detail: null }],
    });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [] }),
        onAssign: () => mkRes({ task: created }, { status: 201 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-task-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-task-goal"), {
        target: { value: "Summarise Q2 numbers" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-task-submit"));
    });

    // The returned task is prepended to the list.
    await waitFor(() => expect(screen.getByTestId("agent-task-task-new")).toBeInTheDocument());

    // A POST went to the tasks endpoint with the goal in the body.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).endsWith("/tasks"),
    );
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toContain("/api/admin/agents/ag-1/tasks");
    const body = JSON.parse((post?.[1] as { body: string }).body);
    expect(body.goal).toBe("Summarise Q2 numbers");

    // The textarea is cleared after a successful assign.
    expect(screen.getByTestId("agent-task-goal")).toHaveValue("");
  });

  it("shows an inline error when assigning to an inactive agent (409)", async () => {
    // The execute-on-assign contract returns 409 agent_not_active when the agent
    // is paused or revoked; the UI surfaces a single must-be-active message.
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [] }),
        onAssign: () => mkRes({ error: "agent_not_active" }, { ok: false, status: 409 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-task-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-task-goal"), {
        target: { value: "Do something" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-task-submit"));
    });

    await waitFor(() => expect(screen.getByTestId("agent-task-error")).toBeInTheDocument());
    expect(screen.getByTestId("agent-task-error")).toHaveTextContent(/must be active/i);
    // No task row was added on the failed assign.
    expect(screen.queryByTestId("agent-tasks-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-tasks-empty")).toBeInTheDocument();
  });
});

describe("/admin/agents/[id]: live execution", () => {
  it("assign returns a terminal task that renders its status and governed steps, not Queued, and the button shows a busy state", async () => {
    // The POST resolves on a deferred promise so we can observe the in-flight
    // busy state on the Assign button before it settles.
    let resolveAssign: ((v: any) => void) | null = null;
    const created = makeTask({
      id: "task-done",
      goal: "Reconcile the ledger",
      status: "succeeded",
      steps: [
        { index: 0, instruction: "Pull ledger", tool: "search_mail", outcome: "ran", detail: null },
        { index: 1, instruction: "Reconcile totals", tool: "create_event", outcome: "ran", detail: null },
      ],
      resultSummary: "Reconciled.",
    });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [] }),
        onAssign: () =>
          new Promise((resolve) => {
            resolveAssign = () => resolve(mkRes({ task: created }, { status: 201 }));
          }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-task-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-task-goal"), {
        target: { value: "Reconcile the ledger" },
      });
    });

    // Fire the assign but do not resolve the POST yet.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-task-submit"));
    });

    // While the request is in flight the button is busy and disabled.
    const submit = screen.getByTestId("agent-task-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent(/assigning/i);

    // Now let the POST resolve with the terminal task.
    await act(async () => {
      resolveAssign?.(null);
    });

    await waitFor(() => expect(screen.getByTestId("agent-task-task-done")).toBeInTheDocument());

    // The terminal status renders, NOT "queued".
    const statusChip = screen.getByTestId("agent-task-status-task-done");
    expect(statusChip).toHaveTextContent(/succeeded/i);
    expect(statusChip).not.toHaveTextContent(/queued/i);

    // The governed steps are visible once expanded.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-task-toggle-task-done"));
    });
    expect(screen.getByTestId("agent-task-steps-task-done")).toBeInTheDocument();
    expect(screen.getByTestId("agent-task-task-done-step-0-outcome")).toHaveTextContent("ran");
    expect(screen.getByTestId("agent-task-task-done-step-1-outcome")).toHaveTextContent("ran");

    // The button has returned to its idle label.
    expect(screen.getByTestId("agent-task-submit")).toHaveTextContent(/^assign$/i);
  });

  it("surfaces the must-be-active message on a 409 assign and does not blank the section", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [] }),
        onAssign: () => mkRes({ error: "agent_not_active" }, { ok: false, status: 409 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-task-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("agent-task-goal"), { target: { value: "Do work" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-task-submit"));
    });

    await waitFor(() => expect(screen.getByTestId("agent-task-error")).toBeInTheDocument());
    expect(screen.getByTestId("agent-task-error")).toHaveTextContent(/must be active/i);
    // The section is intact: form + empty state still render, nothing blanked.
    expect(screen.getByTestId("agent-task-form")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tasks-empty")).toBeInTheDocument();
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
  });

  it("polls while a task is running and stops once it is terminal", async () => {
    jest.useFakeTimers();
    try {
      // The list starts with one running task; the first poll returns it
      // succeeded, after which polling must stop (no further GET to /tasks).
      const running = makeTask({ id: "task-run", goal: "Crunch numbers", status: "running", steps: [] });
      const done = makeTask({
        id: "task-run",
        goal: "Crunch numbers",
        status: "succeeded",
        steps: [{ index: 0, instruction: "Crunch", tool: "search_mail", outcome: "ran", detail: null }],
        resultSummary: "Done.",
      });
      let tasksGetCount = 0;
      let settled = false;
      mockFetchWithRefresh.mockImplementation(
        routeByUrl({
          agent: () => mkRes({ agent: makeAgent() }),
          scan: () => mkRes({}, { ok: false, status: 404 }),
          tasks: () => {
            tasksGetCount += 1;
            // Mount GET returns running; the first poll returns succeeded.
            return mkRes({ tasks: [settled ? done : running] });
          },
        }),
      );

      await act(async () => {
        render(<AgentProfilePage params={params} />);
      });
      await waitFor(() => expect(screen.getByTestId("agent-task-status-task-run")).toBeInTheDocument());
      expect(screen.getByTestId("agent-task-status-task-run")).toHaveTextContent(/running/i);

      const afterMountGets = tasksGetCount;

      // Flip the backing data to terminal, then advance one poll interval.
      settled = true;
      await act(async () => {
        jest.advanceTimersByTime(3000);
      });
      // Flush the in-flight poll's async work.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      // The poll fired exactly one extra GET and the UI now reads succeeded.
      expect(tasksGetCount).toBe(afterMountGets + 1);
      expect(screen.getByTestId("agent-task-status-task-run")).toHaveTextContent(/succeeded/i);

      // Polling has stopped: further timer advances trigger no more GETs.
      const afterTerminalGets = tasksGetCount;
      await act(async () => {
        jest.advanceTimersByTime(9000);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(tasksGetCount).toBe(afterTerminalGets);
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows Run queued work when a queued task exists, POSTs to /tasks/run, and refreshes", async () => {
    const queued = makeTask({ id: "task-q", goal: "Backfilled work", status: "queued", steps: [] });
    const drained = makeTask({
      id: "task-q",
      goal: "Backfilled work",
      status: "succeeded",
      steps: [{ index: 0, instruction: "Backfill", tool: "search_mail", outcome: "ran", detail: null }],
      resultSummary: "Drained.",
    });
    let runCount = 0;
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [queued] }),
        onRun: () => {
          runCount += 1;
          return mkRes({ ran: 1, tasks: [drained] });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    // The control shows because a queued task exists.
    await waitFor(() => expect(screen.getByTestId("agent-run-queued")).toBeInTheDocument());
    expect(screen.getByTestId("agent-task-status-task-q")).toHaveTextContent(/queued/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-run-queued"));
    });

    // A POST went to the run endpoint.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).endsWith("/tasks/run"),
    );
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toContain("/api/admin/agents/ag-1/tasks/run");
    expect(runCount).toBe(1);

    // The list refreshed from the drain response: the task is now succeeded and
    // the run control is gone (no more queued tasks).
    await waitFor(() => expect(screen.getByTestId("agent-task-status-task-q")).toHaveTextContent(/succeeded/i));
    expect(screen.queryByTestId("agent-run-queued")).not.toBeInTheDocument();
  });

  it("hides Run queued work when there are no queued tasks", async () => {
    const succeeded = makeTask({ id: "task-ok2", status: "succeeded" });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        tasks: () => mkRes({ tasks: [succeeded] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-task-task-ok2")).toBeInTheDocument());
    expect(screen.queryByTestId("agent-run-queued")).not.toBeInTheDocument();
  });
});

describe("/admin/agents/[id]: behavior and drift", () => {
  it("renders a stable status, the baseline, and the drift event history", async () => {
    const baseline = makeBaseline({ decisionCount: 42 });
    const stable = makeDriftEvent({ id: "drift-stable", verdict: "stable", driftScore: 0.08, action: "none" });
    const drifting = makeDriftEvent({ id: "drift-amber", verdict: "drifting", driftScore: 0.41, action: "none" });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        drift: () =>
          mkRes({ baseline, events: [stable, drifting], latest: stable }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-drift-status")).toBeInTheDocument());

    // Status line reflects the latest verdict + score.
    const status = screen.getByTestId("agent-drift-status");
    expect(status).toHaveTextContent(/stable/i);
    expect(status).toHaveTextContent("0.08");

    // Baseline info reflects capture + decision count.
    const baselineEl = screen.getByTestId("agent-drift-baseline");
    expect(baselineEl).toHaveTextContent(/baseline captured/i);
    expect(baselineEl).toHaveTextContent("42 decisions");
    expect(baselineEl).toHaveTextContent(/normal behavior/i);

    // Both events render in the history with their verdicts.
    const events = screen.getByTestId("agent-drift-events");
    expect(events).toBeInTheDocument();
    expect(screen.getByTestId("agent-drift-event-drift-stable")).toHaveTextContent(/stable/i);
    expect(screen.getByTestId("agent-drift-event-drift-amber")).toHaveTextContent(/drifting/i);
    expect(screen.getByTestId("agent-drift-event-drift-amber")).toHaveTextContent("0.41");

    // No paused note when the latest action is "none".
    expect(screen.queryByTestId("agent-drift-paused-note")).not.toBeInTheDocument();
    // The empty state must not show when events are present.
    expect(screen.queryByTestId("agent-drift-empty")).not.toBeInTheDocument();
  });

  it("shows the no-baseline state and the empty history when the agent has neither", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        drift: () => mkRes({ baseline: null, events: [], latest: null }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-drift-baseline")).toBeInTheDocument());
    expect(screen.getByTestId("agent-drift-baseline")).toHaveTextContent(/no baseline yet/i);
    expect(screen.getByTestId("agent-drift-status")).toHaveTextContent(/no checks yet/i);
    expect(screen.getByTestId("agent-drift-empty")).toHaveTextContent(/no drift checks recorded yet/i);
    expect(screen.queryByTestId("agent-drift-events")).not.toBeInTheDocument();
  });

  it("Set baseline POSTs to the baseline endpoint and refetches the drift view", async () => {
    // The drift GET is dynamic: null before the baseline POST, present after.
    let hasBaseline = false;
    const captured = makeBaseline({ decisionCount: 17 });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        drift: () =>
          hasBaseline
            ? mkRes({ baseline: captured, events: [], latest: null })
            : mkRes({ baseline: null, events: [], latest: null }),
        onBaseline: () => {
          hasBaseline = true;
          return mkRes({ baseline: captured }, { status: 201 });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-set-baseline")).toBeInTheDocument());
    expect(screen.getByTestId("agent-drift-baseline")).toHaveTextContent(/no baseline yet/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-set-baseline"));
    });

    // A POST went to the baseline endpoint.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).endsWith("/baseline"),
    );
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toContain("/api/admin/agents/ag-1/baseline");

    // The refetched drift view now shows the captured baseline.
    await waitFor(() =>
      expect(screen.getByTestId("agent-drift-baseline")).toHaveTextContent(/baseline captured/i),
    );
    expect(screen.getByTestId("agent-drift-baseline")).toHaveTextContent("17 decisions");
  });

  it("Check drift now POSTs, and when the result is a pause, the UI reflects the auto-pause", async () => {
    // Before the check: active agent, stable, no events. After the check: a
    // critical paused event and the agent flips to paused (auto-pause).
    let checked = false;
    const baseline = makeBaseline();
    const pausedEvent = makeDriftEvent({
      id: "drift-crit",
      verdict: "critical",
      driftScore: 0.92,
      action: "paused",
    });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent({ state: checked ? "paused" : "active" }) }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        drift: () =>
          checked
            ? mkRes({ baseline, events: [pausedEvent], latest: pausedEvent })
            : mkRes({ baseline, events: [], latest: null }),
        onDriftCheck: () => {
          checked = true;
          return mkRes({ result: { verdict: "critical", score: 0.92, action: "paused" } });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("agent-check-drift")).toBeInTheDocument());
    expect(screen.getByTestId("agent-state-chip")).toHaveTextContent("active");

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-check-drift"));
    });

    // A POST went to the drift-check endpoint.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).endsWith("/drift-check"),
    );
    expect(post).toBeTruthy();
    expect(String(post?.[0])).toContain("/api/admin/agents/ag-1/drift-check");

    // The auto-pause is reflected: the lifecycle state chip flips to paused
    // (the agent was refetched) and the drift section shows the paused note.
    await waitFor(() => expect(screen.getByTestId("agent-drift-paused-note")).toBeInTheDocument());
    expect(screen.getByTestId("agent-drift-paused-note")).toHaveTextContent(/auto-paused for drift/i);
    expect(screen.getByTestId("agent-state-chip")).toHaveTextContent("paused");
    expect(screen.getByTestId("agent-drift-status")).toHaveTextContent(/critical/i);
    expect(screen.getByTestId("agent-drift-event-drift-crit")).toHaveTextContent(/critical/i);
  });

  it("collapses to a quiet error state when the drift fetch fails", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        drift: () => mkRes({}, { ok: false, status: 500 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-drift-error")).toBeInTheDocument());
    // The rest of the profile still renders: a drift failure never blanks it.
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-drift-status")).not.toBeInTheDocument();
  });
});

describe("/admin/agents/[id]: agent log (granular audit trail)", () => {
  it("loads entries from the granular endpoint and renders summary rows with the right outcome pill colors", async () => {
    const allow = makeLogEntry({
      id: "log-allow",
      tool: "search_mail",
      capability: "mail.read",
      effective_outcome: "allow",
      rule_id: "rule-allow-read",
      risk_tier: "low",
    });
    const deny = makeLogEntry({
      id: "log-deny",
      tool: "send_mail",
      capability: "mail.send",
      effective_outcome: "deny",
      rule_id: "rule-deny-send",
      risk_tier: "high",
    });
    const escalate = makeLogEntry({
      id: "log-esc",
      tool: "wire_transfer",
      capability: "finance.pay",
      effective_outcome: "escalate",
      rule_id: "rule-escalate-pay",
      risk_tier: "critical",
    });
    let logGetUrl = "";
    mockFetchWithRefresh.mockImplementation((url: unknown, init?: { method?: string }) => {
      const u = String(url);
      if (u.includes("/log")) logGetUrl = u;
      return routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => mkRes({ entries: [deny, escalate, allow] }),
      })(url, init);
    });

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-list")).toBeInTheDocument());

    // The data source is the granular endpoint, requested with the limit.
    expect(logGetUrl).toContain("/api/admin/agents/ag-1/log");
    expect(logGetUrl).toContain("limit=50");

    // All three rows render the compact summary with tool + capability + rule + tier.
    const allowRow = screen.getByTestId("agent-log-row-log-allow");
    expect(allowRow).toHaveTextContent("search_mail");
    expect(allowRow).toHaveTextContent("mail.read");
    expect(allowRow).toHaveTextContent("rule-allow-read");
    expect(allowRow).toHaveTextContent("low");
    expect(screen.getByTestId("agent-log-row-log-deny")).toBeInTheDocument();
    expect(screen.getByTestId("agent-log-row-log-esc")).toBeInTheDocument();

    // The outcome pills carry the documented OGIAM palette: allow green, deny
    // red, escalate amber. We assert the foreground hex on each pill.
    expect(screen.getByTestId("agent-log-row-log-allow-outcome")).toHaveStyle({ color: "#22A55C" });
    expect(screen.getByTestId("agent-log-row-log-deny-outcome")).toHaveStyle({ color: "#FF5F57" });
    expect(screen.getByTestId("agent-log-row-log-esc-outcome")).toHaveStyle({ color: "#E8B528" });

    // The count line reflects the rendered total, and the empty state is absent.
    expect(screen.getByTestId("agent-log-count")).toHaveTextContent(/3 governed actions/i);
    expect(screen.queryByTestId("agent-log-empty")).not.toBeInTheDocument();

    // Detail panels are collapsed until a row is clicked.
    expect(screen.queryByTestId("agent-log-detail-log-allow")).not.toBeInTheDocument();
  });

  it("clicking a row expands the full trail (input, governance, response, identity, integrity) and clicking again collapses it", async () => {
    const entry = makeLogEntry({
      id: "log-x",
      tool: "send_mail",
      capability: "mail.send",
      effective_outcome: "escalate",
      intended_outcome: "allow",
      rule_id: "rule-escalate-pay",
      risk_tier: "high",
      policy_version: "v7",
      would_block: true,
      on_behalf_user_id: "u-owner",
      on_behalf_role: "admin",
      surface: "mail",
      redacted_params: { to: "[REDACTED]", subject: "Q2 numbers" },
      entry_hash: "eh_proofchainvalue000111222",
      params_hash: "ph_inputproof999888777",
      outcome: { ok: true, code: "queued", result_redacted: { message_id: "[REDACTED]" }, duration_ms: 88 },
    });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => mkRes({ entries: [entry] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-row-log-x")).toBeInTheDocument());

    // Collapsed by default; the toggle reports aria-expanded false.
    const toggle = screen.getByTestId("agent-log-row-log-x-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("agent-log-detail-log-x")).not.toBeInTheDocument();

    // Click expands the detail panel.
    await act(async () => {
      fireEvent.click(toggle);
    });

    const detail = screen.getByTestId("agent-log-detail-log-x");
    expect(detail).toBeInTheDocument();
    expect(screen.getByTestId("agent-log-row-log-x-toggle")).toHaveAttribute("aria-expanded", "true");

    // INPUT: the redacted prompt is rendered readably.
    const input = screen.getByTestId("agent-log-detail-log-x-input");
    expect(input).toHaveTextContent(/Input/i);
    expect(input).toHaveTextContent("Q2 numbers");
    expect(input).toHaveTextContent("[REDACTED]");

    // GOVERNANCE: intended -> effective, rule, risk, policy, would-block.
    const gov = screen.getByTestId("agent-log-detail-log-x-governance");
    expect(gov).toHaveTextContent(/allow/i);
    expect(gov).toHaveTextContent(/escalate/i);
    expect(gov).toHaveTextContent("rule-escalate-pay");
    expect(gov).toHaveTextContent("high");
    expect(gov).toHaveTextContent("v7");
    expect(gov).toHaveTextContent(/would block yes/i);

    // RESPONSE: ok state + redacted result.
    const resp = screen.getByTestId("agent-log-detail-log-x-response");
    expect(resp).toHaveTextContent(/Succeeded/i);
    expect(resp).toHaveTextContent("queued");
    expect(resp).toHaveTextContent("message_id");

    // IDENTITY: on-behalf user + role + surface.
    const identity = screen.getByTestId("agent-log-detail-log-x-identity");
    expect(identity).toHaveTextContent("u-owner");
    expect(identity).toHaveTextContent("admin");
    expect(identity).toHaveTextContent("mail");

    // INTEGRITY: the tamper-evident chain proof, with the full hash on the title.
    const integrity = screen.getByTestId("agent-log-detail-log-x-integrity");
    expect(integrity).toHaveTextContent(/Integrity/i);
    expect(integrity).toHaveTextContent(/seq 1/i);
    // The full entry hash is preserved (on a title attribute) even though the
    // visible value is truncated.
    expect(integrity.innerHTML).toContain("eh_proofchainvalue000111222");

    // Clicking again collapses the panel.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-log-row-log-x-toggle"));
    });
    expect(screen.queryByTestId("agent-log-detail-log-x")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-log-row-log-x-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the no-recorded-result response state when an entry has outcome null (older action)", async () => {
    const legacy = makeLogEntry({ id: "log-legacy", outcome: null });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => mkRes({ entries: [legacy] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-row-log-legacy")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-log-row-log-legacy-toggle"));
    });

    expect(screen.getByTestId("agent-log-detail-log-legacy-no-response")).toHaveTextContent(
      /no recorded result for this action/i,
    );
  });

  it("renders a warning chip for each raised input signal (PII/secret/injection)", async () => {
    const flagged = makeLogEntry({
      id: "log-flagged",
      signals: { pii: true, secret: false, injection: false },
    });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => mkRes({ entries: [flagged] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-row-log-flagged")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-log-row-log-flagged-toggle"));
    });

    // The raised flag renders a chip; the false flags do not.
    expect(screen.getByTestId("agent-log-detail-log-flagged-signal-pii")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-detail-log-flagged-signal-secret")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-detail-log-flagged-signal-injection")).not.toBeInTheDocument();
  });

  it("shows the empty state when the agent has no governed actions yet", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => mkRes({ entries: [] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-empty")).toBeInTheDocument());
    expect(screen.getByTestId("agent-log-empty")).toHaveTextContent(/no governed actions recorded yet/i);
    expect(screen.queryByTestId("agent-log-list")).not.toBeInTheDocument();
  });

  it("fires the agent.log_viewed analytics POST with the entry count on a successful load", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => mkRes({ entries: [makeLogEntry({ id: "l-1" }), makeLogEntry({ id: "l-2" })] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-list")).toBeInTheDocument());

    // One analytics POST fired with the view event and the rendered entry count.
    await waitFor(() => {
      const post = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          (c[1] as { method?: string } | undefined)?.method === "POST" &&
          String(c[0]).includes("/api/analytics"),
      );
      expect(post).toBeTruthy();
    });
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/analytics"),
    );
    const body = JSON.parse((post?.[1] as { body: string }).body);
    expect(body.event).toBe("agent.log_viewed");
    expect(body.metadata.agent_id).toBe("ag-1");
    expect(body.metadata.decision_count).toBe(2);
  });

  it("collapses to a quiet error state when the log fetch fails, without blanking the page or other sections", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        drift: () => mkRes({ baseline: null, events: [], latest: null }),
        log: () => mkRes({}, { ok: false, status: 500 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-error")).toBeInTheDocument());
    expect(screen.getByTestId("agent-log-error")).toHaveTextContent(/could not load this agent.+log/i);
    // The rest of the profile still renders: a log failure never blanks it.
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
    expect(screen.getByTestId("agent-drift-baseline")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-log-list")).not.toBeInTheDocument();
    // No view analytics fires on a failed load.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/analytics"),
    );
    expect(post).toBeFalsy();
  });

  it("Refresh re-fetches the granular log", async () => {
    let logGetCount = 0;
    let refreshed = false;
    const first = makeLogEntry({ id: "log-first", tool: "search_mail" });
    const second = makeLogEntry({ id: "log-second", tool: "create_event" });
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        log: () => {
          logGetCount += 1;
          return mkRes({ entries: refreshed ? [first, second] : [first] });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-row-log-first")).toBeInTheDocument());
    const afterMount = logGetCount;
    expect(screen.queryByTestId("agent-log-row-log-second")).not.toBeInTheDocument();

    refreshed = true;
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-log-refresh"));
    });

    await waitFor(() => expect(screen.getByTestId("agent-log-row-log-second")).toBeInTheDocument());
    // The Refresh fired at least one more log GET.
    expect(logGetCount).toBeGreaterThan(afterMount);
  });
});

describe("/admin/agents/[id]: connected systems (access)", () => {
  it("loads from the agent-connections endpoint and renders a BOUND row with unbind + authenticated-scan link", async () => {
    let connUrl = "";
    mockFetchWithRefresh.mockImplementation((url: unknown, init?: { method?: string }) => {
      const u = String(url);
      // Capture the connections GET (the read with no method) so we can assert
      // it targets the agent-scoped endpoint, not /api/admin/connectors.
      if (u.includes(AGENT_CONNECTIONS_PATH) && !init?.method) connUrl = u;
      return routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () =>
          mkRes({
            bound: [makeConnection({ connectorName: "acme-portal" })],
            available: [],
          }),
      })(url, init);
    });

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    // The section renders with its eyebrow + heading.
    await waitFor(() => expect(screen.getByTestId("agent-connections-section")).toBeInTheDocument());
    expect(screen.getByTestId("agent-connections-section")).toHaveTextContent(/connected systems/i);

    // The data source is the agent-scoped endpoint, not /api/admin/connectors.
    expect(connUrl).toContain("/api/admin/agents/ag-1/connections");

    // The bound row shows the name, baseUrl, and a "form login" badge.
    const row = screen.getByTestId("connection-row-acme-portal");
    expect(row).toHaveTextContent("acme-portal");
    expect(row).toHaveTextContent("https://app.acme.com");
    expect(screen.getByTestId("connection-authtype-acme-portal")).toHaveTextContent(/form login/i);

    // The authenticated-scan link points at the platform-scans surface.
    const scanLink = screen.getByTestId("scan-link-acme-portal");
    expect(scanLink).toHaveAttribute("href", "/admin/platform-scans");
    expect(scanLink).toHaveTextContent(/run authenticated scan/i);

    // The Unbind control is present on the bound row.
    expect(screen.getByTestId("unbind-acme-portal")).toHaveTextContent(/unbind/i);

    // The empty state must not show when a connection is bound.
    expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
  });

  it("shows the empty state when no system is connected to this agent", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () => mkRes({ bound: [], available: [] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("connections-empty")).toBeInTheDocument());
    expect(screen.getByTestId("connections-empty")).toHaveTextContent(/no system connected to this agent yet/i);
    expect(screen.queryByTestId("connections-list")).not.toBeInTheDocument();
  });

  it("clicking Unbind DELETEs { connectorName } to the agent-connections endpoint and reloads", async () => {
    // Bound before the unbind; the bound list is empty after the reload.
    let unbound = false;
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () =>
          unbound
            ? mkRes({ bound: [], available: [makeConnection({ connectorName: "acme-portal" })] })
            : mkRes({ bound: [makeConnection({ connectorName: "acme-portal" })], available: [] }),
        onUnbind: () => {
          unbound = true;
          return mkRes({ ok: true });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("connection-row-acme-portal")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId("unbind-acme-portal"));
    });

    // A DELETE went to the agent-connections endpoint with the connector name.
    const del = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "DELETE" &&
        String(c[0]).includes("/api/admin/agents/ag-1/connections"),
    );
    expect(del).toBeTruthy();
    const body = JSON.parse((del?.[1] as { body: string }).body);
    expect(body).toMatchObject({ connectorName: "acme-portal" });

    // The reload drops the row from the bound list and surfaces the empty state.
    await waitFor(() => expect(screen.getByTestId("connections-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("connection-row-acme-portal")).not.toBeInTheDocument();
  });

  it("binding an existing available connection POSTs { connectorName } and reloads it into the bound list", async () => {
    // Available before the bind; the connection moves into the bound list after.
    let bound = false;
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () =>
          bound
            ? mkRes({ bound: [makeConnection({ connectorName: "shared-crm" })], available: [] })
            : mkRes({ bound: [], available: [makeConnection({ connectorName: "shared-crm" })] }),
        onBind: () => {
          bound = true;
          return mkRes({ ok: true, bound: [makeConnection({ connectorName: "shared-crm" })] });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    // The bind-existing control shows because something is available to bind.
    await waitFor(() => expect(screen.getByTestId("bind-existing-select")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("bind-existing-select"), { target: { value: "shared-crm" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("bind-existing-submit"));
    });

    // A POST went to the agent-connections endpoint with the connector name.
    const post = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/agents/ag-1/connections"),
    );
    expect(post).toBeTruthy();
    const body = JSON.parse((post?.[1] as { body: string }).body);
    expect(body).toMatchObject({ connectorName: "shared-crm" });

    // The reload moves the connection into the bound list and the now-empty
    // available list hides the bind-existing control.
    await waitFor(() => expect(screen.getByTestId("connection-row-shared-crm")).toBeInTheDocument());
    expect(screen.queryByTestId("bind-existing-select")).not.toBeInTheDocument();
  });

  it("hides the bind-existing control when nothing is available to bind", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () => mkRes({ bound: [makeConnection({ connectorName: "acme-portal" })], available: [] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("connection-row-acme-portal")).toBeInTheDocument());
    expect(screen.queryByTestId("bind-existing-select")).not.toBeInTheDocument();
  });

  it("the add form creates a NEW connection then binds it to this agent (both POSTs fire), and reloads", async () => {
    // Empty before; the created+bound connection appears after the reload.
    let added = false;
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () =>
          added
            ? mkRes({ bound: [makeConnection({ connectorName: "client-crm" })], available: [] })
            : mkRes({ bound: [], available: [] }),
        onCreateConnector: () => mkRes({ connector: makeConnection({ connectorName: "client-crm" }) }, { status: 201 }),
        onBind: () => {
          added = true;
          return mkRes({ ok: true, bound: [makeConnection({ connectorName: "client-crm" })] });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("add-connection-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("conn-name"), { target: { value: "client-crm" } });
      fireEvent.change(screen.getByTestId("conn-base-url"), { target: { value: "https://app.client.com" } });
      fireEvent.change(screen.getByTestId("conn-username"), { target: { value: "ops@wolfpack.com" } });
      fireEvent.change(screen.getByTestId("conn-password"), { target: { value: "s3cret-pw" } });
    });
    // The login-path + session-cookie carry sensible defaults already.
    expect(screen.getByTestId("conn-login-path")).toHaveValue("/api/auth/login");
    expect(screen.getByTestId("conn-session-cookie")).toHaveValue("session");

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-connection-submit"));
    });

    // The CREATE POST went to /api/admin/connectors with the username_password body.
    const createPost = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/connectors"),
    );
    expect(createPost).toBeTruthy();
    const createBody = JSON.parse((createPost?.[1] as { body: string }).body);
    expect(createBody).toMatchObject({
      connectorName: "client-crm",
      baseUrl: "https://app.client.com",
      authType: "username_password",
      username: "ops@wolfpack.com",
      password: "s3cret-pw",
      loginPath: "/api/auth/login",
      sessionCookieName: "session",
    });

    // The BIND POST went to the agent-connections endpoint with the new name.
    const bindPost = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/agents/ag-1/connections"),
    );
    expect(bindPost).toBeTruthy();
    expect(JSON.parse((bindPost?.[1] as { body: string }).body)).toMatchObject({
      connectorName: "client-crm",
    });

    // The agent's bound list reloaded and now shows the connection; password cleared.
    await waitFor(() => expect(screen.getByTestId("connection-row-client-crm")).toBeInTheDocument());
    expect(screen.getByTestId("conn-password")).toHaveValue("");
  });

  it("selecting 'OAuth password' reveals the client-id/secret fields and defaults the token path", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () => mkRes({ bound: [], available: [] }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("add-connection-form")).toBeInTheDocument());

    // Hidden in the default username_password mode.
    expect(screen.queryByTestId("conn-client-id")).not.toBeInTheDocument();
    expect(screen.getByTestId("conn-session-cookie")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByTestId("conn-auth-type"), {
        target: { value: "oauth_password" },
      });
    });

    expect(screen.getByTestId("conn-client-id")).toBeInTheDocument();
    expect(screen.getByTestId("conn-client-secret")).toBeInTheDocument();
    expect(screen.getByTestId("conn-username")).toBeInTheDocument();
    expect(screen.getByTestId("conn-password")).toBeInTheDocument();
    // Token path swaps to the Salesforce default; session-cookie is hidden.
    expect(screen.getByTestId("conn-login-path")).toHaveValue("/services/oauth2/token");
    expect(screen.queryByTestId("conn-session-cookie")).not.toBeInTheDocument();
  });

  it("the oauth_password add creates then binds (both POSTs fire) and reloads", async () => {
    let added = false;
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () =>
          added
            ? mkRes({ bound: [makeConnection({ connectorName: "sf-sandbox", authType: "oauth_password" })], available: [] })
            : mkRes({ bound: [], available: [] }),
        onCreateConnector: () => mkRes({ connector: makeConnection({ connectorName: "sf-sandbox" }) }, { status: 201 }),
        onBind: () => {
          added = true;
          return mkRes({ ok: true, bound: [makeConnection({ connectorName: "sf-sandbox" })] });
        },
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("add-connection-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("conn-auth-type"), { target: { value: "oauth_password" } });
      fireEvent.change(screen.getByTestId("conn-name"), { target: { value: "sf-sandbox" } });
      fireEvent.change(screen.getByTestId("conn-base-url"), { target: { value: "https://test.salesforce.com" } });
      fireEvent.change(screen.getByTestId("conn-client-id"), { target: { value: "3MVG9key" } });
      fireEvent.change(screen.getByTestId("conn-client-secret"), { target: { value: "secret" } });
      fireEvent.change(screen.getByTestId("conn-username"), { target: { value: "sf@acme.com" } });
      fireEvent.change(screen.getByTestId("conn-password"), { target: { value: "pw+token" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("add-connection-submit"));
    });

    const createPost = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/connectors"),
    );
    expect(createPost).toBeTruthy();
    const body = JSON.parse((createPost?.[1] as { body: string }).body);
    expect(body).toMatchObject({
      connectorName: "sf-sandbox",
      baseUrl: "https://test.salesforce.com",
      authType: "oauth_password",
      clientId: "3MVG9key",
      clientSecret: "secret",
      username: "sf@acme.com",
      password: "pw+token",
      loginPath: "/services/oauth2/token",
    });
    expect(body.sessionCookieName).toBeUndefined();

    // The bind POST fired too.
    const bindPost = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/agents/ag-1/connections"),
    );
    expect(bindPost).toBeTruthy();
    expect(JSON.parse((bindPost?.[1] as { body: string }).body)).toMatchObject({ connectorName: "sf-sandbox" });

    // The list reloaded and shows the new connection; the password is cleared.
    await waitFor(() => expect(screen.getByTestId("connection-row-sf-sandbox")).toBeInTheDocument());
    expect(screen.getByTestId("conn-password")).toHaveValue("");
  });

  it("surfaces an inline error when the create fails, without blanking the page", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        connections: () => mkRes({ bound: [], available: [] }),
        onCreateConnector: () => mkRes({ error: "invalid connector" }, { ok: false, status: 400 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("add-connection-form")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("conn-name"), { target: { value: "bad" } });
      fireEvent.change(screen.getByTestId("conn-base-url"), { target: { value: "https://x.com" } });
      fireEvent.change(screen.getByTestId("conn-username"), { target: { value: "u@x.com" } });
      fireEvent.change(screen.getByTestId("conn-password"), { target: { value: "pw" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-connection-submit"));
    });

    await waitFor(() => expect(screen.getByTestId("connection-error")).toBeInTheDocument());
    expect(screen.getByTestId("connection-error")).toHaveTextContent(/invalid connector/i);
    // No bind POST fired because the create failed first.
    const bindPost = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).includes("/api/admin/agents/ag-1/connections"),
    );
    expect(bindPost).toBeFalsy();
    // The rest of the profile still renders: a failed add never blanks it.
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
  });
});

describe("/admin/agents/[id]: backup agent (failover for uptime)", () => {
  it("renders the backup section, populates the select from the OTHER agents, and shows the current backup", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        backup: () => mkRes({ backupAgentId: "ag-2" }),
        roster: () =>
          mkRes({
            agents: [
              { id: "ag-1", name: "Research Scout" }, // self -> excluded
              { id: "ag-2", name: "Backup Scout" },
              { id: "ag-3", name: "Spare Scout" },
            ],
          }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });

    await waitFor(() => expect(screen.getByTestId("agent-backup-section")).toBeInTheDocument());

    const select = screen.getByTestId("backup-select") as HTMLSelectElement;
    // "No backup" + the two OTHER agents (self excluded).
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(["", "ag-2", "ag-3"]);
    // The current backup is reflected on the select and the current-backup chip.
    await waitFor(() => expect(select.value).toBe("ag-2"));
    expect(screen.getByTestId("agent-backup-current-id")).toHaveTextContent("Backup Scout");
  });

  it("saves a designated backup via POST { backupAgentId }", async () => {
    const onBackup = jest.fn(() => mkRes({ ok: true, backupAgentId: "ag-3" }));
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        backup: () => mkRes({ backupAgentId: null }),
        roster: () =>
          mkRes({
            agents: [
              { id: "ag-1", name: "Research Scout" },
              { id: "ag-3", name: "Spare Scout" },
            ],
          }),
        onBackup,
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("backup-select")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("backup-select"), { target: { value: "ag-3" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("backup-save"));
    });

    await waitFor(() => expect(onBackup).toHaveBeenCalled());
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) =>
        (c[1] as { method?: string } | undefined)?.method === "POST" &&
        String(c[0]).endsWith("/api/admin/agents/ag-1/backup"),
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as { body: string }).body)).toEqual({ backupAgentId: "ag-3" });
    // The current-backup chip reflects the saved backup.
    await waitFor(() => expect(screen.getByTestId("agent-backup-current-id")).toHaveTextContent("Spare Scout"));
  });

  it("surfaces a self/cycle reject inline without blanking the profile", async () => {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({}, { ok: false, status: 404 }),
        backup: () => mkRes({ backupAgentId: null }),
        roster: () => mkRes({ agents: [{ id: "ag-3", name: "Spare Scout" }] }),
        onBackup: () => mkRes({ error: "backup_cycle" }, { ok: false, status: 400 }),
      }),
    );

    await act(async () => {
      render(<AgentProfilePage params={params} />);
    });
    await waitFor(() => expect(screen.getByTestId("backup-select")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("backup-select"), { target: { value: "ag-3" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("backup-save"));
    });

    await waitFor(() => expect(screen.getByTestId("backup-error")).toBeInTheDocument());
    expect(screen.getByTestId("backup-error")).toHaveTextContent(/loop/i);
    // The profile still renders: a failed save never blanks it.
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
  });
});

describe("/admin/agents/[id]: tabbed layout", () => {
  // A scan + tasks + connections + drift + log fixture so every tab's primary
  // section has rendered content (not just an empty state) to assert against.
  function renderTabbed() {
    mockFetchWithRefresh.mockImplementation(
      routeByUrl({
        agent: () => mkRes({ agent: makeAgent() }),
        scan: () => mkRes({ scan: makeScan() }),
        tasks: () => mkRes({ tasks: [makeTask({ id: "task-1" })] }),
        connections: () => mkRes({ bound: [makeConnection({ connectorName: "acme-portal" })], available: [] }),
        drift: () => mkRes({ baseline: makeBaseline(), events: [makeDriftEvent()], latest: makeDriftEvent() }),
        log: () => mkRes({ entries: [makeLogEntry({ id: "log-1" })] }),
      }),
    );
    return act(async () => {
      render(<AgentProfilePage params={params} />);
    });
  }

  it("renders the tab bar with all four tabs, Overview active by default", async () => {
    await renderTabbed();
    await waitFor(() => expect(screen.getByTestId("agent-tabs")).toBeInTheDocument());

    for (const key of ["overview", "work", "access", "activity"]) {
      expect(screen.getByTestId(`agent-tab-${key}`)).toBeInTheDocument();
    }
    // Overview is the default active tab; the others are not.
    expect(screen.getByTestId("agent-tab-overview")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("agent-tab-work")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("agent-tab-access")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("agent-tab-activity")).toHaveAttribute("aria-selected", "false");

    // The sticky header keeps the name, state chip, and lifecycle reachable.
    expect(screen.getByTestId("agent-header")).toBeInTheDocument();
    expect(screen.getByTestId("agent-name")).toBeInTheDocument();
    expect(screen.getByTestId("agent-state-chip")).toBeInTheDocument();
    expect(screen.getByTestId("agent-lifecycle")).toBeInTheDocument();
  });

  it("clicking a tab marks it active and deactivates the others", async () => {
    await renderTabbed();
    await waitFor(() => expect(screen.getByTestId("agent-tabs")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-tab-work"));
    });
    expect(screen.getByTestId("agent-tab-work")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("agent-tab-overview")).toHaveAttribute("aria-selected", "false");

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-tab-activity"));
    });
    expect(screen.getByTestId("agent-tab-activity")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("agent-tab-work")).toHaveAttribute("aria-selected", "false");
  });

  it("keeps every section mounted across tabs so all testids stay in the DOM regardless of the active tab", async () => {
    await renderTabbed();
    // On the default Overview tab, every section from every other tab is still
    // mounted (hidden, not unmounted) so its loaders ran and its testids exist.
    await waitFor(() => expect(screen.getByTestId("agent-scan-summary")).toBeInTheDocument());

    const sections = [
      "agent-identity", // overview
      "agent-scan-section", // overview
      "agent-tasks-section", // work
      "agent-approvals-section", // work
      "agent-backup-section", // access
      "agent-connections-section", // access
      "agent-drift-section", // activity
      "agent-log-section", // activity
      "agent-activity-link",
    ];
    for (const s of sections) {
      expect(screen.getByTestId(s)).toBeInTheDocument();
    }
    // Loaded content from non-active tabs is present too (panels are mounted).
    expect(screen.getByTestId("agent-tasks-list")).toBeInTheDocument();
    expect(screen.getByTestId("connection-row-acme-portal")).toBeInTheDocument();
    expect(screen.getByTestId("agent-drift-status")).toBeInTheDocument();
    expect(screen.getByTestId("agent-log-list")).toBeInTheDocument();

    // Switching tabs does not unmount anything: the same testids remain.
    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-tab-access"));
    });
    for (const s of sections) {
      expect(screen.getByTestId(s)).toBeInTheDocument();
    }
  });
});
