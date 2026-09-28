/**
 * The deploy-health gate - the last-resort floor. Verifies the live URL serves,
 * auto-reverts a broken FACTORY branch, and NEVER force-pushes a production
 * branch (that escalates). Proves a bad self-deploy can't lock the tool out.
 */
const mockClient = jest.fn();
const mockReset = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockClient(...a),
  resetBranchTo: (...a: unknown[]) => mockReset(...a),
}));

import { checkDeployHealth, deployHealthGate } from "@/lib/gates/deploy-health-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const okBody = "x".repeat(500);
const resp = (status: number, body: string) => ({ status, text: async () => body } as unknown as Response);

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockReset.mockResolvedValue(undefined);
});

describe("checkDeployHealth", () => {
  it("healthy on 200 + rendered body", async () => {
    const h = await checkDeployHealth("https://x", (async () => resp(200, okBody)) as unknown as typeof fetch);
    expect(h.healthy).toBe(true);
  });
  it("unhealthy on non-200 (a 401 serves blank)", async () => {
    const h = await checkDeployHealth("https://x", (async () => resp(401, okBody)) as unknown as typeof fetch);
    expect(h.healthy).toBe(false);
    expect(h.status).toBe(401);
  });
  it("unhealthy on a blank body", async () => {
    const h = await checkDeployHealth("https://x", (async () => resp(200, "")) as unknown as typeof fetch);
    expect(h.healthy).toBe(false);
    expect(h.reason).toMatch(/blank/i);
  });
  it("unhealthy on an error marker", async () => {
    const h = await checkDeployHealth("https://x", (async () => resp(200, "<title>Error</title>" + okBody)) as unknown as typeof fetch);
    expect(h.healthy).toBe(false);
  });
  it("unhealthy (not thrown) when the URL is unreachable", async () => {
    const h = await checkDeployHealth("https://x", (async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch);
    expect(h.healthy).toBe(false);
    expect(h.reason).toMatch(/could not reach/i);
  });
});

describe("deploy-health gate", () => {
  const withHealth = (healthy: boolean) => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp(healthy ? 200 : 500, healthy ? okBody : ""));
  };
  afterEach(() => jest.restoreAllMocks());

  it("allow when the deploy is healthy", async () => {
    withHealth(true);
    const r = await runGate(deployHealthGate, { url: "https://live", branch: "factory/x", lastGoodSha: "abc123", repo: "o/r" }, ctx);
    expect(r.verdict).toBe("allow");
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("auto_fix: reverts a broken FACTORY branch to the last-good SHA", async () => {
    withHealth(false);
    const r = await runGate(deployHealthGate, { url: "https://live", branch: "factory/x-abc", lastGoodSha: "good9999", repo: "o/r" }, ctx);
    expect(r.verdict).toBe("auto_fix");
    expect(mockReset).toHaveBeenCalledWith(expect.anything(), "o/r", "factory/x-abc", "good9999");
    expect(r.output?.reverted).toEqual({ branch: "factory/x-abc", sha: "good9999" });
  });

  it("require_human: NEVER force-pushes a broken PRODUCTION branch", async () => {
    withHealth(false);
    const r = await runGate(deployHealthGate, { url: "https://live", branch: "main", lastGoodSha: "good9999", repo: "o/r" }, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.reason).toMatch(/protected\/production branch/i);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("require_human: broken with no last-good SHA to revert to", async () => {
    withHealth(false);
    const r = await runGate(deployHealthGate, { url: "https://live", branch: "factory/x", repo: "o/r" }, ctx);
    expect(r.verdict).toBe("require_human");
    expect(mockReset).not.toHaveBeenCalled();
  });
});
