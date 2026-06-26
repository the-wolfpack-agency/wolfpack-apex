/**
 * GOVERNED backup-agent failover store tests.
 *
 * Covers the three exported behaviors and the invariants:
 *   setBackupAgent     — valid, self-reject, cross-workspace reject, cycle reject.
 *   reclaimStalledTasks — stuck running task requeued; over-cap -> failed; fresh
 *                         running untouched.
 *   failoverUnhealthyAgents — paused primary + scope-compatible ACTIVE backup ->
 *                         tasks reassigned (status stays queued) + events + notify;
 *                         backup MISSING a connection -> NOT reassigned + alert;
 *                         backup inactive -> skip; healthy primary -> no failover.
 *
 * The DB (safeQuery/writeQuery), analytics, audit, notify, getAgent, and
 * listAgentConnectionNames are all mocked. safeQuery is routed by SQL so each
 * read (table probe, backup id, queued tasks, stalled tasks, primaries) returns
 * the right rows independently.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));

const mockGetAgent = jest.fn();
const mockListAgents = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  getAgent: (...a: unknown[]) => mockGetAgent(...a),
  listAgents: (...a: unknown[]) => mockListAgents(...a),
}));

const mockListConn = jest.fn();
jest.mock("@/lib/agents/connections/store", () => ({
  listAgentConnectionNames: (...a: unknown[]) => mockListConn(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

const mockNotify = jest.fn();
jest.mock("@/lib/notifications/in-app", () => ({ notify: (...a: unknown[]) => mockNotify(...a) }));

import {
  setBackupAgent,
  reclaimStalledTasks,
  failoverUnhealthyAgents,
  RETRY_CAP,
} from "@/lib/agents/failover/store";

const WS = "ws-1";

function agent(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "a_primary",
    workspaceId: WS,
    name: "Primary",
    role: "dev",
    ownerUserId: "u_owner",
    state: "active",
    identityProvider: "local",
    externalSubject: null,
    scanStatus: "complete",
    description: null,
    createdBy: "u_cto",
    createdAt: new Date().toISOString(),
    activatedAt: null,
    lastSeenAt: null,
    revokedAt: null,
    connections: [],
    ...over,
  };
}

/** Default safeQuery router: table probe -> instinct_agents; everything else empty. */
function baseSafeQuery() {
  mockSafeQuery.mockImplementation(async (sql: string) => {
    if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: "instinct_agents" }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteQuery.mockResolvedValue({ rows: [] });
  mockRecordAudit.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue({ id: "n1" });
  mockListConn.mockResolvedValue([]);
  baseSafeQuery();
});

// ---------------------------------------------------------------------------
// setBackupAgent
// ---------------------------------------------------------------------------

describe("setBackupAgent", () => {
  it("sets a valid backup (different, existing, same workspace, no cycle) + audits", async () => {
    mockGetAgent.mockImplementation(async (id: string) =>
      id === "a_primary" ? agent() : agent({ id: "a_backup", name: "Backup" }),
    );
    // getBackupAgentId for the backup -> no backup -> no cycle.
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: "instinct_agents" }] };
      if (/backup_agent_id FROM/.test(sql)) return { rows: [{ backup_agent_id: null }] };
      return { rows: [] };
    });

    const res = await setBackupAgent(WS, "a_primary", "a_backup", { userId: "u_cto", role: "cto" });
    expect(res.ok).toBe(true);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    expect(mockWriteQuery.mock.calls[0][1]).toEqual(["a_primary", WS, "a_backup"]);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.backup_designated",
      "u_cto",
      "cto",
      expect.objectContaining({ agent_id: "a_primary", backup_agent_id: "a_backup", cleared: false }),
    );
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][0].action).toBe("agent.backup_designated");
  });

  it("clears the backup with null", async () => {
    mockGetAgent.mockResolvedValue(agent());
    const res = await setBackupAgent(WS, "a_primary", null, { userId: "u_cto", role: "cto" });
    expect(res.ok).toBe(true);
    expect(mockWriteQuery.mock.calls[0][1]).toEqual(["a_primary", WS, null]);
    expect(mockTrackEvent.mock.calls[0][3]).toEqual(
      expect.objectContaining({ cleared: true }),
    );
  });

  it("rejects an agent as its own backup (self)", async () => {
    mockGetAgent.mockResolvedValue(agent());
    const res = await setBackupAgent(WS, "a_primary", "a_primary", { userId: "u_cto", role: "cto" });
    expect(res).toEqual({ ok: false, code: "backup_is_self" });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("rejects a backup that does not exist in the workspace (cross-workspace)", async () => {
    // primary exists; backup lookup returns null (getAgent is workspace-scoped).
    mockGetAgent.mockImplementation(async (id: string) =>
      id === "a_primary" ? agent() : null,
    );
    const res = await setBackupAgent(WS, "a_primary", "a_other_ws", { userId: "u_cto", role: "cto" });
    expect(res).toEqual({ ok: false, code: "backup_not_found" });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("rejects a cycle (backup already designates this agent as ITS backup)", async () => {
    mockGetAgent.mockImplementation(async (id: string) =>
      id === "a_primary" ? agent() : agent({ id: "a_backup", name: "Backup" }),
    );
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: "instinct_agents" }] };
      // The backup's backup is the primary -> a -> b -> a cycle.
      if (/backup_agent_id FROM/.test(sql)) return { rows: [{ backup_agent_id: "a_primary" }] };
      return { rows: [] };
    });
    const res = await setBackupAgent(WS, "a_primary", "a_backup", { userId: "u_cto", role: "cto" });
    expect(res).toEqual({ ok: false, code: "backup_cycle" });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("rejects when the primary itself does not exist", async () => {
    mockGetAgent.mockResolvedValue(null);
    const res = await setBackupAgent(WS, "a_missing", "a_backup", { userId: "u_cto", role: "cto" });
    expect(res).toEqual({ ok: false, code: "agent_not_found" });
  });
});

// ---------------------------------------------------------------------------
// reclaimStalledTasks
// ---------------------------------------------------------------------------

describe("reclaimStalledTasks", () => {
  it("requeues a stuck running task that is under the retry cap", async () => {
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: "instinct_agents" }] };
      if (/status = 'running'/.test(sql)) {
        return { rows: [{ id: "t1", agent_id: "a1", workspace_id: WS, retry_count: 0 }] };
      }
      return { rows: [] };
    });
    const out = await reclaimStalledTasks(WS);
    expect(out).toEqual({ reclaimed: 1, requeued: 1, failed: 0 });
    // The requeue UPDATE sets status back to 'queued' and bumps retry_count.
    const updateSql = String(mockWriteQuery.mock.calls[0][0]);
    expect(updateSql).toMatch(/status = 'queued'/);
    expect(updateSql).toMatch(/retry_count/);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.task_reclaimed",
      "a1",
      "agent",
      expect.objectContaining({ task_id: "t1", action: "requeued" }),
    );
  });

  it("marks a stuck task FAILED once it is over the retry cap", async () => {
    mockSafeQuery.mockImplementation(async (sql: string) => {
      if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: "instinct_agents" }] };
      if (/status = 'running'/.test(sql)) {
        return { rows: [{ id: "t2", agent_id: "a1", workspace_id: WS, retry_count: RETRY_CAP }] };
      }
      return { rows: [] };
    });
    const out = await reclaimStalledTasks(WS);
    expect(out).toEqual({ reclaimed: 1, requeued: 0, failed: 1 });
    expect(String(mockWriteQuery.mock.calls[0][0])).toMatch(/status = 'failed'/);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.task_reclaimed",
      "a1",
      "agent",
      expect.objectContaining({ task_id: "t2", action: "failed" }),
    );
  });

  it("leaves a fresh running task untouched (no stalled rows returned)", async () => {
    // The SQL filters by started_at age; a fresh task simply isn't returned.
    baseSafeQuery();
    const out = await reclaimStalledTasks(WS);
    expect(out).toEqual({ reclaimed: 0, requeued: 0, failed: 0 });
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// failoverUnhealthyAgents
// ---------------------------------------------------------------------------

/** Route safeQuery for the failover sweep: table probe, the unhealthy-primaries
 *  read, and the per-primary queued-task read. */
function routeFailover(opts: {
  primaries: Array<{ id: string; workspace_id: string; backup_agent_id: string | null; owner_user_id: string | null }>;
  queued?: Array<{ id: string }>;
}) {
  mockSafeQuery.mockImplementation(async (sql: string) => {
    if (/information_schema\.tables/.test(sql)) return { rows: [{ table_name: "instinct_agents" }] };
    if (/state IN \('paused', 'revoked'\)/.test(sql)) return { rows: opts.primaries };
    if (/status = 'queued'/.test(sql)) return { rows: opts.queued ?? [] };
    return { rows: [] };
  });
}

describe("failoverUnhealthyAgents", () => {
  it("reassigns a paused primary's queued tasks to a scope-compatible ACTIVE backup", async () => {
    routeFailover({
      primaries: [{ id: "a_primary", workspace_id: WS, backup_agent_id: "a_backup", owner_user_id: "u_owner" }],
      queued: [{ id: "t1" }, { id: "t2" }],
    });
    mockGetAgent.mockResolvedValue(agent({ id: "a_backup", name: "Backup", state: "active" }));
    // Primary bound to [salesforce]; backup bound to [salesforce, jira] -> superset OK.
    mockListConn.mockImplementation(async (_ws: string, id: string) =>
      id === "a_primary" ? ["salesforce"] : ["salesforce", "jira"],
    );

    const out = await failoverUnhealthyAgents(WS);
    expect(out.reassigned).toBe(2);
    expect(out.skipped).toBe(0);
    expect(out.reassignments[0]).toEqual(
      expect.objectContaining({ primaryAgentId: "a_primary", backupAgentId: "a_backup", taskCount: 2 }),
    );

    // Each task UPDATE keeps status = 'queued' (governance not bypassed): the
    // UPDATE only sets agent_id and is guarded by "status = 'queued'".
    const taskUpdates = mockWriteQuery.mock.calls.filter((c) => /SET agent_id =/.test(String(c[0])));
    expect(taskUpdates).toHaveLength(2);
    for (const c of taskUpdates) {
      expect(String(c[0])).toMatch(/status = 'queued'/);
      expect(c[1][0]).toBe("a_backup"); // reassigned TO the backup
    }

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.failover_triggered",
      "a_primary",
      "agent",
      expect.objectContaining({ primary_agent_id: "a_primary", backup_agent_id: "a_backup", task_count: 2 }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.task_reassigned",
      "a_primary",
      "agent",
      expect.objectContaining({ task_id: "t1", from_agent_id: "a_primary", to_agent_id: "a_backup" }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.failover_triggered", resourceId: "a_primary" }),
    );
    expect(mockNotify).toHaveBeenCalled();
  });

  it("does NOT reassign when the backup is MISSING a connection the primary holds (no scope escalation)", async () => {
    routeFailover({
      primaries: [{ id: "a_primary", workspace_id: WS, backup_agent_id: "a_backup", owner_user_id: "u_owner" }],
      queued: [{ id: "t1" }],
    });
    mockGetAgent.mockResolvedValue(agent({ id: "a_backup", name: "Backup", state: "active" }));
    // Primary needs [salesforce, jira]; backup only has [salesforce] -> missing jira.
    mockListConn.mockImplementation(async (_ws: string, id: string) =>
      id === "a_primary" ? ["salesforce", "jira"] : ["salesforce"],
    );

    const out = await failoverUnhealthyAgents(WS);
    expect(out.reassigned).toBe(0);
    expect(out.skipped).toBe(1);
    // No task UPDATE happened: scope gap means failover is refused, not forced.
    expect(mockWriteQuery.mock.calls.filter((c) => /SET agent_id =/.test(String(c[0])))).toHaveLength(0);
    expect(mockTrackEvent).not.toHaveBeenCalledWith("agent.failover_triggered", expect.anything(), expect.anything(), expect.anything());
    // The owner is alerted that failover was skipped for scope reasons.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ source: "agent_failover", body: expect.stringMatching(/missing connection/i) }),
    );
  });

  it("skips when the backup is INACTIVE (paused/revoked) and never resurrects work onto it", async () => {
    routeFailover({
      primaries: [{ id: "a_primary", workspace_id: WS, backup_agent_id: "a_backup", owner_user_id: "u_owner" }],
      queued: [{ id: "t1" }],
    });
    mockGetAgent.mockResolvedValue(agent({ id: "a_backup", name: "Backup", state: "paused" }));
    mockListConn.mockResolvedValue([]);

    const out = await failoverUnhealthyAgents(WS);
    expect(out.reassigned).toBe(0);
    expect(out.skipped).toBe(1);
    expect(mockWriteQuery.mock.calls.filter((c) => /SET agent_id =/.test(String(c[0])))).toHaveLength(0);
    // Scope check is never even reached for an inactive backup.
    expect(mockListConn).not.toHaveBeenCalled();
  });

  it("does nothing for a healthy roster (no paused/revoked primaries with a backup)", async () => {
    routeFailover({ primaries: [] });
    const out = await failoverUnhealthyAgents(WS);
    expect(out).toEqual({ reassigned: 0, skipped: 0, reassignments: [] });
    expect(mockWriteQuery).not.toHaveBeenCalled();
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it("skips an unhealthy primary that has a backup but NO queued work", async () => {
    routeFailover({
      primaries: [{ id: "a_primary", workspace_id: WS, backup_agent_id: "a_backup", owner_user_id: "u_owner" }],
      queued: [],
    });
    const out = await failoverUnhealthyAgents(WS);
    expect(out).toEqual({ reassigned: 0, skipped: 0, reassignments: [] });
    // No queued work -> we never even look up the backup.
    expect(mockGetAgent).not.toHaveBeenCalled();
  });
});
