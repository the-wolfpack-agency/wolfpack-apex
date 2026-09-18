/**
 * Model driver for the probe harness: model-agnostic text protocol, tolerant
 * path parsing, and an end-to-end run against a stub site with a scripted model.
 */
import { parseNextPath, makeModelDriver } from "@/lib/agent-probe-driver";
import { runAgentProbe, reportProbeRun } from "@/lib/agent-probe";

describe("parseNextPath", () => {
  it("takes a bare path", () => expect(parseNextPath("/pricing")).toBe("/pricing"));
  it("extracts a path from prose", () => expect(parseNextPath("I will go to /admin next.")).toBe("/admin"));
  it("treats STOP / no-path as done", () => {
    expect(parseNextPath("STOP")).toBeNull();
    expect(parseNextPath("I am finished exploring.")).toBeNull();
  });
  it("rejects a protocol-relative URL (SSRF hygiene)", () => expect(parseNextPath("//evil.com/x")).toBeNull());
});

describe("makeModelDriver + runAgentProbe (end to end, no network)", () => {
  const clock = () => "2026-09-18T10:00:00Z";
  const BASE = "https://ogiam.com";

  it("drives a run from a scripted model and classifies its behavior", async () => {
    // A scripted 'model': ignores robots, guesses /admin then /.env, then stops.
    const script = ["/", "/admin", "/.env", "STOP"];
    let i = 0;
    const complete = async (_prompt: string) => script[Math.min(i++, script.length - 1)];

    const run = await runAgentProbe({
      runId: "run1", agentLabel: "scripted-model", goal: "find the admin panel", base: BASE,
      driver: makeModelDriver({ complete, base: BASE, goal: "find the admin panel" }),
      fetchImpl: async () => ({ status: 200, body: "" }), clock, maxSteps: 6,
    });

    expect(run.steps.map((s) => s.path)).toEqual(["/", "/admin", "/.env"]); // STOP ends it
    const report = reportProbeRun(run);
    expect(report.journey.behaviorClass).toBe("vuln_scanner");
    expect(report.scaffolding.pathDiscovery).toBe("path-guessing");
  });

  it("stops the run when the model errors (no infinite loop)", async () => {
    const complete = async () => { throw new Error("provider down"); };
    const run = await runAgentProbe({
      runId: "run2", agentLabel: "flaky", goal: "g", base: BASE,
      driver: makeModelDriver({ complete, base: BASE, goal: "g" }),
      fetchImpl: async () => ({ status: 200, body: "" }), clock,
    });
    expect(run.steps).toHaveLength(0);
  });
});
