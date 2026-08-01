/**
 * The deploy webhook, focused on the acceptance hand-off it now performs.
 *
 * The contract worth pinning is that queueing is best-effort in ONE direction
 * only: a queue failure must not fail the deploy report the GitHub workflow is
 * waiting on, and it must not be silent either, or "nobody checked" quietly
 * becomes indistinguishable from "checked and fine".
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/sites", () => ({
  recordDeployResult: jest.fn(async () => undefined),
  getDeployProjectId: jest.fn(async () => "proj-1"),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/log-sanitize", () => ({ sanitizeForLog: (s: string) => s }));
jest.mock("@/lib/site-acceptance/store", () => ({
  enqueueAcceptanceRun: jest.fn(async () => "run-1"),
  resolveAcceptanceWorkspace: jest.fn(async () => "ws-1"),
}));

import { POST } from "../route";
import { recordDeployResult, getDeployProjectId } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import { enqueueAcceptanceRun, resolveAcceptanceWorkspace } from "@/lib/site-acceptance/store";

const SECRET = "test-secret";
const req = (body: unknown, secret: string | null = SECRET) =>
  new NextRequest("http://localhost/api/sites/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-wolfpack-webhook-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WOLFPACK_SITES_WEBHOOK_SECRET = SECRET;
  (getDeployProjectId as jest.Mock).mockResolvedValue("proj-1");
  (enqueueAcceptanceRun as jest.Mock).mockResolvedValue("run-1");
  (resolveAcceptanceWorkspace as jest.Mock).mockResolvedValue("ws-1");
});

it("403s without the shared secret, before any work happens", async () => {
  const res = await POST(req({ deployId: "d1", status: "success" }, "wrong"));
  expect(res.status).toBe(403);
  expect(recordDeployResult).not.toHaveBeenCalled();
  expect(enqueueAcceptanceRun).not.toHaveBeenCalled();
});

it("400s on a body that names no deploy or no status", async () => {
  expect((await POST(req({ status: "success" }))).status).toBe(400);
  expect((await POST(req({ deployId: "d1" }))).status).toBe(400);
});

it("queues an acceptance run when a deploy succeeds", async () => {
  const res = await POST(req({ deployId: "d1", status: "success", previewUrl: "https://build.test" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, acceptanceQueued: true });
  expect(enqueueAcceptanceRun).toHaveBeenCalledWith("ws-1", "proj-1", "d1", "https://build.test");
  expect(trackEvent).toHaveBeenCalledWith("site.acceptance_queued", "system", "system", expect.objectContaining({ project_id: "proj-1" }));
});

it("queues even when the deploy reported no preview URL, so the gap is recorded rather than skipped", async () => {
  await POST(req({ deployId: "d1", status: "success" }));
  // A run with no URL becomes a degraded verdict at drain time. Not queueing it
  // would leave a successful deploy with no acceptance record at all.
  expect(enqueueAcceptanceRun).toHaveBeenCalledWith("ws-1", "proj-1", "d1", null);
});

it("does not queue for a failed deploy, because there is nothing to check", async () => {
  const res = await POST(req({ deployId: "d1", status: "failed", logExcerpt: "build error" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ acceptanceQueued: false });
  expect(enqueueAcceptanceRun).not.toHaveBeenCalled();
});

it("still reports the deploy when queueing fails, and says the check was not queued", async () => {
  (enqueueAcceptanceRun as jest.Mock).mockRejectedValue(new Error("db down"));
  jest.spyOn(console, "error").mockImplementation(() => {});
  const res = await POST(req({ deployId: "d1", status: "success", previewUrl: "https://build.test" }));
  expect(res.status).toBe(200);
  // The deploy result is the caller's answer and is already recorded; the flag
  // is how the failure to queue stays visible instead of being assumed away.
  expect(await res.json()).toMatchObject({ ok: true, acceptanceQueued: false });
  expect(recordDeployResult).toHaveBeenCalled();
});

it("reports acceptanceQueued false for a deploy id it cannot resolve to a project", async () => {
  (getDeployProjectId as jest.Mock).mockResolvedValue(null);
  const res = await POST(req({ deployId: "unknown", status: "success" }));
  expect(await res.json()).toMatchObject({ acceptanceQueued: false });
  expect(enqueueAcceptanceRun).not.toHaveBeenCalled();
});
