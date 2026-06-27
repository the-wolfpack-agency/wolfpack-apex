/**
 * Client-offboarding purge. The analytics + audit boundaries are mocked; the db,
 * Qdrant, and Neo4j boundaries are passed in as INJECTABLE DEPS so the purge runs
 * entirely against in-memory fakes - no real infra touched.
 *
 * Asserts:
 *   - the purge issues one workspace-scoped DELETE against EVERY enumerated table
 *     and returns per-table counts;
 *   - Qdrant + Neo4j purges fire scoped to the workspace;
 *   - the offboarding_log row is written with counts + residue;
 *   - recordAudit + the registered analytics event fire with the right shape;
 *   - a SECOND purge returns all-zero counts (idempotent), never throws;
 *   - a down secondary store completes the Postgres purge + records residue, and
 *     never throws.
 */

const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn().mockResolvedValue({ id: "a1", seq: 1, entryHash: "h" });

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));
// Keep the real db / qdrant / neo4j modules out of the picture: the purge takes
// injectable deps for all three, and BRAIN_COLLECTION is the only import from the
// brain module (a const), so no network is reachable from this test.

import {
  offboardWorkspace,
  PLATFORM_SCAN_WORKSPACE_TABLES,
  type OffboardDeps,
} from "@/lib/platform-scan/offboarding";

const ACTOR = { user_id: "cto-1", role: "cto" };

/** A fake writeQuery backed by a per-table row store. DELETE returns one row per
 *  stored row (RETURNING 1), then empties the table - so a re-run returns zero. */
function makeDb(seed: Partial<Record<string, number>> = {}) {
  const tables = new Map<string, number>();
  for (const t of PLATFORM_SCAN_WORKSPACE_TABLES) tables.set(t, seed[t] ?? 0);
  const calls: { sql: string; params: unknown[] }[] = [];
  // Matches OffboardDeps.writeQuery's generic signature so it type-checks when
  // injected. The row payload shape is irrelevant to the purge (it only counts
  // rows.length), so we return rows cast to the caller's T.
  const writeQuery = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> => {
    calls.push({ sql, params });
    const m = sql.match(/DELETE FROM (\S+) WHERE workspace_id/i);
    if (m) {
      const table = m[1];
      const n = tables.get(table) ?? 0;
      tables.set(table, 0); // purged
      return { rows: Array.from({ length: n }, () => ({ id: 1 })) as unknown as T[] };
    }
    // offboarding_log INSERT (or anything else): no rows.
    return { rows: [] };
  };
  return { writeQuery, calls, tables };
}

beforeEach(() => jest.clearAllMocks());

describe("offboardWorkspace", () => {
  it("deletes from every enumerated table, purges Qdrant + Neo4j, returns counts", async () => {
    const db = makeDb({
      instinct_platform_scan_findings: 12,
      instinct_platform_scans: 3,
      instinct_scan_targets: 1,
      instinct_connector_credentials: 2,
    });
    const purgeQdrant = jest.fn(async () => true);
    const purgeNeo4j = jest.fn(async () => true);
    const deps: OffboardDeps = { writeQuery: db.writeQuery, purgeQdrant, purgeNeo4j };

    const result = await offboardWorkspace("acme-crm", ACTOR, deps);

    // One DELETE per enumerated table, each scoped to the workspace.
    for (const table of PLATFORM_SCAN_WORKSPACE_TABLES) {
      const del = db.calls.find((c) => new RegExp(`DELETE FROM ${table}\\b`).test(c.sql));
      expect(del).toBeTruthy();
      expect(del!.params).toEqual(["acme-crm"]);
    }

    // Per-table counts reflect what each DELETE removed.
    expect(result.counts.instinct_platform_scan_findings).toBe(12);
    expect(result.counts.instinct_platform_scans).toBe(3);
    expect(result.counts.instinct_scan_targets).toBe(1);
    expect(result.counts.instinct_connector_credentials).toBe(2);
    expect(result.totalDeleted).toBe(18);

    // Secondary stores purged, scoped to the workspace, residue empty.
    expect(purgeQdrant).toHaveBeenCalledWith("acme-crm");
    expect(purgeNeo4j).toHaveBeenCalledWith("acme-crm");
    expect(result.residue).toEqual({});
    expect(result.secondaryStoresClean).toBe(true);
  });

  it("writes the offboarding_log row with counts + residue", async () => {
    const db = makeDb({ instinct_platform_scan_findings: 5 });
    await offboardWorkspace("acme-crm", ACTOR, {
      writeQuery: db.writeQuery,
      purgeQdrant: async () => true,
      purgeNeo4j: async () => true,
    });

    const logInsert = db.calls.find((c) => /INSERT INTO instinct_workspace_offboarding_log/i.test(c.sql));
    expect(logInsert).toBeTruthy();
    // params: [workspaceId, requested_by, counts json, residue json]
    expect(logInsert!.params[0]).toBe("acme-crm");
    expect(logInsert!.params[1]).toBe("cto-1");
    const counts = JSON.parse(String(logInsert!.params[2]));
    expect(counts.instinct_platform_scan_findings).toBe(5);
    expect(JSON.parse(String(logInsert!.params[3]))).toEqual({});
  });

  it("fires recordAudit + the registered analytics event with the purge shape", async () => {
    const db = makeDb({
      instinct_platform_scan_findings: 7,
      instinct_platform_scans: 2,
      instinct_scan_targets: 1,
      instinct_connector_credentials: 4,
    });
    await offboardWorkspace("acme-crm", ACTOR, {
      writeQuery: db.writeQuery,
      purgeQdrant: async () => true,
      purgeNeo4j: async () => true,
    });

    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("platform.workspace_offboarded");
    expect(auditArg.resourceType).toBe("workspace");
    expect(auditArg.resourceId).toBe("acme-crm");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "platform.workspace_offboarded",
      "cto-1",
      "cto",
      expect.objectContaining({
        workspace_id: "acme-crm",
        purged_findings: 7,
        purged_scans: 2,
        purged_targets: 1,
        purged_credentials: 4,
      }),
    );
  });

  it("is idempotent: a second purge returns all-zero counts and does not throw", async () => {
    const db = makeDb({ instinct_platform_scan_findings: 9, instinct_scan_targets: 1 });
    const deps: OffboardDeps = {
      writeQuery: db.writeQuery,
      purgeQdrant: async () => true,
      purgeNeo4j: async () => true,
    };

    const first = await offboardWorkspace("acme-crm", ACTOR, deps);
    expect(first.totalDeleted).toBe(10);

    const second = await offboardWorkspace("acme-crm", ACTOR, deps);
    expect(second.totalDeleted).toBe(0);
    for (const table of PLATFORM_SCAN_WORKSPACE_TABLES) {
      expect(second.counts[table]).toBe(0);
    }
  });

  it("completes the Postgres purge + records residue when a secondary store is down (never throws)", async () => {
    const db = makeDb({ instinct_platform_scan_findings: 4 });
    // Qdrant returns false (unreachable); Neo4j throws (transport error). Both
    // must be tolerated, the Postgres purge must complete, residue recorded.
    const result = await offboardWorkspace("acme-crm", ACTOR, {
      writeQuery: db.writeQuery,
      purgeQdrant: async () => false,
      purgeNeo4j: async () => {
        throw new Error("neo4j down");
      },
    });

    expect(result.counts.instinct_platform_scan_findings).toBe(4); // PG purge still ran
    expect(result.residue).toEqual({ qdrant: "unreachable", neo4j: "unreachable" });
    expect(result.secondaryStoresClean).toBe(false);

    // Residue is persisted in the ledger row, never silently dropped.
    const logInsert = db.calls.find((c) => /INSERT INTO instinct_workspace_offboarding_log/i.test(c.sql));
    expect(JSON.parse(String(logInsert!.params[3]))).toEqual({ qdrant: "unreachable", neo4j: "unreachable" });
  });
});
