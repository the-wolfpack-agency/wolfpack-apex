/**
 * Sites secret-provisioning test — verifies triggerDeploy wires through to
 * provisionClientRepoSecrets right after a fresh repo is created, and that
 * every failure path is non-fatal (the deploy still completes, every
 * outcome emits an analytics event so the learning loop sees what went
 * through vs what needs manual intervention).
 *
 * Mocks everything so no real Vercel/GitHub/libsodium calls happen. The
 * sites-e2e harness is kept intact on purpose — this file exists so we can
 * assert the provisioning contract without touching that stateful runner.
 */

const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockCreateRepo = jest.fn();
const mockPutFile = jest.fn();
const mockTriggerWorkflow = jest.fn();
const mockEnableActions = jest.fn();
jest.mock("@/lib/github-client", () => ({
  createRepoFromTemplate: (...args: unknown[]) => mockCreateRepo(...args),
  putFile: (...args: unknown[]) => mockPutFile(...args),
  triggerWorkflow: (...args: unknown[]) => mockTriggerWorkflow(...args),
  enableActions: (...args: unknown[]) => mockEnableActions(...args),
  defaultGithubClient: () => ({ token: "test", fetch: jest.fn() }),
}));

const mockSetRepoSecret = jest.fn();
jest.mock("@/lib/github-secrets", () => ({
  setRepoSecret: (...args: unknown[]) => mockSetRepoSecret(...args),
}));

const mockCreateVercelProject = jest.fn();
jest.mock("@/lib/vercel-client", () => ({
  defaultVercelClient: () => ({ token: "vt", teamId: "team_1", fetch: jest.fn() }),
  createProject: (...args: unknown[]) => mockCreateVercelProject(...args),
  // ones consumed by sites.ts hard-delete path; unused here but need to
  // exist on the mock so dynamic imports from other paths don't NPE.
  findProjectByName: jest.fn(),
  deleteProject: jest.fn(),
}));

import {
  triggerDeploy,
  provisionClientRepoSecrets,
  CLIENT_REPO_SECRET_NAMES,
  type SiteBrief,
  type SiteProject,
} from "@/lib/sites";

const VALID_BRIEF: SiteBrief = {
  client: "acme",
  product: { name: "Acme Industries" },
  pages: [{ route: "/", sections: [] }],
};

const PROJECT: SiteProject = {
  id: "site_1",
  client_slug: "acme",
  display_name: "Acme Industries",
  brief: VALID_BRIEF,
  github_repo: "the-wolfpack-agency/wolfpack-acme",
  github_repo_url: "https://github.com/the-wolfpack-agency/wolfpack-acme",
  preview_url: null,
  status: "provisioning",
  last_deploy_id: null,
  last_canary_passed: null,
  agentic_findings: [],
  created_by: "u_1",
  created_at: "2026-04-17T00:00:00Z",
  updated_at: "2026-04-17T00:00:00Z",
};

const ORIGINAL_ENV = process.env;

function setEnv(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.VERCEL_TOKEN_WOLFPACK_AGENCY;
  delete process.env.VERCEL_ORG_ID;
  delete process.env.WOLFPACK_SITES_WEBHOOK_SECRET;
  delete process.env.INSTINCT_WEBHOOK_URL;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("provisionClientRepoSecrets (direct)", () => {
  const ghClient = { token: "ghp_test", fetch: jest.fn() };

  it("env_not_configured path: emits vercel_project_create_failed and returns without any API calls", async () => {
    setEnv({});
    await provisionClientRepoSecrets(
      ghClient,
      "the-wolfpack-agency/wolfpack-acme",
      PROJECT,
      "u_1",
      "sales",
    );
    expect(mockCreateVercelProject).not.toHaveBeenCalled();
    expect(mockSetRepoSecret).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.vercel_project_create_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "env_not_configured" }),
    );
  });

  it("happy path: creates Vercel project + sets all 5 secrets + emits per-secret success", async () => {
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt_abc",
      VERCEL_ORG_ID: "team_123",
      WOLFPACK_SITES_WEBHOOK_SECRET: "wh_shh",
    });
    mockCreateVercelProject.mockResolvedValueOnce({
      id: "prj_xyz",
      name: "wolfpack-acme",
    });
    mockSetRepoSecret.mockResolvedValue({ ok: true });

    await provisionClientRepoSecrets(
      ghClient,
      "the-wolfpack-agency/wolfpack-acme",
      PROJECT,
      "u_1",
      "sales",
    );

    // Vercel project created
    expect(mockCreateVercelProject).toHaveBeenCalledTimes(1);
    expect(mockCreateVercelProject).toHaveBeenCalledWith(
      expect.anything(),
      "wolfpack-acme",
      "nextjs",
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.vercel_project_created",
      "u_1",
      "sales",
      expect.objectContaining({ vercel_id: "prj_xyz" }),
    );

    // All 5 secrets PUT
    expect(mockSetRepoSecret).toHaveBeenCalledTimes(5);
    const secretCalls = mockSetRepoSecret.mock.calls.map(
      (c) => ({ name: c[2], value: c[3] }),
    );
    const byName = Object.fromEntries(secretCalls.map((c) => [c.name, c.value]));
    expect(byName).toEqual({
      VERCEL_TOKEN: "vt_abc",
      VERCEL_ORG_ID: "team_123",
      VERCEL_PROJECT_ID: "prj_xyz",
      INSTINCT_WEBHOOK_URL: "https://wolfpack-instinct.vercel.app/api/sites/webhook",
      WOLFPACK_SITES_WEBHOOK_SECRET: "wh_shh",
    });
    // 5 success events, one per secret
    const successEvents = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "site.repo_secret_set",
    );
    expect(successEvents).toHaveLength(5);
  });

  it("honors INSTINCT_WEBHOOK_URL override when set", async () => {
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt",
      VERCEL_ORG_ID: "team",
      WOLFPACK_SITES_WEBHOOK_SECRET: "shh",
      INSTINCT_WEBHOOK_URL: "https://staging.example.com/hooks/sites",
    });
    mockCreateVercelProject.mockResolvedValueOnce({ id: "prj_1", name: "wolfpack-acme" });
    mockSetRepoSecret.mockResolvedValue({ ok: true });
    await provisionClientRepoSecrets(ghClient, "o/r", PROJECT, "u", "r");
    const call = mockSetRepoSecret.mock.calls.find((c) => c[2] === "INSTINCT_WEBHOOK_URL");
    expect(call?.[3]).toBe("https://staging.example.com/hooks/sites");
  });

  it("per-secret hard failure (all retries exhausted) is non-fatal — remaining secrets still attempted", async () => {
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt",
      VERCEL_ORG_ID: "team",
      WOLFPACK_SITES_WEBHOOK_SECRET: "shh",
    });
    mockCreateVercelProject.mockResolvedValueOnce({ id: "prj_1", name: "wolfpack-acme" });
    // Fail the FIRST secret's first three attempts (retry exhausted) so
    // the remaining four are still attempted exactly once each.
    mockSetRepoSecret
      .mockRejectedValueOnce(new Error("github 403 forbidden"))
      .mockRejectedValueOnce(new Error("github 403 forbidden"))
      .mockRejectedValueOnce(new Error("github 403 forbidden"))
      .mockResolvedValue({ ok: true });

    await provisionClientRepoSecrets(ghClient, "o/r", PROJECT, "u", "r");

    // 3 retries for secret #1 + 4 successful ones = 7 total.
    expect(mockSetRepoSecret).toHaveBeenCalledTimes(CLIENT_REPO_SECRET_NAMES.length + 2);
    const failures = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "site.repo_secret_failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][3]).toMatchObject({
      secret_name: CLIENT_REPO_SECRET_NAMES[0],
      error: expect.stringContaining("403"),
    });
  });

  it("transient failure on one secret is recovered by retry (no tracked failure)", async () => {
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt",
      VERCEL_ORG_ID: "team",
      WOLFPACK_SITES_WEBHOOK_SECRET: "shh",
    });
    mockCreateVercelProject.mockResolvedValueOnce({ id: "prj_1", name: "wolfpack-acme" });
    // 2026-04-18 live repro: the very first secret (VERCEL_TOKEN) 422s
    // or 404s once because the template-forked repo is still replicating.
    // Second attempt succeeds. With retry in place, no failure should
    // surface for ops.
    mockSetRepoSecret
      .mockRejectedValueOnce(new Error("github 422 replication lag"))
      .mockResolvedValue({ ok: true });

    await provisionClientRepoSecrets(ghClient, "o/r", PROJECT, "u", "r");

    // 2 for secret #1 (fail + retry success) + 4 for rest = 6.
    expect(mockSetRepoSecret).toHaveBeenCalledTimes(CLIENT_REPO_SECRET_NAMES.length + 1);
    const failures = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "site.repo_secret_failed",
    );
    expect(failures).toHaveLength(0);
    const successes = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "site.repo_secret_set",
    );
    expect(successes).toHaveLength(CLIENT_REPO_SECRET_NAMES.length);
  });

  it("Vercel createProject failure: skips VERCEL_PROJECT_ID but still sets the other 4", async () => {
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt",
      VERCEL_ORG_ID: "team",
      WOLFPACK_SITES_WEBHOOK_SECRET: "shh",
    });
    mockCreateVercelProject.mockRejectedValueOnce(
      new Error("vercel 409: name already exists"),
    );
    mockSetRepoSecret.mockResolvedValue({ ok: true });

    await provisionClientRepoSecrets(ghClient, "o/r", PROJECT, "u", "r");

    // 4 setRepoSecret calls (VERCEL_PROJECT_ID skipped with dedicated event).
    expect(mockSetRepoSecret).toHaveBeenCalledTimes(4);
    const secretNames = mockSetRepoSecret.mock.calls.map((c) => c[2]);
    expect(secretNames).not.toContain("VERCEL_PROJECT_ID");

    // Vercel failure event + VERCEL_PROJECT_ID skip event
    const vercelFail = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "site.vercel_project_create_failed",
    );
    expect(vercelFail?.[3]).toMatchObject({ error: expect.stringContaining("409") });
    const projectIdSkip = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "site.repo_secret_failed" && (c[3] as { secret_name?: string }).secret_name === "VERCEL_PROJECT_ID",
    );
    expect(projectIdSkip?.[3]).toMatchObject({ error: "value_unavailable" });
  });
});

describe("triggerDeploy → provisionClientRepoSecrets wiring", () => {
  function mockProjectFetch(extra: Partial<Record<string, unknown>> = {}) {
    // getSiteProject reaps stuck deploys FIRST (an UPDATE on
    // apex_site_deploys) before the SELECT on apex_site_projects.
    // Queue a no-op UPDATE result so the SELECT still lands on the
    // project row.
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "site_1",
          client_slug: "acme",
          display_name: "Acme",
          brief: VALID_BRIEF,
          status: "draft",
          created_by: "u",
          created_at: "x",
          updated_at: "y",
          agentic_findings: [],
          github_repo: null,
          github_repo_url: null,
          ...extra,
        },
      ],
    });
  }

  it("preflight aborts the deploy (no repo creation, no secrets) when env_not_configured", async () => {
    // 2026-04-18 regression: when Instinct's own env lacks the Vercel /
    // webhook secrets, we used to dispatch the workflow anyway and let
    // it die silently at `vercel pull --token=`. That left the UI stuck
    // on "Deploying…" until the reaper fired. Now preflight aborts
    // early with an actionable error — asserted here.
    setEnv({});
    mockProjectFetch();
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // INSERT deploy
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE deploy fail
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project fail

    await expect(triggerDeploy("site_1", "u_1", "sales")).rejects.toThrow(
      /VERCEL_TOKEN_WOLFPACK_AGENCY/,
    );

    expect(mockCreateRepo).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
    expect(mockSetRepoSecret).not.toHaveBeenCalled();

    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("site.deploy_failed");
    const deployFailed = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "site.deploy_failed",
    );
    expect(deployFailed?.[3]).toMatchObject({ reason: "env_not_configured" });
  });

  it("happy path invokes setRepoSecret for every secret right after repo creation", async () => {
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt",
      VERCEL_ORG_ID: "team_1",
      WOLFPACK_SITES_WEBHOOK_SECRET: "shh",
    });
    mockProjectFetch();
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // INSERT deploy
    mockCreateRepo.mockResolvedValueOnce({
      full_name: "the-wolfpack-agency/wolfpack-acme",
      html_url: "https://github.com/the-wolfpack-agency/wolfpack-acme",
    });
    mockEnableActions.mockResolvedValueOnce(undefined);
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project repo
    mockCreateVercelProject.mockResolvedValueOnce({ id: "prj_ok", name: "wolfpack-acme" });
    mockSetRepoSecret.mockResolvedValue({ ok: true });
    mockPutFile.mockResolvedValueOnce(undefined);
    mockTriggerWorkflow.mockResolvedValueOnce({ run_id: "run_1" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE deploy
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project

    await triggerDeploy("site_1", "u_1", "sales");

    expect(mockCreateVercelProject).toHaveBeenCalledWith(
      expect.anything(),
      "wolfpack-acme",
      "nextjs",
    );
    expect(mockSetRepoSecret).toHaveBeenCalledTimes(5);
    const repoArg = mockSetRepoSecret.mock.calls[0][1];
    expect(repoArg).toBe("the-wolfpack-agency/wolfpack-acme");
    // Every secret name present
    const secretNames = mockSetRepoSecret.mock.calls.map((c) => c[2]).sort();
    expect(secretNames).toEqual([...CLIENT_REPO_SECRET_NAMES].sort());
  });

  it("re-runs provisioning as self-heal when github_repo is already set (existing client)", async () => {
    // Pre-existing repos (created before auto-provisioning shipped, or
    // from a session where Instinct env was empty) don't have the
    // Actions secrets set. Re-running provisionClientRepoSecrets on
    // every deploy is a cheap self-heal: PUT is idempotent, and it
    // closes the gap that caused the 2026-04-18 stuck-deploy on test4.
    setEnv({
      VERCEL_TOKEN_WOLFPACK_AGENCY: "vt",
      VERCEL_ORG_ID: "team_1",
      WOLFPACK_SITES_WEBHOOK_SECRET: "shh",
    });
    mockProjectFetch({
      github_repo: "the-wolfpack-agency/wolfpack-acme",
      github_repo_url: "https://github.com/the-wolfpack-agency/wolfpack-acme",
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // INSERT deploy
    mockCreateVercelProject.mockResolvedValueOnce({ id: "prj_ok", name: "wolfpack-acme" });
    mockSetRepoSecret.mockResolvedValue({ ok: true });
    mockPutFile.mockResolvedValueOnce(undefined);
    mockTriggerWorkflow.mockResolvedValueOnce({ run_id: "run_2" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE deploy
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project

    await triggerDeploy("site_1", "u_1", "sales");

    // Repo not re-created, but self-heal DID run for Vercel + 5 secrets
    expect(mockCreateRepo).not.toHaveBeenCalled();
    expect(mockCreateVercelProject).toHaveBeenCalled();
    expect(mockSetRepoSecret).toHaveBeenCalledTimes(5);
    expect(mockTrackEvent.mock.calls.map((c) => c[0])).toContain("site.deploy_triggered");
  });
});
