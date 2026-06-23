/**
 * End-to-end through the REAL dispatcher + registry + gate + executor: an agent
 * assigned "Create a QR code titled AGENT1 that is linked to ogiam.com" must
 * route to the declarative op_create_qr_code tool (which exists with NO
 * per-function handler code, purely from the operation registry), and the
 * executor must invoke POST /api/qr ON THE OWNER'S BEHALF with the extracted
 * field values and a fresh on-behalf Bearer token.
 *
 * This proves the whole declarative chain: scan-able operation -> agent-only
 * tool -> dispatcher match -> on-behalf execution. The owner-role resolver, the
 * token mint, and the HTTP fetch are STUBBED (no db, no signing, no network);
 * the dispatcher, registry, OGIAM gate, operation tool factory, and executor are
 * REAL. Previously this instruction returned no_match because no QR tool existed.
 */

const mockRecordDecision = jest.fn((..._args: unknown[]) => Promise.resolve(null));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
  writeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
}));

import "@/lib/assistant/tools";
import { runAgentTask } from "@/lib/agents/tasks/executor";

test("agent QR instruction routes to op_create_qr_code and executes POST /api/qr on the owner's behalf", async () => {
  const mintToken = jest.fn().mockResolvedValue("onbehalf-token-qr");
  const getOwnerRole = jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" });
  const fetchImpl = jest.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: { slug: "x9" },
        shortUrl: "/q/x9",
        fullRedirectUrl: "https://wolfpack-instinct.vercel.app/q/x9",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );

  const out = await runAgentTask(
    {
      id: "task-qr",
      goal: "Create a QR code titled AGENT1 that is linked to ogiam.com",
      agentId: "agent-1",
      role: "dev",
      workspaceId: "ws-1",
      ownerUserId: "owner-9",
    },
    {
      lookupProcedure: (async () => null) as never,
      recordProcedure: (async () => null) as never,
      ground: (async () => ({ used: false, hits: 0, snippets: [] })) as never,
      getOwnerRole: getOwnerRole as never,
      mintToken: mintToken as never,
      origin: (() => "https://internal.example") as never,
      fetchImpl: fetchImpl as never,
    },
  );

  // It MATCHED the declarative operation tool (not no_match) and actually ran.
  expect(out.steps[0].tool).toBe("op_create_qr_code");
  expect(out.steps[0].outcome).toBe("ran");
  expect(out.status).toBe("succeeded");

  // A fresh on-behalf token was minted carrying the OWNER's role (never elevated).
  expect(getOwnerRole).toHaveBeenCalledWith("owner-9");
  expect(mintToken).toHaveBeenCalledWith(
    expect.objectContaining({ ownerUserId: "owner-9", ownerRole: "dev", workspaceId: "ws-1", agentId: "agent-1" }),
  );

  // The on-behalf fetch hit /api/qr with the extracted values + a Bearer token.
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe("https://internal.example/api/qr");
  expect(init.method).toBe("POST");
  expect(init.headers.Authorization).toBe("Bearer onbehalf-token-qr");
  expect(JSON.parse(init.body)).toEqual({
    targetUrl: "https://ogiam.com",
    label: "AGENT1",
  });
});
