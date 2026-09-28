/**
 * The safe-review gate maps the deterministic assessment to a gate verdict and
 * always produces a client-facing transparency record - with no model invoked.
 */
const mockAssess = jest.fn();
jest.mock("@/lib/ai-code/assess", () => ({ assessChange: (...a: unknown[]) => mockAssess(...a) }));

import { safeReviewGate } from "@/lib/gates/safe-review-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const clean = { securityOutcome: "allow", invariantRuleId: "", invariantBlocked: false, deepScanCritical: 0, deepScanBlocking: false, handoffAllowed: true, blockedBy: null };

beforeEach(() => jest.clearAllMocks());

it("allow: clean change clears every layer and carries the diff forward", async () => {
  mockAssess.mockResolvedValue(clean);
  const r = await runGate(safeReviewGate, { diff: "diff --git a/x b/x\n+ok" }, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.output?.diff).toContain("diff --git");
  expect(r.transparency.modelInvoked).toBeNull();          // pure deterministic gate
  expect(r.transparency.checksRun).toContain("security-scan");
  expect(r.transparency.frameworksApplied).toEqual(["SOC2"]);
});

it("deny: a security block is a hard stop, nothing carried forward", async () => {
  mockAssess.mockResolvedValue({ ...clean, securityOutcome: "block", handoffAllowed: false, blockedBy: "security" });
  const r = await runGate(safeReviewGate, { diff: "x" }, ctx);
  expect(r.verdict).toBe("deny");
  expect(r.output).toBeUndefined();
  expect(r.findings.some((f) => f.id === "security")).toBe(true);
  expect(r.reason).toMatch(/security/i);
});

it("deny: a blocking deep-scan critical is a hard stop", async () => {
  mockAssess.mockResolvedValue({ ...clean, deepScanCritical: 2, deepScanBlocking: true, handoffAllowed: false, blockedBy: "deep-scan" });
  const r = await runGate(safeReviewGate, { diff: "x" }, ctx);
  expect(r.verdict).toBe("deny");
});

it("require_human: an engineering-invariant block asks a person to look (not a hard deny)", async () => {
  mockAssess.mockResolvedValue({ ...clean, invariantBlocked: true, invariantRuleId: "INV-1", handoffAllowed: false, blockedBy: "invariant" });
  const r = await runGate(safeReviewGate, { diff: "x" }, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.reason).toMatch(/INV-1/);
});

describe("test-fixture allowlist (secret-in-fixture downgrades deny -> require_human)", () => {
  const SECRET_LINE = 'const key = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";';
  const diffIn = (file: string) => `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${SECRET_LINE}\n`;

  it("a secret only in a __tests__ file -> require_human (confirm test data), not deny", async () => {
    mockAssess.mockResolvedValue({ ...clean, securityOutcome: "block", handoffAllowed: false, blockedBy: "security" });
    const r = await runGate(safeReviewGate, { diff: diffIn("src/lib/__tests__/x.test.ts") }, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.reason).toMatch(/test-fixture file/i);
  });

  it("a secret in a PRODUCTION source file stays a hard deny", async () => {
    mockAssess.mockResolvedValue({ ...clean, securityOutcome: "block", handoffAllowed: false, blockedBy: "security" });
    const r = await runGate(safeReviewGate, { diff: diffIn("src/lib/client.ts") }, ctx);
    expect(r.verdict).toBe("deny");
  });

  it("a secret in scripts/ stays a hard deny (scripts are NOT allowlisted)", async () => {
    mockAssess.mockResolvedValue({ ...clean, securityOutcome: "block", handoffAllowed: false, blockedBy: "security" });
    const r = await runGate(safeReviewGate, { diff: diffIn("scripts/tool.mjs") }, ctx);
    expect(r.verdict).toBe("deny");
  });
});
