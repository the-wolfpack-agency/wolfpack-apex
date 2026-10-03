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
const mockTrackEventAwait = jest.fn(async (..._a: unknown[]) => {});
const mockRecordAudit = jest.fn();
const mockCreateApproval = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-code/pipeline", () => ({ runPipeline: (...a: unknown[]) => mockRunPipeline(...a) }));
jest.mock("@/lib/ai-code/repair", () => ({ liveRepairComplete: () => async () => "" }));
jest.mock("@/lib/ai-code/scan", () => ({ runCodeReview: jest.fn() }));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
  trackEventAwait: (...a: unknown[]) => mockTrackEventAwait(...a),
}));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a), recordAuditNonFatal: (...a: unknown[]) => mockRecordAudit(...a) }));
jest.mock("@/lib/agents/approvals/store", () => ({ createPendingApproval: (...a: unknown[]) => mockCreateApproval(...a) }));
const mockEnsureCodeGateAgent = jest.fn();
jest.mock("@/lib/agents/store", () => ({ ensureCodeGateAgent: (...a: unknown[]) => mockEnsureCodeGateAgent(...a) }));
const mockGate = jest.fn();
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }) }));
const mockWorkspaceClient = jest.fn();
const mockBuildContext = jest.fn();
const mockFetchFile = jest.fn();
const mockFetchTree = jest.fn();
jest.mock("@/lib/github-client", () => ({
  workspaceGithubClient: (...a: unknown[]) => mockWorkspaceClient(...a),
  fetchFileContent: (...a: unknown[]) => mockFetchFile(...a),
  fetchRepoTree: (...a: unknown[]) => mockFetchTree(...a),
}));
jest.mock("@/lib/ai-code/repo-context", () => ({
  buildRepoContext: (...a: unknown[]) => mockBuildContext(...a),
  withRepoContext: (prompt: string, block: string) => (block ? block + "\n" + prompt : prompt),
  extractMentionedPaths: () => [],
}));
const mockReuseScout = jest.fn(async (..._a: unknown[]) => ({ block: "", candidates: [] as Array<{ path: string; score: number }> }));
jest.mock("@/lib/ai-code/reuse-scout", () => ({ findReuseCandidates: (...a: unknown[]) => mockReuseScout(...a) }));
const mockEscalationPins = jest.fn((..._a: unknown[]) => [] as { pin: string; tier: string }[]);
jest.mock("@/lib/ai/router", () => ({
  ...jest.requireActual("@/lib/ai/router"),
  escalationProviderPins: (...a: unknown[]) => mockEscalationPins(...a),
}));

import { POST } from "../route";

const AUTHORED_DIFF = "diff --git a/src/k.ts b/src/k.ts\n--- /dev/null\n+++ b/src/k.ts\n@@ -0,0 +1 @@\n+export const k = 1;";
// A new file truncated before its closing brace - the exact dogfooding failure.
const TRUNCATED_DIFF = "diff --git a/src/lib/slug.ts b/src/lib/slug.ts\n--- /dev/null\n+++ b/src/lib/slug.ts\n@@ -0,0 +1,2 @@\n+export function slugify(s: string): string {\n+  return s.toLowerCase();";
const authorResp = (content: string) => ({ content, model_used: "azure-gpt-4o", provider_used: "azure-openai", input_tokens: 1, output_tokens: 1, cost_usd: 0.0001, latency_ms: 100 });
// The escalation retry authors in FILES mode (full contents), so a retry response
// must be in the files-mode format (`FILE: path` + fenced content), not a diff.
const filesResp = (path: string, content: string) => authorResp(`FILE: ${path}\n\`\`\`\n${content}\n\`\`\``);

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
  mockFetchFile.mockResolvedValue(null); // no package.json by default -> phantom check is a no-op
  mockFetchTree.mockResolvedValue([]); // empty repo tree by default -> local-import gate is a no-op
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

  it("reuse scout: surfaced existing-capability candidates are prepended to the author prompt", async () => {
    // The anti-duplication control: an intent task ("add a cost counter") gets the
    // existing cost files injected so the author reuses instead of re-implementing.
    mockReuseScout.mockResolvedValueOnce({
      block: "REUSE CHECK - read these before writing new code:\n- src/lib/ai-code/cost.ts",
      candidates: [{ path: "src/lib/ai-code/cost.ts", score: 4 }],
    });
    mockBuildContext.mockResolvedValue({ block: "", files: [] });
    mockComplete.mockResolvedValue(authorResp("```diff\n" + AUTHORED_DIFF + "\n```"));
    await POST(post({ ref: "pr-reuse", prompt: "add a cost counter", answers: { tests: "all" }, repo: "acme/app" }));
    const authorMsg = mockComplete.mock.calls[0][0].messages[0].content as string;
    expect(authorMsg).toMatch(/REUSE CHECK/);
    expect(authorMsg).toMatch(/src\/lib\/ai-code\/cost\.ts/);
  });

  it("the frozen spec GOVERNS authoring: directives are prepended to the author prompt", async () => {
    // Root-cause fix for the parseRange contradiction - the author now sees the
    // consistency directive + the resolved error-handling / strictness directives.
    mockComplete.mockResolvedValue(authorResp("```diff\n" + AUTHORED_DIFF + "\n```"));
    await POST(post({ ref: "pr-spec", prompt: "add parseRange", answers: { error_handling: "throw", input_strictness: "strict" } }));
    const authorMsg = mockComplete.mock.calls[0][0].messages[0].content as string;
    expect(authorMsg).toMatch(/Spec directives \(follow exactly\)/);
    expect(authorMsg).toMatch(/ONE consistent interpretation/i); // the consistency directive
    expect(authorMsg).toMatch(/THROW an error/i);                 // error_handling: throw
    expect(authorMsg).toMatch(/STRICTLY/i);                        // input_strictness: strict
  });

  it("governed fallback: an empty first draft is retried at a higher tier and the run proceeds", async () => {
    // First author returns prose (no diff); the escalated retry returns a real diff.
    mockComplete
      .mockResolvedValueOnce(authorResp("I would add a function called k."))
      .mockResolvedValue(filesResp("src/k.ts", "export const k = 1;"));
    const res = await POST(post({ ref: "pr-fb", prompt: "add k", answers: { tests: "all" } }));
    expect(res.status).toBe(200); // did NOT dead-end on the first empty draft
    const body = await res.json();
    expect(body.executorAttempts).toBe(2); // the agent was tagged in a second time
    expect(mockRunPipeline).toHaveBeenCalled();
  });

  it("modification-only diff (an EDIT) recovers in files mode so it is committable", async () => {
    // The edit-existing dogfood gap: a diff that only MODIFIES existing lines
    // yields no committable full files, so it is ready-looking but uncommittable.
    // It must recover in files mode (full edited contents).
    const MOD_DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;";
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + MOD_DIFF + "\n```")) // modification-only: no committable files
      .mockResolvedValue(filesResp("src/x.ts", "export const x = 2;"));    // recovery: full contents
    const res = await POST(post({ ref: "pr-edit", prompt: "change x to 2", answers: { tests: "unit" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    expect(body.mode).toBe("files"); // recovered to files -> committable
    const retryPrompt = mockComplete.mock.calls[1][0].messages[0].content as string;
    expect(retryPrompt).toMatch(/modification-only diff/i);
  });

  it("escalation retry recovers in FILES mode (full contents), even when the first attempt was diff", async () => {
    // Diff mode garbles new-file authoring; the recovery switches to files mode.
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + TRUNCATED_DIFF + "\n```")) // diff, unparseable
      .mockResolvedValue(filesResp("src/lib/slug.ts", "export const slug = 1;"));   // recovery: files mode
    const res = await POST(post({ ref: "pr-recover", prompt: "add slug", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    expect(body.mode).toBe("files"); // effective mode reflects the files-mode recovery
    // The retry hit the files-mode authoring system prompt, not the diff one.
    const retrySystem = mockComplete.mock.calls[1][0].system as string;
    expect(retrySystem).not.toBe(mockComplete.mock.calls[0][0].system);
  });

  it("escalation retry carries the PARSE ERROR as feedback (not a blind re-run)", async () => {
    // The apex dogfooding case: the first author produces an unparseable file. The
    // premium retry must be TOLD what failed to parse, not just re-run the same
    // prompt at a higher tier - that is what turns a needs_human hold into a
    // converged draft.
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + TRUNCATED_DIFF + "\n```")) // does not parse
      .mockResolvedValue(filesResp("src/lib/slug.ts", "export function slugify(s: string): string { return s.toLowerCase(); }")); // premium retry: valid (files mode)
    const res = await POST(post({ ref: "pr-fb3", prompt: "add slugify", answers: { tests: "all" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    // The SECOND author call's user message must include the deterministic parse error.
    const retryPrompt = mockComplete.mock.calls[1][0].messages[0].content as string;
    expect(retryPrompt).toMatch(/did NOT parse/i);
    expect(retryPrompt).toMatch(/src\/lib\/slug\.ts/); // the offending file is named
  });

  it("files/diff self-heal escalates to a DISTINCT provider (not a tier bump that collapses to cheap)", async () => {
    // The live-dogfood finding: a "premium" tier bump re-runs the SAME cheap model
    // in a single-Azure-deployment env. When a genuinely-distinct provider exists,
    // the self-heal must PIN it at the tier it serves - routing work UP for real.
    mockEscalationPins.mockReturnValue([{ pin: "foundry", tier: "cheap" }]);
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + TRUNCATED_DIFF + "\n```")) // first draft does not parse -> feedback
      .mockResolvedValue(filesResp("src/lib/slug.ts", "export function slugify(s: string): string { return s.toLowerCase(); }"));
    const res = await POST(post({ ref: "pr-escalate-files", prompt: "add slugify", answers: { tests: "all" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    // The recovery pinned the distinct provider at its served tier - NOT a premium bump.
    expect(mockComplete).toHaveBeenLastCalledWith(expect.objectContaining({ provider_pin: "foundry", model_tier: "cheap" }));
  });

  const NOOKIES_DIFF = 'diff --git a/src/x.ts b/src/x.ts\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1,2 @@\n+import { parseCookies } from "nookies";\n+export const x = 1;';
  const CLEAN_NEW_DIFF = "diff --git a/src/x.ts b/src/x.ts\n--- /dev/null\n+++ b/src/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;";

  it("phantom dependency: escalation retry is told the import is not in package.json, and it never hands off", async () => {
    // The apex `nookies` hallucination: an import of a package not in package.json.
    // installedRoots comes from the package.json fetch, so a repo must be supplied.
    mockFetchFile.mockResolvedValue(JSON.stringify({ dependencies: { next: "1" }, devDependencies: { jest: "1" } }));
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + NOOKIES_DIFF + "\n```")) // first (diff) imports nookies
      .mockResolvedValue(filesResp("src/x.ts", 'import { parseCookies } from "nookies";\nexport const x = 1;')); // retry (files) still imports it
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: NOOKIES_DIFF });
    const res = await POST(post({ ref: "pr-phantom", prompt: "add x", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2); // phantom import made the first draft "bad" -> retried
    const retryPrompt = mockComplete.mock.calls[1][0].messages[0].content as string;
    expect(retryPrompt).toMatch(/nookies/);
    expect(retryPrompt).toMatch(/not in package\.json/i);
    // Still phantom after the retry -> never hands off (no PR), and the phantom is surfaced.
    expect(body.approvalId).toBeNull();
    expect(body.phantomImports).toEqual(expect.arrayContaining([expect.objectContaining({ module: "nookies" })]));
  });

  it("phantom dependency self-corrects: the retry drops the bad import -> clean, hands off", async () => {
    mockFetchFile.mockResolvedValue(JSON.stringify({ dependencies: { next: "1" } }));
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + NOOKIES_DIFF + "\n```"))
      .mockResolvedValue(filesResp("src/x.ts", "export const x = 1;")); // retry drops the phantom import
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: CLEAN_NEW_DIFF });
    const res = await POST(post({ ref: "pr-phantom-fix", prompt: "add x", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    expect(body.phantomImports).toEqual([]); // converged - no phantom in the final draft
    expect(body.approvalId).toBe("appr-1"); // clean -> handed off
  });

  // The exact hole that shipped a red WWP guest-export PR (#229): an import of a
  // NAMED symbol a REAL local module does not export. It passes the phantom gate
  // (not a bare package) and the syntax gate (it parses), but always fails CI
  // ("has no exported member"). The gate must now catch it and refuse handoff.
  const BROKEN_LOCAL_DIFF = 'diff --git a/src/app/r/route.ts b/src/app/r/route.ts\n--- /dev/null\n+++ b/src/app/r/route.ts\n@@ -0,0 +1,2 @@\n+import { missingFn } from "@/lib/real";\n+export const GET = () => missingFn();';

  const realRepoMocks = () => {
    mockFetchTree.mockResolvedValue(["src/lib/real.ts"]); // @/lib/real resolves to a real file...
    mockFetchFile.mockImplementation(async (_c: unknown, _r: unknown, path: string) => {
      if (path === "tsconfig.json") return JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
      if (path === "src/lib/real.ts") return "export function realFn() {}"; // ...but it has NO missingFn
      return null;
    });
  };
  const ROUTE_PATH = "src/app/r/route.ts";
  const brokenFiles = `import { missingFn } from "@/lib/real";\nexport const GET = () => missingFn();`;
  const fixedFiles = `import { realFn } from "@/lib/real";\nexport const GET = () => realFn();`;

  it("broken local import (#229) SELF-HEALS: a stronger model gets the exact failure and fixes it", async () => {
    realRepoMocks();
    // First draft hallucinates the import; the escalation retry (files mode) fixes it.
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + BROKEN_LOCAL_DIFF + "\n```"))
      .mockResolvedValue(filesResp(ROUTE_PATH, fixedFiles));
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: BROKEN_LOCAL_DIFF });
    const res = await POST(post({ ref: "pr-selfheal", prompt: "add route", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2); // the broken import triggered a retry
    // The retry was told exactly what was wrong.
    const retryPrompt = mockComplete.mock.calls[1][0].messages[0].content as string;
    expect(retryPrompt).toMatch(/missingFn/);
    expect(body.brokenLocalImports).toEqual([]); // converged
    expect(body.selfHealed).toBe(true);
    expect(body.approvalId).toBe("appr-1"); // clean -> handed off, no human needed
  });

  it("broken local import that the retry does NOT fix still blocks handoff (needs_human)", async () => {
    realRepoMocks();
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + BROKEN_LOCAL_DIFF + "\n```"))
      .mockResolvedValue(filesResp(ROUTE_PATH, brokenFiles)); // retry still broken
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: BROKEN_LOCAL_DIFF });
    const res = await POST(post({ ref: "pr-broken-local", prompt: "add route", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    expect(body.selfHealed).toBe(false);
    expect(body.approvalId).toBeNull(); // never handed off
    expect(body.run.status).toBe("needs_human"); // never a misleading "ready"
    expect(body.brokenLocalImports).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "missing_export", spec: "@/lib/real", name: "missingFn" })]),
    );
  });

  it("a SELF-HOSTED run (no repo) is still grounded + import-validated (not skipped)", async () => {
    // Found by dogfooding: self-targeted runs (repo omitted) are how the factory
    // maintains its OWN code, yet grounding + the local-import gate were gated on a
    // repo being supplied, so a hallucinated import sailed through. Now they run
    // against the self repo, so the same broken import is caught WITHOUT a repo param.
    realRepoMocks();
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + BROKEN_LOCAL_DIFF + "\n```"))
      .mockResolvedValue(filesResp(ROUTE_PATH, brokenFiles));
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: BROKEN_LOCAL_DIFF });
    const res = await POST(post({ ref: "pr-self-hosted", prompt: "add route", answers: { tests: "all" } })); // NO repo
    const body = await res.json();
    expect(body.approvalId).toBeNull();
    expect(body.run.status).toBe("needs_human");
    expect(body.brokenLocalImports).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "missing_export", name: "missingFn" })]),
    );
  });

  it("valid local import against a real repo module hands off cleanly (no false-positive)", async () => {
    mockFetchTree.mockResolvedValue(["src/lib/real.ts"]);
    mockFetchFile.mockImplementation(async (_c: unknown, _r: unknown, path: string) => {
      if (path === "tsconfig.json") return JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
      if (path === "src/lib/real.ts") return "export function realFn() {}";
      return null;
    });
    const GOOD_LOCAL_DIFF = 'diff --git a/src/app/r/route.ts b/src/app/r/route.ts\n--- /dev/null\n+++ b/src/app/r/route.ts\n@@ -0,0 +1,2 @@\n+import { realFn } from "@/lib/real";\n+export const GET = () => realFn();';
    mockComplete.mockResolvedValue(authorResp("```diff\n" + GOOD_LOCAL_DIFF + "\n```"));
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: GOOD_LOCAL_DIFF });
    const res = await POST(post({ ref: "pr-good-local", prompt: "add route", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.brokenLocalImports).toEqual([]);
    expect(body.approvalId).toBe("appr-1"); // clean -> handed off
  });

  const FRAGMENT_TEST_DIFF = 'diff --git a/src/x.test.ts b/src/x.test.ts\n--- /dev/null\n+++ b/src/x.test.ts\n@@ -0,0 +1 @@\n+const lines = data.split("x");';
  const REAL_TEST_DIFF = 'diff --git a/src/x.test.ts b/src/x.test.ts\n--- /dev/null\n+++ b/src/x.test.ts\n@@ -0,0 +1 @@\n+describe("x", () => { it("works", () => { expect(1).toBe(1); }); });';

  it("incomplete test file (no test case): retry is told, and it never hands off", async () => {
    // The apex fragment: a *.test.ts that PARSES but has no test -> jest fails it.
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + FRAGMENT_TEST_DIFF + "\n```")) // first (diff) fragment
      .mockResolvedValue(filesResp("src/x.test.ts", 'const lines = data.split("x");')); // retry (files) still no test
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: FRAGMENT_TEST_DIFF });
    const res = await POST(post({ ref: "pr-frag", prompt: "add a test", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2); // fragment is a bad draft -> retried
    const retryPrompt = mockComplete.mock.calls[1][0].messages[0].content as string;
    expect(retryPrompt).toMatch(/INCOMPLETE|no test case/i);
    expect(body.approvalId).toBeNull(); // still incomplete -> no handoff
    expect(body.incompleteFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/x.test.ts" })]));
  });

  it("incomplete test file self-corrects: retry adds real test cases -> hands off", async () => {
    mockComplete
      .mockResolvedValueOnce(authorResp("```diff\n" + FRAGMENT_TEST_DIFF + "\n```"))
      .mockResolvedValue(filesResp("src/x.test.ts", 'describe("x", () => { it("works", () => { expect(1).toBe(1); }); });')); // retry adds a real test
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: REAL_TEST_DIFF });
    const res = await POST(post({ ref: "pr-frag-fix", prompt: "add a test", repo: "acme/app", answers: { tests: "all" } }));
    const body = await res.json();
    expect(body.executorAttempts).toBe(2);
    expect(body.incompleteFiles).toEqual([]);
    expect(body.approvalId).toBe("appr-1");
  });

  it("removed export blocks handoff (the deleted-decide regression): escalates, no PR", async () => {
    // The edit rewrites an existing file and drops a public export. The base file
    // has `decide` + `riskTierFor`; the authored file keeps only `riskTierFor`.
    const EDIT_DROPS_EXPORT = "diff --git a/src/lib/ogiam/policy.ts b/src/lib/ogiam/policy.ts\n--- /dev/null\n+++ b/src/lib/ogiam/policy.ts\n@@ -0,0 +1 @@\n+export function riskTierFor() { return \"low\"; }";
    mockComplete.mockResolvedValue(authorResp("```diff\n" + EDIT_DROPS_EXPORT + "\n```"));
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: EDIT_DROPS_EXPORT });
    // Base file content (the "before") still exports decide.
    mockFetchFile.mockImplementation((_c: unknown, _r: unknown, path: string) =>
      Promise.resolve(path === "src/lib/ogiam/policy.ts" ? "export function decide(){}\nexport function riskTierFor(){}" : null),
    );
    const res = await POST(post({ ref: "pr-dropexport", prompt: "tidy policy.ts", repo: "acme/app", answers: { tests: "unit" } }));
    const body = await res.json();
    expect(body.approvalId).toBeNull(); // removed export -> no handoff
    expect(body.removedExports).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/lib/ogiam/policy.ts", name: "decide" })]));
  });

  it("preserving all exports while editing hands off normally", async () => {
    const EDIT_KEEPS_EXPORTS = "diff --git a/src/lib/ogiam/policy.ts b/src/lib/ogiam/policy.ts\n--- /dev/null\n+++ b/src/lib/ogiam/policy.ts\n@@ -0,0 +1,2 @@\n+export function decide(){ return 2; }\n+export function riskTierFor(){}";
    mockComplete.mockResolvedValue(authorResp("```diff\n" + EDIT_KEEPS_EXPORTS + "\n```"));
    mockRunPipeline.mockResolvedValue({ ...RUN, status: "ready_for_pr", diff: EDIT_KEEPS_EXPORTS });
    mockFetchFile.mockImplementation((_c: unknown, _r: unknown, path: string) =>
      Promise.resolve(path === "src/lib/ogiam/policy.ts" ? "export function decide(){}\nexport function riskTierFor(){}" : null),
    );
    const res = await POST(post({ ref: "pr-keepexport", prompt: "edit policy.ts", repo: "acme/app", answers: { tests: "unit" } }));
    const body = await res.json();
    expect(body.removedExports).toEqual([]);
    expect(body.approvalId).toBe("appr-1");
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

  it("the 422 surfaces WHY (executor error), e.g. an unconfigured pinned provider", async () => {
    // The author never throws; a failed complete() becomes an empty diff + error.
    mockComplete.mockRejectedValue(new Error("anthropic: ANTHROPIC_API_KEY not set"));
    const res = await POST(post({ ref: "pr-nocfg", prompt: "add k", answers: { tests: "all" }, executorProviderPin: "anthropic" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/no change/);
    expect(body.error).toMatch(/ANTHROPIC_API_KEY not set/); // the real reason, not just "no change"
  });

  it("authorTier pins the capability tier the executor authors at (for cross-model grading)", async () => {
    await POST(post({ ref: "pr-tier", prompt: "add k", answers: { tests: "all" }, authorTier: "premium" }));
    // First author call carries the pinned tier (the retry, if any, escalates further).
    expect(mockComplete.mock.calls[0][0].model_tier).toBe("premium");
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
    // AWAITED so the Run history row survives the serverless freeze.
    expect(mockTrackEventAwait).toHaveBeenCalledWith(
      "ai_code.pipeline_run",
      "u1",
      "admin",
      expect.objectContaining({ ref: "pr-1", spec_hash: "spec_abc123", status: "ready_for_pr", conforms: true }),
    );
    // Regression guard: the run event must NOT go through the fire-and-forget
    // path, or it is lost when the lambda freezes (the "only one run" bug).
    const fireAndForgetRun = mockTrackEvent.mock.calls.find((c: unknown[]) => c[0] === "ai_code.pipeline_run");
    expect(fireAndForgetRun).toBeUndefined();
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
  const call = mockTrackEventAwait.mock.calls.find((c: unknown[]) => c[0] === "ai_code.pipeline_run");
  expect(call).toBeDefined();
  const meta = (call as unknown[])[3] as Record<string, unknown>;
  expect(meta.diff).toBe("d");             // the run's diff, persisted (capped)
  expect(meta.diff_truncated).toBe(false); // "d" is well under the cap
  expect(meta).toHaveProperty("verdict_reason");
});


describe("anchor mode (large-file edits)", () => {
  it("applies a matching SEARCH/REPLACE to the fetched file and hands off cleanly", async () => {
    mockFetchFile.mockImplementation((_c: unknown, _r: unknown, path: string) =>
      Promise.resolve(path === "src/x.ts" ? "export const a = 1;\nexport const b = 2;" : null));
    mockComplete.mockResolvedValue(authorResp(
      "EDIT src/x.ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE"));
    const res = await POST(post({ ref: "pr-anchor", prompt: "change a to 2", answers: { tests: "all" }, repo: "acme/app", mode: "anchor" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.anchorFailures).toEqual([]);
    // the edited full-file content flows to the gate; a benign change is handed off
    expect(body.approvalId).toBe("appr-1");
  });

  it("reports a non-matching anchor and does NOT hand off (never a bad or partial auto-PR)", async () => {
    mockFetchFile.mockImplementation((_c: unknown, _r: unknown, path: string) =>
      Promise.resolve(path === "src/x.ts" ? "export const a = 1;" : null));
    mockComplete.mockResolvedValue(authorResp(
      "EDIT src/x.ts\n<<<<<<< SEARCH\nexport const NOPE = 9;\n=======\nx\n>>>>>>> REPLACE"));
    const res = await POST(post({ ref: "pr-anchor-fail", prompt: "edit", answers: { tests: "all" }, repo: "acme/app", mode: "anchor" }));
    const body = await res.json();
    // no change applied -> 422, with the anchor failure surfaced so it is diagnosable
    expect(res.status).toBe(422);
    expect(body.anchorFailures).toEqual([{ path: "src/x.ts", reason: "anchor_not_found" }]);
    expect(mockCreateApproval).not.toHaveBeenCalled();
  });

  it("escalates a failed anchor to a DIFFERENT model by pin, which lands the edit (the route-to-a-model-that-can design)", async () => {
    mockFetchFile.mockImplementation((_c: unknown, _r: unknown, path: string) =>
      Promise.resolve(path === "src/x.ts" ? "export const a = 1;" : null));
    // A genuinely-distinct available model exists to escalate to (what the benchmark proved).
    mockEscalationPins.mockReturnValue([{ pin: "foundry", tier: "cheap" }]);
    // First (default-model) author MISSES the anchor; the escalated author - pinned to
    // deepseek, with the exact failure fed back - copies it verbatim and it applies.
    mockComplete
      .mockResolvedValueOnce(authorResp("EDIT src/x.ts\n<<<<<<< SEARCH\nexport const NOPE = 9;\n=======\nx\n>>>>>>> REPLACE"))
      .mockResolvedValueOnce(authorResp("EDIT src/x.ts\n<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE"));
    const res = await POST(post({ ref: "pr-anchor-escalate", prompt: "change a to 2", answers: { tests: "all" }, repo: "acme/app", mode: "anchor" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.anchorFailures).toEqual([]);
    expect(body.approvalId).toBe("appr-1"); // the escalated edit was clean -> handed off
    expect(body.executorAttempts).toBe(2); // re-authored once on the stronger model
    expect(mockComplete).toHaveBeenCalledTimes(2);
    // the retry was PINNED to the escalation model, not the original
    expect(mockComplete).toHaveBeenLastCalledWith(expect.objectContaining({ provider_pin: "foundry", model_tier: "cheap" }));
  });

  it("exhausts the available models then honestly reaches needs_human (never a bad auto-PR)", async () => {
    mockFetchFile.mockImplementation((_c: unknown, _r: unknown, path: string) =>
      Promise.resolve(path === "src/x.ts" ? "export const a = 1;" : null));
    mockEscalationPins.mockReturnValue([{ pin: "foundry", tier: "cheap" }, { pin: "anthropic", tier: "premium" }]);
    // Every model misses the anchor -> no edit is ever applied.
    mockComplete.mockResolvedValue(authorResp("EDIT src/x.ts\n<<<<<<< SEARCH\nexport const NOPE = 9;\n=======\nx\n>>>>>>> REPLACE"));
    const res = await POST(post({ ref: "pr-anchor-exhaust", prompt: "edit", answers: { tests: "all" }, repo: "acme/app", mode: "anchor" }));
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.anchorFailures).toEqual([{ path: "src/x.ts", reason: "anchor_not_found" }]);
    expect(mockCreateApproval).not.toHaveBeenCalled(); // never a partial/guessed PR
  });
});
