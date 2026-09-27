/**
 * /api/github-app/webhook - the Secure Agent PR-gate.
 *
 * PUBLIC: authenticated by a GitHub HMAC signature, not a user session. GitHub
 * delivers events server-to-server, so there is no JWT to check; the signature
 * over the raw body IS the authentication (verifyWebhookSignature, fail-closed).
 *
 * When our App is installed on a client's repo, GitHub delivers `pull_request`
 * events here. For each opened / synchronized / reopened PR we run the SAME
 * deterministic gate the factory uses over the PR diff and post the verdict as a
 * Check Run. It gates ANY author, GitHub Copilot's coding-agent PRs included:
 * the client installs the App and configures nothing (no CI, no workflow file,
 * no secret on their side). Making the check REQUIRED is their one optional step.
 *
 * Governance: every verdict runs through the OGIAM gate + hash-chained ledger
 * (authorize + recordActionOutcome), exactly like open-pr-executor, and emits a
 * tracked ai_code.pr_gated event so the decision feeds the learning loop.
 *
 * We never 500 a delivery: an unknown installation, an unentitled tenant, a
 * missing token, or an internal error are all acknowledged (200) so GitHub does
 * not retry-storm; the reason is recorded, not thrown.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/github-app/webhook-verify";
import { getWorkspaceByInstallation } from "@/lib/github-app/storage";
import { resolveEntitlement } from "@/lib/tenancy/entitlements";
import {
  workspaceGithubClient,
  fetchPullRequestDiff,
  createCheckRun,
  createPrComment,
} from "@/lib/github-client";
import { gatePullRequestDiff, PR_GATE_CHECK_NAME } from "@/lib/ai-code/pr-gate";
import { authorize } from "@/lib/ogiam/authorize";
import { recordActionOutcome } from "@/lib/ogiam/ledger";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

// PR actions that change code and so warrant a (re)gate. Others (labeled,
// assigned, closed) do not touch the diff.
const GATE_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

interface PullRequestEvent {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    head?: { sha?: string };
    user?: { login?: string };
  };
}

function ack(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status: 200 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature(raw, sig, process.env.GITHUB_APP_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  // Only pull_request events drive the gate. installation / ping / push are
  // acknowledged so GitHub marks the delivery successful.
  if (event !== "pull_request") return ack({ ok: true, ignored: event || "unknown" });

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(raw) as PullRequestEvent;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = String(payload.action ?? "");
  if (!GATE_ACTIONS.has(action)) return ack({ ok: true, ignored: `pull_request.${action}` });

  const installationId = String(payload.installation?.id ?? "");
  const repo = String(payload.repository?.full_name ?? "");
  const prNumber = Number(payload.pull_request?.number);
  const headSha = String(payload.pull_request?.head?.sha ?? "");
  const authorLogin = String(payload.pull_request?.user?.login ?? "");
  if (!installationId || !repo || !Number.isFinite(prNumber) || !headSha) {
    return ack({ ok: true, ignored: "incomplete_payload" });
  }

  // Resolve the tenant from the installation. Unknown installation = not ours.
  const install = await getWorkspaceByInstallation(installationId);
  if (!install) return ack({ ok: true, ignored: "unknown_installation" });
  const workspaceId = install.workspaceId;

  // Only gate for tenants entitled to Secure Agent.
  if (!(await resolveEntitlement(workspaceId, "secure_agent"))) {
    return ack({ ok: true, ignored: "not_entitled" });
  }

  // Governed decision on the OGIAM ledger, the same PEP the factory uses.
  const decision = await authorize({
    principal: {
      kind: "ai_agent",
      agent: "instinct.ai_code",
      onBehalfOfUserId: install.linkedBy,
      onBehalfOfRole: "system",
      workspaceId,
    },
    tool: "ai_code.pr_gate",
    capability: "code.write",
    isMutation: true,
    surface: "/agent",
    params: { repo, pr: prNumber },
    mode: "monitor",
  });
  const startMs = Date.now();
  const recordOutcome = async (ok: boolean, code: string, result: string): Promise<void> => {
    if (decision.recordedSeq == null) return;
    await recordActionOutcome({
      workspaceId,
      decisionSeq: decision.recordedSeq,
      agentId: "instinct.ai_code",
      ok,
      code,
      resultRedacted: result,
      durationMs: Date.now() - startMs,
    }).catch(() => {});
  };

  try {
    const client = await workspaceGithubClient(workspaceId);
    if (!client.token) {
      await recordOutcome(false, "no_token", "no GitHub token for gate");
      return ack({ ok: true, ignored: "no_token" });
    }

    const diff = await fetchPullRequestDiff(client, repo, prNumber);
    const verdict = await gatePullRequestDiff(diff);

    await createCheckRun(client, repo, {
      headSha,
      name: PR_GATE_CHECK_NAME,
      conclusion: verdict.conclusion,
      title: verdict.title,
      summary: verdict.summary,
    });

    // On a block, also leave one comment so the signal is visible even without
    // branch protection (value from just the install). Best effort.
    if (verdict.conclusion !== "success") {
      await createPrComment(
        client,
        repo,
        prNumber,
        `**Secure Agent gate blocked this PR.**\n\n${verdict.summary}`,
      ).catch(() => {});
    }

    trackEvent("ai_code.pr_gated", install.linkedBy, "system", {
      workspace_id: workspaceId,
      repo,
      pr_number: String(prNumber),
      conclusion: verdict.conclusion,
      blocked_by: verdict.assessment.blockedBy ?? "none",
      author_login: authorLogin,
    });
    // Hash-chained audit of the gate verdict: posting a merge-blocking (or
    // clearing) decision on a client's PR is a security-relevant action.
    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: install.linkedBy, role: "system" },
      action: "secure_agent.pr_gated",
      resourceType: "github_pull_request",
      resourceId: `${repo}#${prNumber}`,
      afterState: {
        workspace_id: workspaceId,
        conclusion: verdict.conclusion,
        blocked_by: verdict.assessment.blockedBy ?? "none",
        author_login: authorLogin,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));
    await recordOutcome(
      verdict.conclusion === "success",
      verdict.conclusion === "success" ? "pr_pass" : "pr_block",
      `${repo}#${prNumber}: ${verdict.title}`,
    );

    return ack({ ok: true, repo, pr: prNumber, conclusion: verdict.conclusion });
  } catch (err) {
    await recordOutcome(false, "gate_error", (err as Error).message);
    // Never 500 a webhook delivery on our internal error: acknowledge softly.
    return ack({ ok: false, error: "gate_error" });
  }
}
