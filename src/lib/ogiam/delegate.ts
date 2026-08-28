/**
 * Hand a task to an external agent, and record what came back.
 *
 * THE HALF THAT WAS MISSING. /api/gate/authorize is reactive: their agent
 * decides to act and asks whether it may. /api/gate/complete runs its
 * reasoning through our router. Both are things the agent starts. Neither
 * lets us give it work.
 *
 * Driving means we initiate. An operator assigns a task, we deliver it to the
 * agent's registered endpoint, and the agent does the work, coming back
 * through the gate for anything it needs authorized. That is the difference
 * between governing an agent and leading one, and it is what makes somebody
 * else's agent usable as part of an engagement rather than merely tolerated
 * alongside it.
 *
 * WHAT MAKES THIS DANGEROUS, and what is done about it.
 *
 * Sending a request to a stored URL is server-side request forgery waiting to
 * happen. A hostname that is public when it is registered can point at
 * 169.254.169.254 an hour later, so the URL is re-validated by
 * assertScannableUrl at EVERY dispatch rather than trusted from storage. That
 * guard already refuses private ranges, loopback, .local and .internal, IPv6
 * literals in bracket form, and any hostname that RESOLVES into a private
 * range.
 *
 * The delivery carries no secret. It names the task and the workspace and
 * nothing else. An agent proves who it is by calling US back with its own key;
 * we never send it a credential it could leak, and we never send it one of
 * ours.
 *
 * It is signed, so the receiving agent can tell a real assignment from anyone
 * who learned its endpoint. The signature covers the body and a timestamp, and
 * the shared secret is the same key hash the agent already holds, so there is
 * no second credential to distribute or rotate.
 *
 * The response is bounded and its content is never executed or trusted. What
 * comes back is a report to be read by a person, not an instruction.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { assertScannableUrl } from "@/lib/platform-scan/ssrf-guard";
import { trackEvent } from "@/lib/analytics";

/** Long enough for an agent to acknowledge, short enough not to hang a queue. */
const DISPATCH_TIMEOUT_MS = 10_000;
/** A report, not a payload. Anything larger is a mistake or an attack. */
const MAX_RESPONSE_CHARS = 20_000;

export interface DelegationTarget {
  keyId: string;
  workspaceId: string;
  agent: string;
  /** Null when this agent was never made delegable. */
  delegationUrl: string | null;
  capabilities: readonly string[];
}

export interface DelegationResult {
  delivered: boolean;
  /** Why not, in the operator's terms. Absent when it was delivered. */
  refused?: string;
  /** HTTP status the agent answered with, when it answered at all. */
  status?: number;
  /** What the agent said, bounded. Never executed, never trusted. */
  report?: string;
}

export interface DelegateDeps {
  fetchImpl?: typeof fetch;
  assertUrl?: typeof assertScannableUrl;
  now?: () => number;
}

/**
 * Sign a delegation so the receiver can tell it came from us.
 *
 * Exported for the receiving side: an agent operator implementing our contract
 * needs the exact construction, and describing it in prose is how two
 * implementations end up disagreeing about whether a trailing newline counts.
 */
export function delegationSignature(
  secret: string,
  body: string,
  timestamp: number,
): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Constant-time comparison, for anyone verifying one of ours. */
export function verifyDelegationSignature(
  secret: string,
  body: string,
  timestamp: number,
  signature: string,
): boolean {
  const expected = delegationSignature(secret, body, timestamp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function delegateTask(
  input: {
    target: DelegationTarget;
    /** What the agent is being asked to do, in plain language. */
    instruction: string;
    /** Shared secret for the signature. The agent's stored key hash. */
    signingSecret: string;
    actor: { userId: string; role: string };
  },
  deps: DelegateDeps = {},
): Promise<DelegationResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const assertUrl = deps.assertUrl ?? assertScannableUrl;
  const now = deps.now ?? Date.now;

  const { target, instruction } = input;

  if (!target.delegationUrl) {
    return {
      delivered: false,
      refused: `${target.agent} has no delegation endpoint registered, so it cannot be given work.`,
    };
  }

  /* RE-VALIDATED AT DISPATCH, not trusted from storage. A hostname that was
     public at registration can point somewhere internal by the time we send. */
  try {
    await assertUrl(target.delegationUrl);
  } catch (err) {
    trackEvent("platform.gate_api_blocked", `apikey:${target.keyId}`, "external_agent", {
      reason: "delegation_url_blocked",
      agent: target.agent,
      detail: err instanceof Error ? err.message.slice(0, 200) : "blocked",
    });
    return {
      delivered: false,
      refused: `The endpoint registered for ${target.agent} is not one we will send to.`,
    };
  }

  /* HTTPS only for delivery. The SSRF guard permits http for scanning a site,
     which is a different risk: here we are sending an instruction somebody
     will act on, and it must not be readable or rewritable in transit. */
  if (!target.delegationUrl.toLowerCase().startsWith("https://")) {
    return {
      delivered: false,
      refused: `${target.agent} must register an https endpoint before it can be given work.`,
    };
  }

  const timestamp = now();
  /* NO CREDENTIAL TRAVELS. The agent proves who it is by calling us back with
     its own key. We never hand it one. */
  const body = JSON.stringify({
    workspace_id: target.workspaceId,
    agent: target.agent,
    instruction,
    /* So the agent knows where to come back to for authorization, and that it
       is expected to. */
    gate: "/api/gate/authorize",
    issued_at: new Date(timestamp).toISOString(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

  try {
    const res = await fetchImpl(target.delegationUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Instinct-Timestamp": String(timestamp),
        "X-Instinct-Signature": delegationSignature(input.signingSecret, body, timestamp),
      },
      body,
      signal: controller.signal,
    });

    const text = (await res.text().catch(() => "")).slice(0, MAX_RESPONSE_CHARS);

    trackEvent("platform.gate_api_delegated", `apikey:${target.keyId}`, "external_agent", {
      agent: target.agent,
      workspace_id: target.workspaceId,
      status: res.status,
      accepted: res.ok,
    });

    if (!res.ok) {
      return {
        delivered: false,
        status: res.status,
        refused: `${target.agent} did not accept the task (HTTP ${res.status}).`,
        report: text || undefined,
      };
    }

    return { delivered: true, status: res.status, report: text || undefined };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      delivered: false,
      refused: aborted
        ? `${target.agent} did not answer within ${DISPATCH_TIMEOUT_MS / 1000} seconds.`
        : `${target.agent} could not be reached.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
