/**
 * Stuck-deploy reaper — regression lock.
 *
 * 2026-04-18: a user had to archive a site because its deploy row was
 * stuck at status=building forever. Root cause: the canary-deploy
 * workflow on the client repo either got cancelled (concurrent
 * dispatches) or died mid-run before the "Notify Instinct" webhook step
 * fired. Without a webhook callback, instinct_site_deploys stayed at
 * building and the UI spun on "Deploying…" indefinitely.
 *
 * Fix: getSiteProject() now calls reapStuckDeploys() which marks any
 * pending/building row older than DEPLOY_TIMEOUT_MS (10 min) as
 * failed, and flips the parent project's status to match. Idempotent
 * — safe to call on every GET. This test locks the SQL shape so a
 * future refactor can't accidentally skip the reaper or drop the time
 * predicate.
 */

import { jest } from "@jest/globals";

// Track every SQL call so we can assert shape + param wiring.
const queries: Array<{ sql: string; params: unknown[] }> = [];
let nextUpdateResult: { rows: Array<{ id: string }>; fromCache: boolean } = {
  rows: [],
  fromCache: false,
};
let projectRow: Record<string, unknown> | null = {
  id: "site_x",
  client_slug: "x",
  display_name: "X",
  brief: { client: "x", product: { name: "X" }, pages: [] },
  github_repo: null,
  github_repo_url: null,
  preview_url: null,
  status: "deploying",
  last_deploy_id: null,
  last_canary_passed: null,
  agentic_findings: [],
  created_by: "u",
  created_at: "2026-04-18T00:00:00Z",
  updated_at: "2026-04-18T00:00:00Z",
};

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    const compact = sql.replace(/\s+/g, " ").trim();
    if (compact.startsWith("UPDATE instinct_site_deploys")) {
      return nextUpdateResult;
    }
    if (compact.startsWith("UPDATE instinct_site_projects")) {
      return { rows: [], fromCache: false };
    }
    if (compact.startsWith("SELECT * FROM instinct_site_projects")) {
      return {
        rows: projectRow ? [projectRow] : [],
        fromCache: false,
      };
    }
    return { rows: [], fromCache: false };
  }),
  pool: {},
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({}),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import { getSiteProject } from "@/lib/sites";

describe("reapStuckDeploys (via getSiteProject)", () => {
  beforeEach(() => {
    queries.length = 0;
    nextUpdateResult = { rows: [], fromCache: false };
    projectRow = {
      id: "site_x",
      client_slug: "x",
      display_name: "X",
      brief: { client: "x", product: { name: "X" }, pages: [] },
      github_repo: null,
      github_repo_url: null,
      preview_url: null,
      status: "deploying",
      last_deploy_id: null,
      last_canary_passed: null,
      agentic_findings: [],
      created_by: "u",
      created_at: "2026-04-18T00:00:00Z",
      updated_at: "2026-04-18T00:00:00Z",
    };
  });

  it("calls UPDATE on instinct_site_deploys with WHERE status IN (pending, building) before reading the project", async () => {
    await getSiteProject("site_x");
    const reaperCall = queries.find((q) =>
      q.sql.replace(/\s+/g, " ").includes("UPDATE instinct_site_deploys"),
    );
    expect(reaperCall).toBeDefined();
    const compact = reaperCall!.sql.replace(/\s+/g, " ");
    expect(compact).toMatch(/WHERE[\s\S]*project_id = \$1/);
    expect(compact).toMatch(/status IN \('pending','building'\)/);
    expect(compact).toMatch(/started_at < NOW\(\) - /);
    // The project read must happen AFTER the reaper so stale state
    // never leaks into the response.
    const reaperIdx = queries.findIndex((q) =>
      q.sql.includes("UPDATE instinct_site_deploys"),
    );
    const readIdx = queries.findIndex((q) =>
      q.sql.includes("SELECT * FROM instinct_site_projects"),
    );
    expect(reaperIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(reaperIdx);
  });

  it("passes the project id + a positive timeout as SQL params", async () => {
    await getSiteProject("site_abc");
    const reaperCall = queries.find((q) =>
      q.sql.includes("UPDATE instinct_site_deploys"),
    );
    expect(reaperCall!.params[0]).toBe("site_abc");
    expect(typeof reaperCall!.params[1]).toBe("number");
    expect(reaperCall!.params[1] as number).toBeGreaterThan(0);
    // Sanity: the timeout should be minutes, not seconds.
    expect(reaperCall!.params[1] as number).toBeGreaterThan(60_000);
  });

  it("flips the project's status to failed when rows were reaped", async () => {
    // Simulate the reaper finding + marking 1 stale row.
    nextUpdateResult = { rows: [{ id: "deploy_stale" }], fromCache: false };
    await getSiteProject("site_x");
    const projectUpdate = queries.find(
      (q) =>
        q.sql.replace(/\s+/g, " ").includes("UPDATE instinct_site_projects") &&
        q.sql.includes("status = 'failed'"),
    );
    expect(projectUpdate).toBeDefined();
    expect(projectUpdate!.sql).toMatch(
      /status\s+IN\s*\(\s*'provisioning','deploying'\s*\)/,
    );
  });

  it("skips the project-status UPDATE when no rows were reaped", async () => {
    nextUpdateResult = { rows: [], fromCache: false };
    await getSiteProject("site_x");
    const projectUpdate = queries.find(
      (q) =>
        q.sql.replace(/\s+/g, " ").includes("UPDATE instinct_site_projects") &&
        q.sql.includes("status = 'failed'"),
    );
    expect(projectUpdate).toBeUndefined();
  });

  it("non-fatal: if the reaper throws, we still return the project row", async () => {
    // Make the UPDATE throw once.
    const dbMod = await import("@/lib/db");
    const original = dbMod.safeQuery as unknown as jest.Mock;
    (original.mockImplementationOnce as (fn: (sql: string) => Promise<{rows: unknown[]; fromCache: boolean}>) => unknown)(async (sql: string) => {
      if (sql.includes("UPDATE instinct_site_deploys")) {
        throw new Error("simulated db blip");
      }
      return { rows: [], fromCache: false };
    });
    const proj = await getSiteProject("site_x");
    expect(proj).not.toBeNull();
    expect(proj!.id).toBe("site_x");
  });
});
