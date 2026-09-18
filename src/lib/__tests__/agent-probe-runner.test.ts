/**
 * Live probe runner: target allowlist (SSRF), router adapter, and an end-to-end
 * run that produces a classified report + operator dossier. Injected client +
 * fetch, no network, no keys.
 */
import {
  isAllowedTarget, routerCompleteFn, runProbeAgainstTarget, ProbeTargetNotAllowedError,
} from "@/lib/agent-probe-runner";
import type { AIClient } from "@/lib/ai/types";

// The runner only reads res.content; a minimal mock cast to the client type.
const asClient = (complete: unknown) => ({ complete } as unknown as Pick<AIClient, "complete">);

describe("isAllowedTarget (SSRF allowlist)", () => {
  it("allows the default target, blocks others and internal hosts", () => {
    expect(isAllowedTarget("https://ogiam.com", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(isAllowedTarget("https://evil.com", {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isAllowedTarget("http://169.254.169.254", {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isAllowedTarget("not a url", {} as NodeJS.ProcessEnv)).toBe(false);
  });
  it("honors an env override", () => {
    const env = { OGIAM_PROBE_TARGETS: "https://a.test, https://b.test" } as unknown as NodeJS.ProcessEnv;
    expect(isAllowedTarget("https://a.test", env)).toBe(true);
    expect(isAllowedTarget("https://ogiam.com", env)).toBe(false); // override replaces default
  });
});

describe("routerCompleteFn", () => {
  it("adapts the router's complete() to a text CompleteFn", async () => {
    const complete = jest.fn().mockResolvedValue({ content: "/pricing" });
    const fn = routerCompleteFn(asClient(complete), "cheap", "ws1");
    expect(await fn("prompt")).toBe("/pricing");
    const req = complete.mock.calls[0][0];
    expect(req.model_tier).toBe("cheap");
    expect(req.messages[0].content).toBe("prompt");
    expect(req.metadata.feature).toBe("agent_probe");
  });
});

describe("runProbeAgainstTarget", () => {
  it("refuses a target not on the allowlist before any call", async () => {
    await expect(
      runProbeAgainstTarget({
        client: asClient(jest.fn()), tier: "cheap", agentLabel: "x", goal: "g",
        targetBase: "https://evil.com", fetchImpl: jest.fn(), runId: "r", at: "2026-09-18T10:00:00Z",
      }),
    ).rejects.toBeInstanceOf(ProbeTargetNotAllowedError);
  });

  it("runs a model against the target and returns a classified report + dossier", async () => {
    const script = ["/", "/admin", "/.env", "STOP"];
    let i = 0;
    const complete = jest.fn(async () => ({ content: script[Math.min(i++, script.length - 1)] }));
    const result = await runProbeAgainstTarget({
      client: asClient(complete), tier: "standard", agentLabel: "standard model", goal: "find the admin panel",
      targetBase: "https://ogiam.com", fetchImpl: async () => ({ status: 200, body: "" }),
      runId: "run-1", at: "2026-09-18T10:00:00Z", maxSteps: 6,
    });
    expect(result.report.journey.behaviorClass).toBe("vuln_scanner");
    expect(result.report.scaffolding.pathDiscovery).toBe("path-guessing");
    expect(result.targetHost).toBe("ogiam.com");
    // The dossier fuses it into an operator-keyed evidence bundle.
    expect(result.dossier.threatLevel).toBe("hostile");
    expect(result.dossier.confidence).toBe("proven");
    expect(result.dossier.disclaimer).toMatch(/does not establish a real-world identity/i);
  });
});
