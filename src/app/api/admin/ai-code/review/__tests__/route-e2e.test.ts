/**
 * TRUE end-to-end test of the code gate through the real HTTP route.
 *
 * route.test.ts mocks runCodeReview, so it would stay green even if the real
 * detectors returned nothing and the gate stopped blocking bad code. That is the
 * exact failure mode to guard against: a gate that silently no-ops looks healthy.
 * This test mocks ONLY auth + the audit/analytics side-effects and runs the REAL
 * detect -> gate -> verdict chain, asserting a bad diff actually BLOCKS and a
 * clean diff actually ALLOWS - including the logged-credential rule.
 */
export {};

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: jest.fn().mockResolvedValue({ ok: true }) }));
// @/lib/ai-code/{scan,store,detect} are intentionally NOT mocked: the real gate runs.

import { NextRequest } from "next/server";
import { POST } from "../route";

const unified = (line: string) =>
  `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,0 +1,1 @@\n+${line}`;

function post(diff: string): NextRequest {
  return new NextRequest("https://x.test/api/admin/ai-code/review", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ ref: "PR-e2e", author: "cursor", diff }),
  });
}

async function outcome(line: string): Promise<string> {
  const res = await POST(post(unified(line)));
  expect(res.status).toBe(200);
  return (await res.json()).result.verdict.outcome as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({
    ok: true,
    user: { id: "u-1", role: "cto", workspaceId: "w-1" },
    capabilities: new Set(),
  });
});

test("BLOCKS a hardcoded secret through the real gate", async () => {
  expect(await outcome('const key = "sk-ant-abcdefghijklmnopqrstuvwx0123";')).toBe("block");
});

test("BLOCKS a logged password reset link end to end (the motivating incident)", async () => {
  expect(await outcome("console.log(`reset link: ${resetUrl}`);")).toBe("block");
});

test("ESCALATES a high-severity risk (eval) to human review", async () => {
  expect(await outcome("eval(userInput);")).toBe("escalate");
});

test("ALLOWS a clean diff", async () => {
  expect(await outcome("export const sum = (a, b) => a + b;")).toBe("allow");
});
