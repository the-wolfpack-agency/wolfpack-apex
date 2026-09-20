/** @jest-environment node */
/**
 * Ingest verifies a presented delegation at the boundary, fail-closed, and
 * stores only the VERDICT - never the raw credential. Uses the REAL verifier
 * (only the issuer lookup is stubbed) so the crypto path is genuinely exercised.
 */
import { NextRequest } from "next/server";
import { delegationSignature } from "@/lib/ogiam/delegate";

const recordSiteEvent = jest.fn();
const getDelegationIssuer = jest.fn();
const consumeDelegationJti = jest.fn();
jest.mock("@/lib/site-analytics", () => ({
  recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a),
  isSiteEventType: (t: unknown) => t === "site.agent_welcomed",
}));
jest.mock("@/lib/forcefield/principal", () => ({
  ...jest.requireActual("@/lib/forcefield/principal"),
  getDelegationIssuer: (...a: unknown[]) => getDelegationIssuer(...a),
  consumeDelegationJti: (...a: unknown[]) => consumeDelegationJti(...a),
}));

import { POST, _resetIngestRateLimit } from "@/app/api/site-analytics/ingest/route";

const SECRET = "issuer-secret-key-abcdef";
let jtiSeq = 0;
function mint(body: Record<string, unknown>, secret = SECRET): string {
  jtiSeq += 1;
  const withJti = { jti: `jti-${jtiSeq}`, ...body };
  const json = JSON.stringify(withJti);
  const ts = Math.floor(Date.now() / 1000);
  return `${Buffer.from(json, "utf8").toString("base64url")}.${ts}.${delegationSignature(secret, json, ts)}`;
}
const req = (body: unknown) =>
  new NextRequest("http://localhost/api/site-analytics/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": "test-token" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "test-token";
  recordSiteEvent.mockReset();
  getDelegationIssuer.mockReset();
  getDelegationIssuer.mockResolvedValue({ issuer: "acme-fleet", algorithm: "hs256", secret: SECRET, allowedScopes: [] });
  consumeDelegationJti.mockReset();
  consumeDelegationJti.mockResolvedValue(true); // fresh by default
  _resetIngestRateLimit();
});

it("stores a VERIFIED verdict for a valid delegation and never the raw credential", async () => {
  const delegation = mint({ principal: "person:42", issuer: "acme-fleet", scopes: ["/catalog"] });
  const res = await POST(req({ type: "site.agent_welcomed", path: "/catalog", delegation }));
  expect(res.status).toBe(200);
  const props = recordSiteEvent.mock.calls[0][0].props;
  expect(props.principal_status).toBe("verified");
  expect(props.principal).toBe("person:42");
  expect(props.principal_issuer).toBe("acme-fleet");
  expect(props.delegation).toBeUndefined(); // raw credential never persisted
});

it("stores CLAIMED (never verified) for a forged signature", async () => {
  const delegation = mint({ principal: "p", issuer: "acme-fleet", scopes: ["/"] }, "wrong-secret-key-xxxx");
  await POST(req({ type: "site.agent_welcomed", path: "/", delegation }));
  expect(recordSiteEvent.mock.calls[0][0].props.principal_status).toBe("claimed");
});

it("stores CLAIMED for an unregistered issuer", async () => {
  getDelegationIssuer.mockResolvedValue(null);
  const delegation = mint({ principal: "p", issuer: "stranger", scopes: ["/"] });
  await POST(req({ type: "site.agent_welcomed", path: "/", delegation }));
  expect(recordSiteEvent.mock.calls[0][0].props.principal_status).toBe("claimed");
});

it("rejects a bad ingest token (401) and never records", async () => {
  const bad = new NextRequest("http://localhost/api/site-analytics/ingest", {
    method: "POST", headers: { "content-type": "application/json", "x-ingest-token": "nope" },
    body: JSON.stringify({ type: "site.agent_welcomed" }),
  });
  expect((await POST(bad)).status).toBe(401);
  expect(recordSiteEvent).not.toHaveBeenCalled();
});

it("records normally with no principal fields when no delegation is presented", async () => {
  await POST(req({ type: "site.agent_welcomed", path: "/about" }));
  const props = recordSiteEvent.mock.calls[0][0].props;
  expect(props.principal_status).toBeUndefined();
});

it("stores CLAIMED for a replayed credential (same jti presented twice)", async () => {
  consumeDelegationJti.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const delegation = mint({ principal: "person:42", issuer: "acme-fleet", scopes: ["/catalog"] });
  await POST(req({ type: "site.agent_welcomed", path: "/catalog", delegation }));
  await POST(req({ type: "site.agent_welcomed", path: "/catalog", delegation }));
  expect(recordSiteEvent.mock.calls[0][0].props.principal_status).toBe("verified");
  expect(recordSiteEvent.mock.calls[1][0].props.principal_status).toBe("claimed");
});
