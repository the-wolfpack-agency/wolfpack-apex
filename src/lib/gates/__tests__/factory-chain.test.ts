/**
 * The capstone: preview-verify + prod-promote gates and the canonical factory
 * chain. Proves a passing change flows all the way to the ONE human touchpoint
 * (prod-promote) with no other human step, and that a broken preview stops
 * earlier - never auto-promoted.
 */
const mockAssess = jest.fn();
jest.mock("@/lib/ai-code/assess", () => ({ assessChange: (...a: unknown[]) => mockAssess(...a) }));

import { previewVerifyGate } from "@/lib/gates/preview-verify-gate";
import { prodPromoteGate } from "@/lib/gates/prod-promote-gate";
import { buildFactoryChain } from "@/lib/gates/factory-chain";
import { runChain } from "@/lib/gates/chain";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const okBody = "x".repeat(500);
const resp = (status: number, body: string) => ({ status, text: async () => body } as unknown as Response);

beforeEach(() => {
  jest.clearAllMocks();
  mockAssess.mockResolvedValue({ securityOutcome: "allow", invariantBlocked: false, deepScanCritical: 0, deepScanBlocking: false, handoffAllowed: true, blockedBy: null });
});
afterEach(() => jest.restoreAllMocks());

describe("preview-verify gate", () => {
  it("allow when the preview serves (200 + rendered)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp(200, okBody));
    const r = await runGate(previewVerifyGate, { url: "https://preview" }, ctx);
    expect(r.verdict).toBe("allow");
    expect(r.output?.previewUrl).toBe("https://preview");
    expect(r.transparency.modelInvoked).toBeNull();
  });
  it("require_human (never auto-promote) when the preview is broken", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp(500, ""));
    const r = await runGate(previewVerifyGate, { url: "https://preview" }, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.reason).toMatch(/not serving/i);
  });
  it("require_human when a required content marker is missing (full treatment)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp(200, okBody)); // no marker in body
    const r = await runGate(previewVerifyGate, { url: "https://preview", requiredMarkers: ["Dashboard"] }, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.reason).toMatch(/missing expected content/i);
  });
});

describe("prod-promote gate", () => {
  it("always stops for a human, carrying the preview evidence", async () => {
    const r = await runGate(prodPromoteGate, { previewUrl: "https://preview", evidence: "all green" }, ctx);
    expect(r.verdict).toBe("require_human");
    expect(r.output?.awaitingHumanFor).toBe("production-promotion");
    expect(r.reason).toMatch(/one decision a human owns/i);
  });
});

describe("the canonical factory chain", () => {
  it("a clean change + healthy preview flows to the ONE human step (prod-promote)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp(200, okBody));
    const chain = buildFactoryChain({ diff: "diff --git a/x b/x\n+ok", previewUrl: "https://preview" });
    const r = await runChain(chain, ctx);
    expect(r.status).toBe("awaiting_human");
    expect(r.atGate).toBe("prod-promote");
    expect(r.ranSteps.map((s) => s.gate)).toEqual(["safe-review", "preview-verify", "prod-promote"]);
  });

  it("a change the review DENIES stops immediately - never reaches preview or prod", async () => {
    mockAssess.mockResolvedValue({ securityOutcome: "block", invariantBlocked: false, deepScanCritical: 0, deepScanBlocking: false, handoffAllowed: false, blockedBy: "security" });
    const chain = buildFactoryChain({ diff: "diff --git a/x b/x\n+secret", previewUrl: "https://preview" });
    const r = await runChain(chain, ctx);
    expect(r.status).toBe("denied");
    expect(r.atGate).toBe("safe-review");
    expect(r.ranSteps).toHaveLength(1); // preview + prod never ran
  });

  it("a broken preview stops at preview-verify - production is never reached", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp(500, ""));
    const chain = buildFactoryChain({ diff: "diff --git a/x b/x\n+ok", previewUrl: "https://preview" });
    const r = await runChain(chain, ctx);
    expect(r.status).toBe("awaiting_human");
    expect(r.atGate).toBe("preview-verify");
  });
});
