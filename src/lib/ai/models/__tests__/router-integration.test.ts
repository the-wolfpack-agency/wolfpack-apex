/**
 * The router on a real caller's path, with nothing about it mocked.
 *
 * WHY THE UNIT TESTS ARE NOT ENOUGH
 *
 * router.test.ts covers the selection rules thoroughly — tiers, pin
 * precedence, fallbacks, determinism, tie-breaking. executor.test.ts covers
 * the executor thoroughly. But every executor test injects a MOCK selectModel,
 * so the two have never actually met. A change to the router's return shape,
 * its reason codes, or the analytics payload would satisfy both suites and
 * break the thing they exist to protect.
 *
 * This is the seam: run the real executor with the REAL router and the REAL
 * logging, and assert on what comes out. It is the same argument as everything
 * else here — "each half is tested" is a different claim from "the whole
 * works", and only the second one is what ships.
 *
 * Environment is set explicitly per test rather than inherited, because model
 * availability is read from env and a developer machine with an OPENAI_API_KEY
 * would otherwise take a different path from CI.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn().mockResolvedValue({ rows: [] }), query: jest.fn().mockResolvedValue({ rows: [] }) }));

import { trackEvent } from "@/lib/analytics";
import { runAgentTask } from "@/lib/agents/tasks/executor";
import { _setContainmentStateForTests, _setRunSpendForTests } from "@/lib/containment/state";
import { MODEL_REGISTRY } from "../registry";

const track = trackEvent as jest.Mock;

const AZURE_ENV = {
  AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
  AZURE_OPENAI_API_KEY: "k",
};

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  ...new Set(MODEL_REGISTRY.map((m) => m.deploymentEnvVar).filter((v): v is string => Boolean(v))),
];

beforeEach(() => {
  jest.clearAllMocks();
  // Say out loud that this suite is not exercising containment. With the db
  // mocked, every containment read is unreadable and the executor fail-closes,
  // which is CORRECT — it stopped the first version of the last test here. The
  // seam exists precisely so a test states that rather than a convenient
  // exception being added to production code.
  _setContainmentStateForTests({ agentsEnabled: true, readable: true });
  // Same for the spend ledger: an unreadable ledger pauses the run, which is
  // also correct and also not what this suite is about.
  _setRunSpendForTests({ tokens: 0, durationMs: 0, egressCalls: 0, spendCents: 0 });
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  _setContainmentStateForTests(null);
  _setRunSpendForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function task(over: Record<string, unknown> = {}) {
  return {
    id: "task-router-1",
    goal: "1. read the brief",
    agentId: "agent-1",
    role: "ops",
    workspaceId: "ws-1",
    ownerUserId: "owner-1",
    ...over,
  } as Parameters<typeof runAgentTask>[0];
}

const ranStep = () => ({
  tool: "knowledge",
  result: { ok: true as const, data: {}, answer: "done", sources: [] },
  durationMs: 1,
});

/** The metadata the executor sent with a given event. */
function metaFor(event: string): Record<string, unknown> | undefined {
  return track.mock.calls.find((c) => c[0] === event)?.[3] as Record<string, unknown> | undefined;
}

describe("the executor actually routes through the real router", () => {
  it("selects a real registered model and logs the decision", async () => {
    // Not a mock's return value: an id that exists in MODEL_REGISTRY.
    for (const [k, v] of Object.entries(AZURE_ENV)) process.env[k] = v;
    for (const spec of MODEL_REGISTRY) {
      if (spec.deploymentEnvVar) process.env[spec.deploymentEnvVar] = "deployment-name";
    }

    await runAgentTask(task(), {
      dispatch: jest.fn().mockResolvedValue(ranStep()) as never,
      notifyOwner: jest.fn() as never,
    });

    const meta = metaFor("ai.model_selected");
    expect(meta).toBeDefined();
    expect(MODEL_REGISTRY.map((m) => m.id)).toContain(meta?.model_id);
    expect(meta?.provider).toBe("azure");
  });

  it("carries the decision into the task-completion event, so cost joins to a task", async () => {
    // The two events are joined on task_id in the learning loop. If the model
    // id never reaches task_completed, "which model did this work" is
    // unanswerable however good the router is.
    for (const [k, v] of Object.entries(AZURE_ENV)) process.env[k] = v;
    for (const spec of MODEL_REGISTRY) {
      if (spec.deploymentEnvVar) process.env[spec.deploymentEnvVar] = "deployment-name";
    }

    await runAgentTask(task(), {
      dispatch: jest.fn().mockResolvedValue(ranStep()) as never,
      notifyOwner: jest.fn() as never,
    });

    const selected = metaFor("ai.model_selected");
    const completed = metaFor("agent.task_completed");
    expect(completed?.model_id).toBe(selected?.model_id);
  });

  it("honours an agent pin end to end, not just in the router's own unit test", async () => {
    for (const [k, v] of Object.entries(AZURE_ENV)) process.env[k] = v;
    for (const spec of MODEL_REGISTRY) {
      if (spec.deploymentEnvVar) process.env[spec.deploymentEnvVar] = "deployment-name";
    }
    const pinned = MODEL_REGISTRY.find((m) => m.provider === "azure" && m.capabilityTier !== "small");
    if (!pinned) return;

    await runAgentTask(task(), {
      dispatch: jest.fn().mockResolvedValue(ranStep()) as never,
      notifyOwner: jest.fn() as never,
      agentPin: pinned.id,
    });

    const meta = metaFor("ai.model_selected");
    expect(meta?.model_id).toBe(pinned.id);
    expect(meta?.reason).toBe("agent_pin");
  });

  it("records a fallback when the pinned model is not configured", async () => {
    // The honest path: the pin could not be honoured, and the report says which
    // one we degraded away from rather than silently using something else.
    for (const [k, v] of Object.entries(AZURE_ENV)) process.env[k] = v;
    for (const spec of MODEL_REGISTRY) {
      if (spec.deploymentEnvVar) process.env[spec.deploymentEnvVar] = "deployment-name";
    }

    await runAgentTask(task(), {
      dispatch: jest.fn().mockResolvedValue(ranStep()) as never,
      notifyOwner: jest.fn() as never,
      agentPin: "a-model-that-does-not-exist",
    });

    const meta = metaFor("ai.model_selected");
    expect(meta?.fallback_from).toBe("a-model-that-does-not-exist");
    expect(track.mock.calls.some((c) => c[0] === "ai.model_fallback")).toBe(true);
  });

  it("still completes the task when NO model is configured at all", async () => {
    // Nothing in the environment. The router never throws by contract, and the
    // executor guards it anyway — so a misconfigured deployment degrades the
    // routing, not the work.
    const out = await runAgentTask(task(), {
      dispatch: jest.fn().mockResolvedValue(ranStep()) as never,
      notifyOwner: jest.fn() as never,
    });

    expect(out.status).toBe("succeeded");
    const meta = metaFor("ai.model_selected");
    // A decision is still recorded, and it says why it had no real choice.
    expect(meta?.reason).toBe("no_model_available_using_default");
  });

  it("emits every field the router page reads, so the surface cannot silently lose a column", async () => {
    // insights.ts reads these exact keys out of metadata. A rename here shows
    // up as an empty column there, which looks like "no activity" rather than
    // like a bug.
    for (const [k, v] of Object.entries(AZURE_ENV)) process.env[k] = v;
    for (const spec of MODEL_REGISTRY) {
      if (spec.deploymentEnvVar) process.env[spec.deploymentEnvVar] = "deployment-name";
    }

    await runAgentTask(task(), {
      dispatch: jest.fn().mockResolvedValue(ranStep()) as never,
      notifyOwner: jest.fn() as never,
    });

    const meta = metaFor("ai.model_selected")!;
    for (const key of ["model_id", "provider", "tier", "reason"]) {
      expect({ key, present: key in meta }).toEqual({ key, present: true });
    }
  });
});
