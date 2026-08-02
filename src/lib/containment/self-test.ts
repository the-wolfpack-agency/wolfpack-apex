/**
 * Prove the boundary before trusting it.
 *
 * This is the control the 2026 incidents argue for most directly. In both, the
 * environment was BELIEVED to be isolated: OpenAI's models escaped a sandbox
 * everyone thought was sealed, and Anthropic's evaluation prompt told Claude it
 * had no internet access while the environment actually had connectivity. The
 * models then reasoned that the real systems they found must be part of the
 * exercise.
 *
 * The lesson is not "sandbox harder". It is that a belief about isolation is
 * not a control. So before any agent batch runs, the boundary is exercised:
 * attempt a host that MUST be refused, and require the refusal. If the refusal
 * does not happen, or the probe cannot run at all, the batch does not start.
 *
 * Fails closed, and the distinction matters. A self-test that errors is not a
 * self-test that passed — that equivalence is exactly what let two labs run
 * evaluations against live infrastructure.
 *
 * Pure orchestration: the prober is injected, so every branch is tested without
 * a network.
 */
import { decideEgress, type EgressCapability } from "./allowlist";

/** What the probe observed when it tried to reach a host. */
export type ProbeOutcome = "refused" | "reached" | "error";

export interface SelfTestProbe {
  /** Attempt an outbound call. MUST NOT throw; report `error` instead. */
  (url: string, capability: EgressCapability): Promise<ProbeOutcome>;
}

export interface SelfTestResult {
  /** True only when every canary was refused AND every control host was reachable. */
  passed: boolean;
  /** One line for the log and the run record. */
  detail: string;
  checks: { url: string; expected: "refused" | "reached"; actual: ProbeOutcome; ok: boolean }[];
}

/**
 * Hosts that must be refused. Chosen to be harmless if a request does escape:
 * a documentation domain and a reserved-for-testing TLD, not someone's server.
 * The link-local address is the cloud metadata endpoint, which is the single
 * most valuable thing an escaped agent could reach.
 */
export const CANARY_HOSTS: readonly string[] = [
  "https://example.com/",
  "https://not-allowlisted.invalid/",
  "http://169.254.169.254/latest/meta-data/",
];

/**
 * Run the boundary check.
 *
 * Two halves, and both are required. The canaries prove the boundary REFUSES
 * what it should. The control host proves the boundary is not simply refusing
 * everything — a wrapper that has been misconfigured into blanket denial would
 * pass a refuse-only test and then fail every real call, so "it blocked
 * everything" must not read as "contained".
 */
export async function runContainmentSelfTest(
  probe: SelfTestProbe,
  opts: { controlUrl?: string; capability?: EgressCapability } = {},
): Promise<SelfTestResult> {
  const capability = opts.capability ?? "model-api";
  const controlUrl = opts.controlUrl ?? "https://api.anthropic.com/";
  const checks: SelfTestResult["checks"] = [];

  for (const url of CANARY_HOSTS) {
    // Sanity: the allowlist itself must consider these out of bounds. If a
    // canary is somehow allowlisted the test is meaningless, and silently
    // meaningless is the worst kind.
    const verdict = decideEgress(url, capability);
    if (verdict.allowed) {
      return {
        passed: false,
        detail: `canary ${url} is on the ${capability} allowlist, so this test proves nothing`,
        checks,
      };
    }
    let actual: ProbeOutcome;
    try {
      actual = await probe(url, capability);
    } catch {
      // A prober that throws is a broken prober, not a passing boundary.
      actual = "error";
    }
    checks.push({ url, expected: "refused", actual, ok: actual === "refused" });
  }

  // The control host must itself be allowlisted, or the "reached" leg proves
  // the opposite of what it claims: a boundary that lets through something NOT
  // on the list is leaking, and reading that as healthy would turn the broken
  // case into the passing one.
  const controlVerdict = decideEgress(controlUrl, capability);
  if (!controlVerdict.allowed) {
    return {
      passed: false,
      detail: `control host ${controlUrl} is not on the ${capability} allowlist, so reaching it would prove a leak rather than health`,
      checks,
    };
  }

  let controlOutcome: ProbeOutcome;
  try {
    controlOutcome = await probe(controlUrl, capability);
  } catch {
    controlOutcome = "error";
  }
  checks.push({ url: controlUrl, expected: "reached", actual: controlOutcome, ok: controlOutcome === "reached" });

  const escaped = checks.filter((c) => c.expected === "refused" && c.actual === "reached");
  const errored = checks.filter((c) => c.actual === "error");
  const blanket = checks.filter((c) => c.expected === "reached" && c.actual === "refused");

  if (escaped.length > 0) {
    return { passed: false, detail: `the boundary did NOT hold: reached ${escaped.map((c) => c.url).join(", ")}`, checks };
  }
  if (errored.length > 0) {
    return { passed: false, detail: `the boundary could not be demonstrated: ${errored.length} probe(s) errored`, checks };
  }
  if (blanket.length > 0) {
    return { passed: false, detail: "everything was refused, including a permitted host — the wrapper is misconfigured, not contained", checks };
  }
  return { passed: true, detail: `boundary demonstrated: ${CANARY_HOSTS.length} canaries refused, control host reachable`, checks };
}

/** The gate an agent batch calls. Returns the reason it may not start. */
export function mayStartBatch(selfTest: SelfTestResult | null): { ok: boolean; reason: string } {
  if (!selfTest) return { ok: false, reason: "no containment self-test was run, so isolation is assumed rather than demonstrated" };
  return selfTest.passed ? { ok: true, reason: selfTest.detail } : { ok: false, reason: selfTest.detail };
}
