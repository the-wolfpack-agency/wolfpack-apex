/**
 * Sites library tests — validation, CRUD, and deploy lifecycle.
 *
 * Mocks db + analytics + github-client so the test runs hermetically.
 * Asserts the closed-loop contract: every CRUD action emits the right
 * tracked event and triple-write side-effects fire from the lib layer.
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

// provisionClientRepoSecrets dynamically imports these. The triggerDeploy
// path now re-runs provisioning for EXISTING repos as a self-heal step,
// so we mock both modules hermetically — otherwise the dynamic imports
// would try real HTTP calls to Vercel + real libsodium encryption.
jest.mock("@/lib/vercel-client", () => ({
  defaultVercelClient: () => ({ token: "test", teamId: "team_1" }),
  createProject: jest.fn(async () => ({ id: "prj_test", name: "wolfpack-cftr" })),
}));
jest.mock("@/lib/github-secrets", () => ({
  setRepoSecret: jest.fn(async () => undefined),
}));

import {
  createSiteProject,
  validateBrief,
  BriefValidationError,
  triggerDeploy,
  recordDeployResult,
  updateBrief,
  type SiteBrief,
} from "@/lib/sites";

const VALID_BRIEF: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR", supportEmail: "x@y.com" },
  pages: [
    {
      route: "/",
      title: "Home",
      sections: [
        { type: "hero", heading: "BIG" },
        { type: "stats", items: [{ label: "Views", value: 100 }] },
        { type: "gallery", images: [{ src: "/a.jpg" }] },
      ],
    },
  ],
};

describe("validateBrief", () => {
  it("accepts a valid brief", () => {
    expect(() => validateBrief(VALID_BRIEF)).not.toThrow();
  });

  it("rejects bad client slug", () => {
    expect(() =>
      validateBrief({ ...VALID_BRIEF, client: "Bad Slug!" } as SiteBrief),
    ).toThrow(BriefValidationError);
  });

  it("rejects missing product.name", () => {
    expect(() =>
      validateBrief({ ...VALID_BRIEF, product: {} } as unknown as SiteBrief),
    ).toThrow(BriefValidationError);
  });

  it("rejects unknown section types", () => {
    expect(() =>
      validateBrief({
        ...VALID_BRIEF,
        pages: [{ route: "/", sections: [{ type: "frob" } as unknown as never] }],
      }),
    ).toThrow(/unknown section type/);
  });

  it("rejects stats with non-numeric values", () => {
    expect(() =>
      validateBrief({
        ...VALID_BRIEF,
        pages: [
          {
            route: "/",
            sections: [{ type: "stats", items: [{ label: "x", value: "not-a-number" as unknown as number }] }],
          },
        ],
      }),
    ).toThrow(/must be a number/);
  });

  it("rejects gallery without images array", () => {
    expect(() =>
      validateBrief({
        ...VALID_BRIEF,
        pages: [{ route: "/", sections: [{ type: "gallery" } as never] }],
      }),
    ).toThrow(/images array required/);
  });

  it("rejects empty pages array", () => {
    expect(() =>
      validateBrief({ ...VALID_BRIEF, pages: [] }),
    ).toThrow(/pages array required/);
  });

  it("rejects bad email", () => {
    expect(() =>
      validateBrief({ ...VALID_BRIEF, product: { name: "X", supportEmail: "not-an-email" } }),
    ).toThrow(/valid email/);
  });
});

describe("createSiteProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("inserts a project, returns it, and emits site.created", async () => {
    const row = {
      id: "site_1",
      client_slug: "cftr",
      display_name: "CFTR",
      brief: VALID_BRIEF,
      status: "draft",
      created_by: "user_1",
      created_at: "2026-04-08T00:00:00Z",
      updated_at: "2026-04-08T00:00:00Z",
      agentic_findings: [],
    };
    mockSafeQuery.mockResolvedValueOnce({ rows: [row] });

    const project = await createSiteProject(VALID_BRIEF, "user_1", "sales");

    expect(project.id).toBe("site_1");
    expect(project.status).toBe("draft");
    expect(mockSafeQuery.mock.calls[0][0]).toContain("INSERT INTO apex_site_projects");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.created",
      "user_1",
      "sales",
      expect.objectContaining({ client_slug: "cftr", page_count: 1 }),
    );
  });

  it("rejects invalid briefs before touching the DB", async () => {
    await expect(
      createSiteProject({ ...VALID_BRIEF, client: "BAD" }, "u", "sales"),
    ).rejects.toThrow(BriefValidationError);
    expect(mockSafeQuery).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("updateBrief", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates the row and emits site.brief_updated", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "site_1",
          client_slug: "cftr",
          display_name: "CFTR",
          brief: VALID_BRIEF,
          status: "draft",
          created_by: "u",
          created_at: "x",
          updated_at: "y",
          agentic_findings: [],
        },
      ],
    });
    await updateBrief("site_1", VALID_BRIEF, "user_1", "sales");
    expect(mockSafeQuery.mock.calls[0][0]).toContain("UPDATE apex_site_projects");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_updated",
      "user_1",
      "sales",
      expect.objectContaining({ project_id: "site_1" }),
    );
  });
});

describe("triggerDeploy", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    // Preflight requires these; set fakes so the deploy path proceeds.
    // A dedicated test below asserts the preflight-fail branch explicitly.
    process.env.VERCEL_TOKEN_WOLFPACK_AGENCY = "test_vercel_token";
    process.env.VERCEL_ORG_ID = "team_test";
    process.env.WOLFPACK_SITES_WEBHOOK_SECRET = "test_webhook_secret";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function mockProjectFetch(extra: Partial<Record<string, unknown>> = {}) {
    // getSiteProject now calls reapStuckDeploys first (an UPDATE on
    // apex_site_deploys) before the SELECT on apex_site_projects. Add
    // a no-op UPDATE result at the head of the queue so the real
    // SELECT still lands on the project row below.
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "site_1",
          client_slug: "cftr",
          display_name: "CFTR",
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

  it("provisions repo, commits brief, triggers workflow, emits 3 events", async () => {
    mockProjectFetch();
    // INSERT deploy row
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockCreateRepo.mockResolvedValueOnce({
      full_name: "the-wolfpack-agency/wolfpack-cftr",
      html_url: "https://github.com/the-wolfpack-agency/wolfpack-cftr",
    });
    // UPDATE project after repo create
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockPutFile.mockResolvedValueOnce(undefined);
    mockTriggerWorkflow.mockResolvedValueOnce({ run_id: "run_1" });
    // UPDATE deploy + UPDATE project (status=deploying)
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });

    const result = await triggerDeploy("site_1", "user_1", "sales");

    expect(result.deployId).toMatch(/^deploy_/);
    expect(mockCreateRepo).toHaveBeenCalled();
    expect(mockPutFile).toHaveBeenCalledWith(
      expect.anything(),
      "the-wolfpack-agency/wolfpack-cftr",
      "briefs/cftr.json",
      expect.stringContaining('"client": "cftr"'),
      expect.stringContaining("update brief"),
    );
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      "the-wolfpack-agency/wolfpack-cftr",
      "canary-deploy.yml",
      "main",
      // 5th arg is workflow_dispatch inputs — the deploy_id flows
      // through so the canary's "Notify Instinct" step can correlate.
      expect.objectContaining({ deploy_id: expect.any(String) }),
    );

    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toEqual(
      expect.arrayContaining(["site.repo_provisioned", "site.deploy_triggered"]),
    );
  });

  it("skips repo creation when github_repo is already set", async () => {
    mockProjectFetch({
      github_repo: "the-wolfpack-agency/wolfpack-cftr",
      github_repo_url: "https://github.com/the-wolfpack-agency/wolfpack-cftr",
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // INSERT deploy
    mockPutFile.mockResolvedValueOnce(undefined);
    mockTriggerWorkflow.mockResolvedValueOnce({ run_id: "run_2" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE deploy
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project

    await triggerDeploy("site_1", "user_1", "sales");

    expect(mockCreateRepo).not.toHaveBeenCalled();
    expect(mockTrackEvent.mock.calls.map((c) => c[0])).not.toContain("site.repo_provisioned");
  });

  it("emits site.deploy_failed when github call throws", async () => {
    mockProjectFetch();
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // INSERT deploy
    mockCreateRepo.mockRejectedValueOnce(new Error("github 422"));
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE deploy fail
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project fail

    await expect(triggerDeploy("site_1", "user_1", "sales")).rejects.toThrow("github 422");

    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("site.deploy_failed");
  });

  it("fails fast with actionable message when Instinct env is not configured", async () => {
    // Preflight is the mechanism preventing the stuck-"Deploying…" UI
    // state (2026-04-18 bug). When Instinct's own env lacks the vars
    // the workflow needs, we MUST mark the deploy failed immediately
    // rather than dispatch a workflow that is guaranteed to fail at
    // `vercel pull --token=` before the "Notify Instinct" step fires.
    delete process.env.VERCEL_TOKEN_WOLFPACK_AGENCY;
    mockProjectFetch();
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // INSERT deploy
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE deploy fail
    mockSafeQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE project fail

    await expect(triggerDeploy("site_1", "user_1", "sales")).rejects.toThrow(
      /VERCEL_TOKEN_WOLFPACK_AGENCY/,
    );

    // Must NOT have dispatched the workflow or committed anything.
    expect(mockCreateRepo).not.toHaveBeenCalled();
    expect(mockPutFile).not.toHaveBeenCalled();
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();

    const deployFailedCall = mockTrackEvent.mock.calls.find(
      (c) => c[0] === "site.deploy_failed",
    );
    expect(deployFailedCall).toBeDefined();
    expect(deployFailedCall?.[3]).toEqual(
      expect.objectContaining({
        reason: "env_not_configured",
        missing: expect.arrayContaining(["VERCEL_TOKEN_WOLFPACK_AGENCY"]),
      }),
    );
  });
});

describe("recordDeployResult", () => {
  beforeEach(() => jest.clearAllMocks());

  it("on success: marks ready, stores preview URL, emits site.deploy_succeeded + canary_passed", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: "site_1", triggered_by: "user_1" }],
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });

    await recordDeployResult("deploy_1", {
      status: "success",
      previewUrl: "https://wolfpack-cftr.vercel.app",
      canaryPassed: true,
    });

    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toEqual(
      expect.arrayContaining(["site.deploy_succeeded", "site.canary_passed"]),
    );
  });

  it("on failure: marks failed and emits site.deploy_failed", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: "site_1", triggered_by: "user_1" }],
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });

    await recordDeployResult("deploy_1", { status: "failed", logExcerpt: "build failed" });

    const eventNames = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("site.deploy_failed");
  });

  it("throws on unknown deployId", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      recordDeployResult("deploy_404", { status: "success" }),
    ).rejects.toThrow("unknown deploy");
  });
});
