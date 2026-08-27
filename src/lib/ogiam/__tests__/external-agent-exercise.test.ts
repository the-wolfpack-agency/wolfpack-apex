/**
 * The harness that proves the bring-your-own-agent gate.
 *
 * These tests exist because a harness that cannot fail is worse than no
 * harness: it produces a green line that means nothing. So most of what is
 * asserted here is that each step goes RED when the gate does the wrong thing,
 * including when it does the right thing for the wrong reason.
 *
 * The gap being closed is real. On 2026-08-27 the external key table held zero
 * rows: the endpoint, key store, rate limiter and capability scoping were all
 * written, tested in isolation, and had never been exercised together.
 */
const mockCreate = jest.fn();
const mockRevoke = jest.fn();

jest.mock("@/lib/ogiam/api-keys", () => ({
  createApiKey: (...a: unknown[]) => mockCreate(...a),
  revokeApiKey: (...a: unknown[]) => mockRevoke(...a),
}));

import { runExternalAgentExercise } from "@/lib/ogiam/external-agent-exercise";

const KEY = "ogk_exercise_key";

/** A gate that behaves correctly on every step. */
function correctGate() {
  return jest.fn(async (apiKey: string, body: { capability: string }) => {
    if (apiKey !== KEY) return { status: 401, body: {} };
    if (mockRevoke.mock.calls.length > 0) return { status: 401, body: {} };
    if (body.capability === "settings.manage_team") {
      return { status: 200, body: { allowed: false, reason: "capability_out_of_scope" } };
    }
    return { status: 200, body: { allowed: true } };
  });
}

const deps = (callGate: ReturnType<typeof correctGate>) => ({
  workspaceId: "ws1",
  createdBy: "u1",
  callGate,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ id: "k1", plaintextKey: KEY, prefix: "ogk_ex", last4: "key" });
  mockRevoke.mockResolvedValue(true);
});

describe("against a gate that behaves", () => {
  it("passes every step", async () => {
    const report = await runExternalAgentExercise(deps(correctGate()));
    expect(report.passed).toBe(true);
    expect(report.steps).toHaveLength(4);
    expect(report.inconclusive).toBe(false);
  });

  it("mints a key scoped to one capability, not to everything", async () => {
    await runExternalAgentExercise(deps(correctGate()));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ["brain.read"], workspaceId: "ws1" }),
    );
  });

  /* A harness that leaves live credentials behind is a worse problem than the
     one it was checking for. */
  it("revokes every key it minted", async () => {
    const report = await runExternalAgentExercise(deps(correctGate()));
    expect(report.keysCleanedUp).toBe(1);
    expect(mockRevoke).toHaveBeenCalledWith("k1", "ws1");
  });

  it("reports what it observed, not just a verdict", async () => {
    const report = await runExternalAgentExercise(deps(correctGate()));
    for (const s of report.steps) {
      expect(s.expectation.length).toBeGreaterThan(20);
      expect(s.observed.length).toBeGreaterThan(0);
    }
  });
});

describe("it goes red when the gate is wrong", () => {
  it("fails when an unknown key is served a verdict instead of refused", async () => {
    const gate = jest.fn(async (apiKey: string) =>
      apiKey === KEY ? { status: 200, body: { allowed: true } } : { status: 200, body: { allowed: true } },
    );
    const report = await runExternalAgentExercise(deps(gate as never));
    expect(report.passed).toBe(false);
    expect(report.steps.find((s) => s.name.includes("unknown key"))?.passed).toBe(false);
  });

  it("fails when a revoked key still works", async () => {
    const gate = jest.fn(async (apiKey: string) =>
      apiKey === KEY ? { status: 200, body: { allowed: true } } : { status: 401, body: {} },
    );
    const report = await runExternalAgentExercise(deps(gate as never));
    expect(report.steps.find((s) => s.name.includes("revoked"))?.passed).toBe(false);
  });

  /* THE SUBTLE ONE. A deny that arrives for the wrong reason looks identical
     from the outside to a correct refusal, and would let a gate with broken
     scoping report as working. */
  it("fails when an out-of-scope call is denied for the wrong reason", async () => {
    const gate = jest.fn(async (apiKey: string, body: { capability: string }) => {
      if (apiKey !== KEY || mockRevoke.mock.calls.length > 0) return { status: 401, body: {} };
      if (body.capability === "settings.manage_team") {
        /* Denied, but by policy rather than by scope. The key's allowlist was
           never consulted. */
        return { status: 200, body: { allowed: false, reason: "policy_denied" } };
      }
      return { status: 200, body: { allowed: true } };
    });
    const report = await runExternalAgentExercise(deps(gate as never));
    expect(report.passed).toBe(false);
    const scope = report.steps.find((s) => s.name.includes("outside the key"));
    expect(scope?.passed).toBe(false);
    expect(scope?.observed).toContain("policy_denied");
  });

  it("fails when a policy deny arrives as a 403 instead of a served verdict", async () => {
    const gate = jest.fn(async (apiKey: string, body: { capability: string }) => {
      if (apiKey !== KEY || mockRevoke.mock.calls.length > 0) return { status: 401, body: {} };
      if (body.capability === "settings.manage_team") return { status: 403, body: {} };
      return { status: 200, body: { allowed: true } };
    });
    const report = await runExternalAgentExercise(deps(gate as never));
    expect(report.steps.find((s) => s.name.includes("outside the key"))?.passed).toBe(false);
  });

  /* Credentials must be cleaned up even when the run blows up partway. */
  it("still revokes the key when a call throws", async () => {
    const gate = jest.fn(async () => {
      throw new Error("gate unreachable");
    });
    await expect(runExternalAgentExercise(deps(gate as never))).rejects.toThrow("gate unreachable");
    expect(mockRevoke).toHaveBeenCalledWith("k1", "ws1");
  });
});
