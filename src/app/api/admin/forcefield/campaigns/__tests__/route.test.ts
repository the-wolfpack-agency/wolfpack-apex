/**
 * @jest-environment node
 *
 * Contract for /api/admin/forcefield/campaigns - the read-only "campaigns in the
 * wild" view. Auth (401/403); a valid caller gets 200 with the per-operator
 * campaigns for the requested site. The reader is mocked; no database.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockRead = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/forcefield-web/campaign-events", () => ({ readOperatorCampaigns: (...a: unknown[]) => mockRead(...a) }));

import { GET } from "../route";

const OK = { ok: true, user: { id: "op-1", role: "admin" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });
const get = (qs = "?site=ogiam.com") => new NextRequest(`http://x/api/admin/forcefield/campaigns${qs}`);

beforeEach(() => jest.clearAllMocks());

it("401 when denied, reader untouched", async () => {
  mockRequireCapability.mockResolvedValueOnce(deny(401));
  expect((await GET(get())).status).toBe(401);
  expect(mockRead).not.toHaveBeenCalled();
});

it("200 with the per-operator campaigns for the requested site", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockRead.mockResolvedValueOnce([{ fingerprint: "fpA", stepCount: 2, verdict: { campaign: true, signatures: [{ id: "kill_chain" }], severity: "high" } }]);
  const res = await GET(get("?site=ogiam.com"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, site: "ogiam.com", count: 1 });
  expect(body.campaigns[0].fingerprint).toBe("fpA");
  expect(mockRead).toHaveBeenCalledWith("ogiam.com", { windowMinutes: undefined });
});

it("defaults the site to ogiam.com when absent", async () => {
  mockRequireCapability.mockResolvedValueOnce(OK);
  mockRead.mockResolvedValueOnce([]);
  const res = await GET(get(""));
  expect((await res.json()).site).toBe("ogiam.com");
});
