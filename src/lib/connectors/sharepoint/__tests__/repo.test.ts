/**
 * SharePoint connector repo — DB-layer tests with an injectable fake
 * query runner. Validates that every method maps the row shape to the
 * domain type correctly and emits the expected SQL.
 */

import { createRepo, type QueryRunner } from "@/lib/connectors/sharepoint/repo";

/* The state object is returned by reference so tests can mutate
 * `fake.rowCount = N` and the closure-captured query runner sees it. */
function fakeQR() {
  const state = {
    calls: [] as Array<{ sql: string; params: unknown[] }>,
    rows: [] as Record<string, unknown>[],
    rowCount: 0,
  };
  const qr: QueryRunner = async (sql, params = []) => {
    state.calls.push({ sql, params });
    return {
      command: "",
      rowCount: state.rowCount,
      oid: 0,
      fields: [],
      rows: state.rows as never,
    };
  };
  return Object.assign(state, { qr });
}

const sourceRow = {
  id: "src-1",
  workspace_id: "ws-1",
  name: "PCNA Evals",
  site_url: "https://x.sharepoint.com/sites/PCNAINTERNAL",
  site_id: "site-abc",
  drive_id: "drive-xyz",
  folder_path: "Shared Documents/Program Evals",
  created_by: "u1",
  created_at: "2026-05-16T00:00:00Z",
  last_synced_at: null,
  is_active: true,
};

describe("createRepo", () => {
  test("insertSource: maps row to domain type", async () => {
    const fake = fakeQR();
    fake.rows.push(sourceRow);
    const repo = createRepo(fake.qr);
    const out = await repo.insertSource({
      workspaceId: "ws-1",
      name: "PCNA Evals",
      siteUrl: sourceRow.site_url,
      siteId: "site-abc",
      driveId: "drive-xyz",
      folderPath: "Shared Documents/Program Evals",
      createdBy: "u1",
    });
    expect(out).toEqual({
      id: "src-1",
      workspaceId: "ws-1",
      name: "PCNA Evals",
      siteUrl: sourceRow.site_url,
      siteId: "site-abc",
      driveId: "drive-xyz",
      folderPath: "Shared Documents/Program Evals",
      createdBy: "u1",
      createdAt: "2026-05-16T00:00:00Z",
      lastSyncedAt: null,
      isActive: true,
    });
    expect(fake.calls[0].sql).toMatch(/INSERT INTO instinct_sharepoint_sources/);
  });

  test("listSources: filters active + workspace", async () => {
    const fake = fakeQR();
    fake.rows.push(sourceRow);
    const repo = createRepo(fake.qr);
    const out = await repo.listSources("ws-1");
    expect(out).toHaveLength(1);
    expect(fake.calls[0].sql).toMatch(/is_active = TRUE/);
    expect(fake.calls[0].params).toEqual(["ws-1"]);
  });

  test("getSource: returns null when no rows", async () => {
    const fake = fakeQR();
    const repo = createRepo(fake.qr);
    const out = await repo.getSource("missing", "ws-1");
    expect(out).toBeNull();
  });

  test("deactivateSource: returns false when rowCount=0", async () => {
    const fake = fakeQR();
    fake.rowCount = 0;
    const repo = createRepo(fake.qr);
    expect(await repo.deactivateSource("missing", "ws-1")).toBe(false);
  });

  test("deactivateSource: returns true when one row updated", async () => {
    const fake = fakeQR();
    fake.rowCount = 1;
    const repo = createRepo(fake.qr);
    expect(await repo.deactivateSource("src-1", "ws-1")).toBe(true);
    expect(fake.calls[0].sql).toMatch(/UPDATE instinct_sharepoint_sources/);
    expect(fake.calls[0].sql).toMatch(/is_active = FALSE/);
  });

  test("startJob + finishJob: writes both rows with correct status", async () => {
    const fake = fakeQR();
    const jobRow = {
      id: "job-1",
      source_id: "src-1",
      triggered_by: "u1",
      started_at: "2026-05-16T01:00:00Z",
      ended_at: null,
      status: "running",
      file_count: 0,
      success_count: 0,
      fail_count: 0,
      bytes_ingested: 0,
      error: null,
    };
    fake.rows.push(jobRow);
    const repo = createRepo(fake.qr);
    const job = await repo.startJob("src-1", "u1");
    expect(job.id).toBe("job-1");
    expect(job.status).toBe("running");
    await repo.finishJob("job-1", {
      status: "succeeded",
      fileCount: 5,
      successCount: 5,
      failCount: 0,
      bytesIngested: 123456,
    });
    expect(fake.calls[1].sql).toMatch(/UPDATE instinct_sharepoint_ingest_jobs/);
    expect(fake.calls[1].params[1]).toBe("succeeded");
    expect(fake.calls[1].params[2]).toBe(5);
  });

  test("touchLastSynced: bumps the timestamp", async () => {
    const fake = fakeQR();
    const repo = createRepo(fake.qr);
    await repo.touchLastSynced("src-1");
    expect(fake.calls[0].sql).toMatch(/SET last_synced_at = NOW\(\)/);
    expect(fake.calls[0].params).toEqual(["src-1"]);
  });

  test("reconcileStuckJobs: marks running jobs older than threshold as failed", async () => {
    const fake = fakeQR();
    fake.rowCount = 3;
    const repo = createRepo(fake.qr);
    const updated = await repo.reconcileStuckJobs(6);
    expect(updated).toBe(3);
    expect(fake.calls[0].sql).toMatch(/UPDATE instinct_sharepoint_ingest_jobs/);
    expect(fake.calls[0].sql).toMatch(/SET status = 'failed'/);
    expect(fake.calls[0].sql).toMatch(/started_at < NOW\(\) - \(INTERVAL '1 minute' \* \$1\)/);
    expect(fake.calls[0].params).toEqual([6]);
  });

  test("listJobsForSource: handles bytes_ingested coming back as string (pg bigint)", async () => {
    const fake = fakeQR();
    fake.rows.push({
      id: "j",
      source_id: "src-1",
      triggered_by: "u1",
      started_at: "2026-05-16T00:00:00Z",
      ended_at: "2026-05-16T00:01:00Z",
      status: "succeeded",
      file_count: 3,
      success_count: 3,
      fail_count: 0,
      /* pg returns bigint as a string by default */
      bytes_ingested: "1234567890",
      error: null,
    });
    const repo = createRepo(fake.qr);
    const out = await repo.listJobsForSource("src-1");
    expect(out[0].bytesIngested).toBe(1234567890);
  });
});
