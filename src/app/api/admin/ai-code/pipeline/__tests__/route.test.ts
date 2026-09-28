/**
 * @jest-environment node
 *
 * Contract for POST /api/admin/ai-code/pipeline. The chaining itself is proven
 * in src/lib/ai-code/__tests__/pipeline.test.ts against the real gate; this
 * asserts the ROUTE: auth, body validation, that an off-menu intake answer is a
 * 400 (not a 500), delegation, and that a run is audited + emitted. runPipeline
 * is mocked so the contract does not depend on a live model.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockRunPipeline = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();
const mockCreateApproval = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-code/pipeline", () => ({ runPipeline: (...a: unknown[]) => mockRunPipeline(...a) }));
jest.mock("@/lib/ai-code/repair", () => ({ liveRepairComplete: () => async () => "" }));
jest.mock("@/lib/ai-code/scan", () => ({ runCodeReview: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));
jest.mock("@/lib/agents/approvals/store", () => ({ createPendingApproval: (...a: unknown[]) => mockCreateApproval(...a) }));
const mockEnsureCodeGateAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({ ensureCodeGateAgent: (...a: unknown[]) => mockEnsureCodeGateAgent(...a) }));
const mockGate = jest.fn();
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }) }));
const mockWorkspaceClient = jest.fn();
const mockBuildContext = jest.fn();
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockWorkspaceClient(...a) }));
jest.mock("@/lib/ai-code/repo-context", () => ({
  buildRepoContext: (...a: unknown[]) => mockBuildContext(...a),
  withRepoContext: (prompt: string, block: string) => (block ? block + "\n" + prompt : prompt),
}));

import { POST } from "../route";

const AUTHORED_DIFF = "diff --git a/src/k.ts b/src/k.ts\n--- /dev/null\n+++ b/src/k.ts\n@@ -0,0 +1 @@\n+export const k = 1;";
// A new file truncated before its closing brace - the exact dogfooding failure.
const TRUNCATED_DIFF = "diff --git a/src/lib/slug.ts b/src/lib/slug.ts\n--- /dev/null\n+++ b/src/lib/slug.ts\n@@ -0,0 +1,2 @@\n+export function slugify(s: string): string {\n+  return s.toLowerCase();";
const authorResp = (content: string) => ({ content, model_used: "azure-gpt-4o", provider_used: "azure-openai", input_tokens: 1, output_tokens: 1, cost_usd: 0.0001, latency_ms: 100 });

const OK_USER = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (status: number) => ({ ok: false, response: new Response("{}", { status }) });

const RUN = {
  ref: "pr-1",
  spec: { prompt: "Add a value", answers: { tests: "all" }, createdAtIso: "2026-09-17T00:00:00.000Z", hash: "spec_abc123" },
  openQuestions: [],
  remediation: { status: "clean", diff: "d", attempts: [], review: {}, repairerLineage: null, reason: "ok" },
  review: { ref: "pr-1", author: "a", findings: [], verdict: { outcome: "allow", highestSeverity: "none", reason: "", ruleId: "C-CLEAN-ALLOW" }, bySeverity: {} },
  conformance: { specHash: "spec_abc123", conforms: true, findings: [] },
  status: "ready_for_pr",
  diff: "d",
  reason: "ok",
};

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/ai-code/pipeline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = { ref: "pr-1", prompt: "Add a value", author: "claude", authorModel: "claude-3-5-sonnet", diff: "diff --git a/x b/x\n@@ -1 +1 @@\n+const k = 1;", answers: { tests: "all" } };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK_USER);
  mockGate.mockResolvedValue(null); // secure_agent entitled by default
  mockRunPipeline.mockResolvedValue(RUN);
  mockRecordAudit.mockResolvedValue({ ok: true });
  mockCreateApproval.mockResolvedValue("appr-1");
  mockEnsureCodeGateAgent.mockResolvedValue("agent-uuid-1"); // factory principal is provisioned + active
  mockComplete.mockResolvedValue(authorResp("```diff\n" + AUTHORED_DIFF + "\n```"));
  mockWorkspaceClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockBuildContext.mockResolvedValue({ block: "", files: [] });
});

describe("POST /api/admin/ai-code/pipeline", () => {
  it("401 without a session", async () => {
    mockRequireCapability.mockResolvedValue(deny(401));
    expect((await POST(post(VALID))).status).toBe(401);
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValue(deny(403));
    expect((await POST(post(VALID))).status).toBe(403);
  });

  it("400 when ref or prompt is missing", async () => {
    expect((await POST(post({ ...VALID, ref: "" }))).status).toBe(400);
    expect((await POST(post({ ...VALID, prompt: "" }))).status).toBe(400);
  });

  it("400 on a malformed target repo (not owner/name)", async () => {
    expect((await POST(post({ ...VALID, repo: "not a repo" }))).status).toBe(400);
    expect((await POST(post({ ...VALID, repo: "../etc/passwd" }))).status).toBe(400);
  });

  it("passes a valid target repo through to the approval", async () => {
    const res = await POST(post({ ...VALID, repo: "acme/app" }));
    expect(res.status).toBe(200);
    expect(mockCreateApproval).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ repo: "acme/app" }),
    }));
  });

  it("authors the diff from the prompt when none is supplied (executor stage)", async () => {
    const res = await POST(post({ ref: "pr-2", prompt: "add k", answers: { tests: "all" }, executorProviderPin: "azure-openai" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executor.author).toBe("azure-gpt-4o");
    expect(body.executor.provider).toBe("azure-openai");
    // runPipeline governs the AUTHORED diff, attributed to the executor model so
    // the repairer is guaranteed a different lineage.
    const call = mockRunPipeline.mock.calls[0][0];
    expect(call.diff).toContain("export const k");
    expect(call.author).toBe("azure-gpt-4o");
  });

  it("returns a cost meter: this run's cost + a cross-model comparison", async () => {
    const res = await POST(post({ ref: "pr-cost", prompt: "add k", answers: { tests: "all" } }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.cost).toBeDefined();
    expect(body.cost.attempts).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.cost.comparison)).toBe(true);
    expect(body.cost.comparison.length).toBeGreaterThan(0);
  });

  it("with a target repo and no diff, fetches repo-aware context and returns the fetched files", async () => {
    mockBuildContext.mockResolvedValue({ block: "FILE: src/x.ts\n```\nexport const x = 1;\n```", files: ["src/x.ts"] });
    const res = await POST(post({ ref: "pr-ctx", prompt: "edit src/x.ts", answers: { tests: "all" }, repo: "acme/app" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockWorkspaceClient).toHaveBeenCalledWith("w1");
    expect(mockBuildContext).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/app", prompt: "edit src/x.ts" }));
    expect(body.repoContext.files).toEqual(["src/x.ts"]);
  });

  it("governed fallback: an empty first draft is retried at a higher tier and the run proceeds", async () => {
    // First author returns prose (no diff); the escalated retry returns a real diff.
    mockComplete
      .mockResolvedValueOnce(authorResp("I would add a function called k."))
      .mockResolvedValue(authorResp("```diff\n" + AUTHORED_DIFF + "\n```"));
    const res = await POST(post({ ref: "pr-fb", prompt: "add k", answers: { tests: "all" } }));
    expect(res.status).toBe(200); // did NOT dead-end on the first empty draft
    const body = await res.json();
    expect(body.executorAttempts).toBe(2); // the agent was tagged in a second time
    expect(mockRunPipeline).toHaveBeenCalled();
  });

  it("escalation retry carries the PARSE ERROR as feedback (not a blind re-run)", async () => {
    // The apex dogfooding case: the first author produces an unparseable file. The
    // premium retry must be TOLD what failed to parse, not just re-run the same
    // prompt at a higher tier - that is what turns a needs_human hold into a
    // converged draft.
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + TRUNCATED_DIFF + "\n```")) // does not parse
      .mockResolvedValue(authorResp("```diff\n" + AUTHORED_DIFF + "\n```"));      // premium retry: valid
    const res = await POST(post({ ref: "pr-fb3", prompt: "add slugify", answers: { tests: "all" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    // The SECOND author call's user message must include the deterministic parse error.
    const retryPrompt = mockComplete.mock.calls[1][0].messages[0].content as string;
    expect(retryPrompt).toMatch(/did NOT parse/i);
    expect(retryPrompt).toMatch(/src\/lib\/slug\.ts/); // the offending file is named
  });

  it("only a TRUE failure surfaces: both the draft and the escalated retry are empty -> 422", async () => {
    mockComplete.mockResolvedValue(authorResp("no code here, just prose"));
    const res = await POST(post({ ref: "pr-fb2", prompt: "add k", answers: { tests: "all" } }));
    expect(res.status).toBe(422);
    expect(mockComplete).toHaveBeenCalledTimes(2); // it retried before giving up
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it("422 (fail-closed) when the executor produces no diff - never a fabricated one", async () => {
    mockComplete.mockResolvedValue(authorResp("I would add a function called k."));
    const res = await POST(post({ ref: "pr-3", prompt: "add k", answers: { tests: "all" } }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/no change/);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it("400 (not 500) on an off-menu intake answer", async () => {
    mockRunPipeline.mockRejectedValue(new Error('unknown option "eventually" for question "tests"'));
    const res = await POST(post({ ...VALID, answers: { tests: "eventually" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown option/i);
  });

  it("200: delegates with the author MODEL and returns the run", async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toEqual(RUN);
    expect(body.approvalId).toBe("appr-1"); // clean diff (no added deps) -> handed off
    expect(body.executor).toBeNull();
    expect(body.invariants.wouldBlock).toBe(false);
    const args = mockRunPipeline.mock.calls[0][0];
    expect(args.author).toBe("claude-3-5-sonnet");
    expect(args.prompt).toBe("Add a value");
    expect(args.answers).toEqual({ tests: "all" });
  });

  it("withholds PR handoff when an invariant blocks, even if the security gate allowed", async () => {
    // Security gate allows (ready_for_pr), but the diff adds a runtime dependency,
    // which the OGIAM registry escalates -> no approval is captured.
    const DEP_DIFF = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,6 +5,7 @@",
      '   "dependencies": {',
      '+    "left-pad": "^1.3.0",',
      '     "react": "19.0.0"',
      "   },",
    ].join("\n");
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: DEP_DIFF });
    const res = await POST(post(VALID));
    const body = await res.json();
    expect(body.invariants.ruleId).toBe("R-DEPENDENCY-ADDED-ESCALATE");
    expect(body.invariants.wouldBlock).toBe(true);
    expect(body.approvalId).toBeNull(); // NOT handed off
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect(body.changeFacts.dependencyDelta).toBe(1);
  });

  it("withholds PR handoff when the deep static scan finds a critical (e.g. a hardcoded secret)", async () => {
    // Security gate allowed, but the authored NEW file carries a provider-signature
    // secret the full platform-scan engine flags critical -> no handoff.
    const SECRET_DIFF = [
      "diff --git a/src/config.ts b/src/config.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/config.ts",
      "@@ -0,0 +1,1 @@",
      '+export const KEY = "AKIA1234567890ABCDEF";',
    ].join("\n");
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: SECRET_DIFF });
    const res = await POST(post(VALID));
    const body = await res.json();
    expect(body.deepScan.blocking).toBe(true);
    expect(body.deepScan.critical).toBeGreaterThan(0);
    expect(body.approvalId).toBeNull(); // handoff withheld
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it("audits and emits the run for the learning loop", async () => {
    await POST(post(VALID));
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_code.pipeline_run" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ai_code.pipeline_run",
      "u1",
      "admin",
      expect.objectContaining({ ref: "pr-1", spec_hash: "spec_abc123", status: "ready_for_pr", conforms: true }),
    );
  });

  it("clamps maxAttempts to the ceiling", async () => {
    await POST(post({ ...VALID, maxAttempts: 99 }));
    expect(mockRunPipeline.mock.calls[0][0].maxAttempts).toBe(4);
  });

  it("drops answer keys outside the fixed question set (no remote property injection)", async () => {
    await POST(post({ ...VALID, answers: { tests: "all", __proto__: "x", constructor: "y", bogus: "z" } }));
    // Only the allowlisted question id survives; injected / unknown names are gone.
    expect(mockRunPipeline.mock.calls[0][0].answers).toEqual({ tests: "all" });
  });

  it("a ready-for-PR run CAPTURES a pending approval under the factory's REAL agent id - it does not open a PR", async () => {
    const res = await POST(post(VALID));
    // The approval carries the provisioned agent's real id (not a literal string),
    // so the approval route's kill-switch re-check finds an ACTIVE agent instead of
    // auto-rejecting. The factory principal is ensured for the caller's workspace.
    expect(mockEnsureCodeGateAgent).toHaveBeenCalledWith("w1", "u1", expect.any(Object));
    expect(mockCreateApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-uuid-1",
        ownerUserId: "u1",
        tool: "ai_code.open_pr",
        params: expect.objectContaining({ ref: "pr-1", spec_hash: "spec_abc123" }),
      }),
    );
    expect((await res.json()).approvalId).toBe("appr-1");
  });

  it("degrades to NO handoff (no approval) when the factory principal cannot be provisioned", async () => {
    mockEnsureCodeGateAgent.mockResolvedValue(null); // e.g. no database
    const res = await POST(post(VALID));
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect((await res.json()).approvalId).toBeNull();
  });

  it("a needs_human run hands off NOTHING (no approval captured, no PR)", async () => {
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "needs_human" });
    const res = await POST(post(VALID));
    expect(mockCreateApproval).not.toHaveBeenCalled();
    expect((await res.json()).approvalId).toBeNull();
  });

  it("SYNTAX GATE: a change that does not parse is needs_human with no approval, even if the gate allowed it", async () => {
    // The security gate said allow (ready_for_pr), but the file is truncated
    // before its closing brace - exactly the dogfooding failure. It must not hand off.
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: TRUNCATED_DIFF });
    const body = await (await POST(post(VALID))).json();
    expect(body.syntax.ok).toBe(false);
    expect(body.syntax.issues.length).toBeGreaterThan(0);
    expect(body.run.status).toBe("needs_human"); // overridden, never a misleading "ready"
    expect(body.approvalId).toBeNull();
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });
});

describe("entitlement gate", () => {
  it("403 when the secure_agent product is not entitled for the workspace", async () => {
    mockGate.mockResolvedValue(new Response(JSON.stringify({ entitled: false, feature: "secure_agent" }), { status: 403 }));
    expect((await POST(post(VALID))).status).toBe(403);
    expect(mockRunPipeline).not.toHaveBeenCalled(); // gated before the pipeline runs
  });
});

describe("files mode (edit-support)", () => {
  const FILES_REPLY = [
    "FILE: src/lib/k.ts",
    "```ts",
    "export const k = 1;",
    "```",
  ].join("\n");

  it("authors FULL FILE contents and captures them for the commit when the gate allows first-try", async () => {
    mockComplete.mockResolvedValue(authorResp(FILES_REPLY));
    mockRunPipeline.mockResolvedValue(RUN); // allow, attempts [] (first-pass)
    const res = await POST(post({ ref: "pr-files", prompt: "add k", answers: { tests: "all" }, mode: "files", executorProviderPin: "azure-openai" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("files");
    expect(body.executor.author).toBe("azure-gpt-4o");
    // the approval captured the full-file changes for the commit
    const captured = mockCreateApproval.mock.calls[0][0];
    expect(captured.params.changes).toEqual([{ path: "src/lib/k.ts", content: "export const k = 1;" }]);
    // runPipeline governed a synthesized diff of that file
    expect(mockRunPipeline.mock.calls[0][0].diff).toMatch(/\+\+\+ b\/src\/lib\/k\.ts/);
  });

  it("does NOT auto-hand-off when files-native repair cannot clear the gate (needs_human)", async () => {
    // Every authored + re-authored attempt carries a provider-signature secret the
    // deep scan flags critical, so the auto-fix exhausts -> needs_human, no handoff.
    const BAD_FILES = ["FILE: src/config.ts", "```ts", 'export const K = "AKIA1234567890ABCDEF";', "```"].join("\n");
    mockComplete.mockResolvedValue(authorResp(BAD_FILES));
    mockRunPipeline.mockResolvedValue(RUN);
    const res = await POST(post({ ref: "pr-files2", prompt: "add config", answers: { tests: "all" }, mode: "files" }));
    const body = await res.json();
    expect(body.approvalId).toBeNull();
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it("AUTO-REPAIRS: a first attempt that fails the gate, then a clean re-author, hands off", async () => {
    const BAD = ["FILE: src/config.ts", "```ts", 'export const K = "AKIA1234567890ABCDEF";', "```"].join("\n");
    const GOOD = ["FILE: src/config.ts", "```ts", "export const K = process.env.K;", "```"].join("\n");
    mockComplete.mockResolvedValueOnce(authorResp(BAD)).mockResolvedValue(authorResp(GOOD)); // initial bad, re-author clean
    mockRunPipeline.mockResolvedValue(RUN);
    const res = await POST(post({ ref: "pr-files3", prompt: "add config", answers: { tests: "all" }, mode: "files" }));
    const body = await res.json();
    expect(body.approvalId).toBe("appr-1"); // repaired, then handed off
    const captured = mockCreateApproval.mock.calls[0][0];
    expect(captured.params.changes[0].content).toContain("process.env.K"); // the REPAIRED files are committed
  });

  it("422 when the files executor produces no parseable files", async () => {
    mockComplete.mockResolvedValue(authorResp("I would add a k constant."));
    const res = await POST(post({ ref: "pr-files3", prompt: "add k", answers: { tests: "all" }, mode: "files" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/no change/);
  });
});

test("persists the diff + verdict reason on the pipeline_run event so history can show the code", async () => {
  await POST(post(VALID));
  const call = mockTrackEvent.mock.calls.find((c: unknown[]) => c[0] === "ai_code.pipeline_run");
  expect(call).toBeDefined();
  const meta = (call as unknown[])[3] as Record<string, unknown>;
  expect(meta.diff).toBe("d");             // the run's diff, persisted (capped)
  expect(meta.diff_truncated).toBe(false); // "d" is well under the cap
  expect(meta).toHaveProperty("verdict_reason");
});

