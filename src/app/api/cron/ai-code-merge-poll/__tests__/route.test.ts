/** @jest-environment node
 * Contract: unauthorized -> 401; cron-authorized with no opened PRs -> 200, 0 outcomes. */
export {};

const isAuthorizedBearer = jest.fn();
jest.mock("@/lib/auth/bearer-auth", () => ({ isAuthorizedBearer: (...a: any[]) => isAuthorizedBearer(...a) }));
const requireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: any[]) => requireCapability(...a) }));
const query = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: any[]) => query(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
const workspaceGithubClient = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: any[]) => workspaceGithubClient(...a),
  getPullRequest: jest.fn(),
}));

import { GET } from "../route";
const mkReq = (): any => ({ headers: new Headers() });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://x";
  process.env.CRON_SECRET = "s3cr3t";
  workspaceGithubClient.mockResolvedValue({ token: "t" });
  query.mockResolvedValue({ rows: [] });
});
afterEach(() => { delete process.env.CRON_SECRET; delete process.env.DATABASE_URL; });

it("401 when neither the cron bearer nor a capability authorizes", async () => {
  isAuthorizedBearer.mockReturnValue(false);
  requireCapability.mockResolvedValue({ ok: false, response: new Response("no", { status: 401 }) });
  const res = await GET(mkReq());
  expect(res.status).toBe(401);
});

it("200 with 0 outcomes when cron-authorized and no PRs are pending", async () => {
  isAuthorizedBearer.mockReturnValue(true);
  const res = await GET(mkReq());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.outcomes).toBe(0);
});
