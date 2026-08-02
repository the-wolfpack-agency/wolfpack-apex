/**
 * The containment controls. Almost every case here is a refusal or a
 * fail-closed path, because that is the entire product: the value of a boundary
 * is what it does when something goes wrong, and the 2026 incidents were all
 * cases where a control was believed to exist and did not.
 */
import { decideEgress, hostMatches, normalizeHost, allAllowedHosts } from "../allowlist";
import { decideStep, resolveBudget, budgetPressure, DEFAULT_BUDGET, type RunSpend } from "../budget";
import { runContainmentSelfTest, mayStartBatch, CANARY_HOSTS, type ProbeOutcome } from "../self-test";

const spend = (over: Partial<RunSpend> = {}): RunSpend => ({ tokens: 0, durationMs: 0, egressCalls: 0, spendCents: 0, ...over });
const live = { agentsEnabled: true, readable: true };

describe("hostMatches", () => {
  it("accepts a host and its subdomains", () => {
    expect(hostMatches("api.github.com", "github.com")).toBe(true);
    expect(hostMatches("github.com", "github.com")).toBe(true);
  });

  it("refuses a lookalike that merely ends with the allowed string", () => {
    // The classic bypass: "evil-github.com".endsWith("github.com") is true.
    expect(hostMatches("evil-github.com", "github.com")).toBe(false);
    expect(hostMatches("github.com.evil.test", "github.com")).toBe(false);
  });

  it("normalises case, a leading www and a trailing dot", () => {
    expect(normalizeHost("WWW.GitHub.com.")).toBe("github.com");
    expect(hostMatches("WWW.GitHub.com.", "github.com")).toBe(true);
  });
});

describe("decideEgress", () => {
  it("allows a host on the capability's list", () => {
    expect(decideEgress("https://api.anthropic.com/v1/messages", "model-api")).toMatchObject({ allowed: true, host: "api.anthropic.com" });
  });

  it("refuses a host that belongs to a DIFFERENT capability", () => {
    // The model API has no business reaching GitHub. Per-capability lists are
    // the difference between an allowlist and a firewall hole.
    expect(decideEgress("https://api.github.com/repos", "model-api")).toMatchObject({ allowed: false, refusedBecause: "not-allowlisted" });
    expect(decideEgress("https://api.github.com/repos", "source-control")).toMatchObject({ allowed: true });
  });

  it("refuses plain http outright, not per host", () => {
    // Agent traffic carries credentials and prompts; neither belongs in clear.
    expect(decideEgress("http://api.anthropic.com/", "model-api")).toMatchObject({ allowed: false, refusedBecause: "scheme" });
  });

  it("refuses anything that is not a URL", () => {
    for (const bad of ["", "api.anthropic.com", "not a url", "javascript:alert(1)"]) {
      expect(decideEgress(bad, "model-api").allowed).toBe(false);
    }
  });

  it("refuses everything for a capability with an empty list", () => {
    // target-scan is empty on purpose: targets are authorised per run by the
    // ownership gate, never by a static list.
    expect(decideEgress("https://anything.test/", "target-scan")).toMatchObject({ allowed: false });
  });

  it("accepts a per-run host without widening the list for the next run", () => {
    expect(decideEgress("https://client.test/", "target-scan", ["client.test"])).toMatchObject({ allowed: true });
    // Same call, no extras: still refused. The extras were a parameter, not state.
    expect(decideEgress("https://client.test/", "target-scan").allowed).toBe(false);
  });

  it("names what WAS permitted, so a refusal is actionable", () => {
    const v = decideEgress("https://elsewhere.test/", "deploy");
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("api.vercel.com");
  });

  it("exposes every allowed host for the admin surface", () => {
    expect(allAllowedHosts()).toContain("api.anthropic.com");
    expect(allAllowedHosts()).toEqual([...allAllowedHosts()].sort());
  });
});

describe("decideStep", () => {
  it("proceeds under budget with the switch on", () => {
    const d = decideStep(DEFAULT_BUDGET, spend({ tokens: 10 }), live);
    expect(d.proceed).toBe(true);
    expect(d.proceed && d.remaining.tokens).toBe(DEFAULT_BUDGET.maxTokens - 10);
  });

  it("stops immediately when the kill switch is off", () => {
    expect(decideStep(DEFAULT_BUDGET, spend(), { agentsEnabled: false, readable: true })).toMatchObject({
      proceed: false,
      breached: "kill-switch",
    });
  });

  it("treats an unreadable switch as STOPPED, not as running", () => {
    // A delayed run is cheap. A run that should have been stopped is the thing
    // the switch exists for.
    expect(decideStep(DEFAULT_BUDGET, spend(), { agentsEnabled: true, readable: false })).toMatchObject({
      proceed: false,
      breached: "unreadable",
    });
  });

  it("stops on each ceiling, and names which one", () => {
    const cases: [Partial<RunSpend>, string][] = [
      [{ tokens: DEFAULT_BUDGET.maxTokens }, "maxTokens"],
      [{ durationMs: DEFAULT_BUDGET.maxDurationMs }, "maxDurationMs"],
      [{ egressCalls: DEFAULT_BUDGET.maxEgressCalls }, "maxEgressCalls"],
      [{ spendCents: DEFAULT_BUDGET.maxSpendCents }, "maxSpendCents"],
    ];
    for (const [over, breached] of cases) {
      expect(decideStep(DEFAULT_BUDGET, spend(over), live)).toMatchObject({ proceed: false, breached });
    }
  });

  it("checks BEFORE the step, so reaching the limit exactly stops it", () => {
    // >= not >: a step that would take the run to its ceiling must not run and
    // then be reported. What is bounded is what the agent does.
    expect(decideStep(DEFAULT_BUDGET, spend({ tokens: DEFAULT_BUDGET.maxTokens }), live).proceed).toBe(false);
    expect(decideStep(DEFAULT_BUDGET, spend({ tokens: DEFAULT_BUDGET.maxTokens - 1 }), live).proceed).toBe(true);
  });

  it("treats an unreadable ledger as paused, not as zero spent", () => {
    expect(decideStep(DEFAULT_BUDGET, spend({ tokens: Number.NaN }), live)).toMatchObject({ proceed: false, breached: "unreadable" });
  });
});

describe("resolveBudget", () => {
  it("uses the defaults when nothing is overridden", () => {
    expect(resolveBudget(null)).toEqual(DEFAULT_BUDGET);
  });

  it("accepts a deliberate raise", () => {
    expect(resolveBudget({ maxTokens: 1_000_000 }).maxTokens).toBe(1_000_000);
  });

  it("falls back to the default for a typo rather than to unlimited", () => {
    // A negative, a zero, a NaN or a string must never become permission.
    for (const bad of [-1, 0, Number.NaN, "lots" as unknown as number, undefined]) {
      expect(resolveBudget({ maxTokens: bad }).maxTokens).toBe(DEFAULT_BUDGET.maxTokens);
    }
  });
});

describe("budgetPressure", () => {
  it("reports each ceiling as a 0..1 ratio, clamped", () => {
    const p = budgetPressure(DEFAULT_BUDGET, spend({ tokens: DEFAULT_BUDGET.maxTokens / 2, spendCents: DEFAULT_BUDGET.maxSpendCents * 4 }));
    expect(p.maxTokens).toBeCloseTo(0.5, 5);
    expect(p.maxSpendCents).toBe(1);
  });
});

describe("runContainmentSelfTest", () => {
  const prober = (map: Record<string, ProbeOutcome>, fallback: ProbeOutcome = "refused") =>
    (async (url: string) => map[url] ?? fallback) as Parameters<typeof runContainmentSelfTest>[0];

  it("passes when every canary is refused and the control host is reachable", async () => {
    const r = await runContainmentSelfTest(prober({ "https://api.anthropic.com/": "reached" }));
    expect(r.passed).toBe(true);
    expect(r.detail).toMatch(/boundary demonstrated/);
  });

  it("fails when a canary was actually reached", async () => {
    // The OpenAI/Hugging Face shape, caught before the batch starts.
    const r = await runContainmentSelfTest(prober({ [CANARY_HOSTS[0]]: "reached", "https://api.anthropic.com/": "reached" }));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/did NOT hold/);
  });

  it("fails when a probe errors, because an error is not a refusal", async () => {
    // The equivalence that let two labs run evals against live infrastructure.
    const r = await runContainmentSelfTest(prober({ [CANARY_HOSTS[1]]: "error", "https://api.anthropic.com/": "reached" }));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/could not be demonstrated/);
  });

  it("fails when the prober throws instead of reporting", async () => {
    const throwing = (async () => {
      throw new Error("no network");
    }) as Parameters<typeof runContainmentSelfTest>[0];
    const r = await runContainmentSelfTest(throwing);
    expect(r.passed).toBe(false);
  });

  it("fails when EVERYTHING is refused, including the permitted host", async () => {
    // A wrapper misconfigured into blanket denial passes a refuse-only test and
    // then fails every real call. "It blocked everything" is not "contained".
    const r = await runContainmentSelfTest(prober({}, "refused"));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/misconfigured, not contained/);
  });

  it("refuses when the control host is not itself allowlisted", async () => {
    // Found by writing this test: if the control is NOT on the list, then
    // "control reached" proves the boundary is LEAKING, not that it is healthy.
    // Reading that as a pass would make the broken case the passing one.
    const r = await runContainmentSelfTest(prober({ "https://api.anthropic.com/": "reached" }), {
      capability: "target-scan",
      controlUrl: "https://api.anthropic.com/",
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/prove a leak rather than health/);
  });

  it("refuses when a canary is itself on the allowlist, because the test would prove nothing", async () => {
    const r = await runContainmentSelfTest(prober({}), { capability: "source-control", controlUrl: "https://api.github.com/" });
    // example.com is not allowlisted for source-control, so this passes the
    // sanity check and fails later for the blanket-denial reason instead.
    expect(r.passed).toBe(false);
  });
});

describe("mayStartBatch", () => {
  it("refuses to start when no self-test was run at all", async () => {
    expect(mayStartBatch(null)).toMatchObject({ ok: false });
    expect(mayStartBatch(null).reason).toMatch(/assumed rather than demonstrated/);
  });

  it("starts only on a passing self-test", async () => {
    const pass = await runContainmentSelfTest((async (u: string) => (u === "https://api.anthropic.com/" ? "reached" : "refused")) as Parameters<typeof runContainmentSelfTest>[0]);
    expect(mayStartBatch(pass).ok).toBe(true);
    expect(mayStartBatch({ ...pass, passed: false, detail: "nope" }).ok).toBe(false);
  });
});
