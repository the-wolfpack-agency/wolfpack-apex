/**
 * Forcefield assurance - an evidence-backed, per-control protection posture.
 *
 * The rule: a control reads "active" ONLY when there is evidence that it
 * EXECUTED inside its freshness window - an event row, a check run, or a sample
 * run through the real code in this request. Configuration (a policy row, an
 * opt-in flag, an env var) is never evidence on its own. No evidence in the
 * window reads "gap"; a query that failed reads "unknown"; neither is ever
 * "active". There are no hard-coded statuses in this file.
 *
 * Pure + client-safe: the route gathers the evidence (assurance-evidence.ts),
 * this computes the verdict, the UI renders it with the evidence it rests on.
 */
import { describeProbe, type EvidenceProbe } from "@/lib/compliance/evidence-window";

export type ControlStatus = "active" | "partial" | "gap" | "unknown";

export interface SecurityControl {
  id: string;
  /** What we claim. */
  title: string;
  status: ControlStatus;
  /** Honest, one-line state for this deployment. */
  detail: string;
  /** The evidence the status was computed from (named, windowed). */
  evidence: EvidenceProbe[];
  /** When not fully active, how to close the gap (the self-service checklist). */
  enablement?: string;
}

/** Evidence keys the assurance report reads. Each names a query in
 *  assurance-evidence.ts; the posture parity check references the same keys. */
export const ASSURANCE_EVIDENCE_KEYS = [
  "ff.inline_block",
  "ff.trap_tripped",
  "ff.hostile_events",
  "ff.alert_dispatched",
  "ff.autoblock_fired",
  "ff.delegation_verified",
  "ff.reputation_signal",
  "ff.agent_dispatch",
  "audit.chain_verified",
  "audit.external_anchor",
] as const;
export type AssuranceEvidenceKey = (typeof ASSURANCE_EVIDENCE_KEYS)[number];

/** Result of driving the live caller's action shape through the real tripwire
 *  against the workspace's ACTIVE canaries. null = the canaries could not be read. */
export interface TripwireSelfTest {
  /** Active canaries the live caller (the assistant dispatcher) can carry. */
  reachable: number;
  /** Of those, how many the real inspectAgentAction tripped. */
  tripped: number;
  /** Active canary kinds the live caller can never reach (never sends url/rowIds,
   *  and resolves the tool name against the registry before the tripwire runs). */
  unreachableKinds: string[];
}

/** The deployment state the report is computed from. Gathered server-side. */
export interface AssuranceInput {
  /** The Forcefield site key this deployment records under (middleware). */
  site: string;
  /** Config, shown for context only - never sufficient for "active". */
  enforceMode: "monitor" | "enforce";
  autoBlockEnabled: boolean;
  /** null = could not be read. */
  delegationIssuers: number | null;
  asymmetricIssuers: number | null;
  reputationConsume: boolean | null;
  ingestSigningEnforced: boolean;
  ingestSources: number | null;
  /** PROD_DOMAIN is set, so the CI hybrid-TLS assertion runs. */
  hybridTlsAssertedInCi: boolean;
  /** From the PQ crypto inventory. */
  pqQuantumVulnerable: number;
  pqSlotImplemented: boolean;
  /** Windowed evidence, keyed. A missing key is treated as an error probe. */
  probes: Partial<Record<AssuranceEvidenceKey, EvidenceProbe>>;
  /** Sample runs through the real defenses in this request. null = not run. */
  samples: {
    /** The adversarial "replay" scenario was defended. */
    replay: boolean | null;
    /** The adversarial "injection-as-data" scenario was defended. */
    injectionAsData: boolean | null;
    tripwire: TripwireSelfTest | null;
  };
}

export interface AssuranceReport {
  controls: SecurityControl[];
  activeCount: number;
  partialCount: number;
  gapCount: number;
  unknownCount: number;
  total: number;
  /** 0-100: active counts full, partial half, gap and unknown zero. */
  score: number;
  /** When the evidence was read. */
  measuredAt: string;
}

const missing = (key: string): EvidenceProbe => ({
  key, proof: "not collected", windowDays: 0, count: 0, lastAt: null, state: "error", error: "evidence not collected",
});

function sample(key: string, proof: string, passed: boolean | null, nowIso: string): EvidenceProbe {
  if (passed === null) return { key, proof, windowDays: 0, count: 0, lastAt: null, state: "error", error: "sample not run" };
  return { key, proof, windowDays: 0, count: passed ? 1 : 0, lastAt: passed ? nowIso : null, state: passed ? "fresh" : "none" };
}

/** fresh -> active, error -> unknown, anything else -> gap. The one mapping. */
function fromProbe(p: EvidenceProbe): ControlStatus {
  return p.state === "fresh" ? "active" : p.state === "error" ? "unknown" : "gap";
}

/** Combine probes that must ALL hold: any error -> unknown, any non-fresh -> gap. */
function allOf(...ps: EvidenceProbe[]): ControlStatus {
  if (ps.some((p) => p.state === "error")) return "unknown";
  return ps.every((p) => p.state === "fresh") ? "active" : "gap";
}

export function buildAssuranceReport(input: AssuranceInput, now: Date = new Date()): AssuranceReport {
  const nowIso = now.toISOString();
  const p = (k: AssuranceEvidenceKey): EvidenceProbe => input.probes[k] ?? missing(k);
  const site = input.site;

  const block = p("ff.inline_block");
  const trap = p("ff.trap_tripped");
  const hostile = p("ff.hostile_events");
  const alerted = p("ff.alert_dispatched");
  const autoFired = p("ff.autoblock_fired");
  const delegated = p("ff.delegation_verified");
  const repSignal = p("ff.reputation_signal");
  const dispatch = p("ff.agent_dispatch");
  const chain = p("audit.chain_verified");
  const anchor = p("audit.external_anchor");

  const replaySample = sample("sample.replay", "adversarial 'replay' scenario through verifyPresentedDelegation", input.samples.replay, nowIso);
  const injectionSample = sample("sample.injection_as_data", "adversarial 'injection-as-data' scenario through classifySession", input.samples.injectionAsData, nowIso);

  const tw = input.samples.tripwire;
  const tripwireSample: EvidenceProbe =
    tw === null
      ? { key: "sample.tripwire", proof: "live-caller action shape through inspectAgentAction against active canaries", windowDays: 0, count: 0, lastAt: null, state: "error", error: "canaries could not be read" }
      : { key: "sample.tripwire", proof: "live-caller action shape through inspectAgentAction against active canaries", windowDays: 0, count: tw.tripped, lastAt: tw.reachable > 0 && tw.tripped === tw.reachable ? nowIso : null, state: tw.reachable > 0 && tw.tripped === tw.reachable ? "fresh" : "none" };

  const controls: SecurityControl[] = [];
  const add = (c: SecurityControl) => controls.push(c);

  // -- Inline enforcement: proven by real blocks on this site, nothing else.
  {
    const status = fromProbe(block);
    add({
      id: "enforce.inline",
      title: "Inline edge enforcement",
      status,
      evidence: [block],
      detail:
        status === "active"
          ? `The edge blocked requests on ${site}: ${describeProbe(block)}.`
          : status === "unknown"
            ? `Block evidence could not be read: ${describeProbe(block)}.`
            : `No request was blocked on ${site} (${describeProbe(block)}). Policy mode is ${input.enforceMode}; a mode setting is not proof of a block.`,
    });
  }

  // -- Auto-block: proven by auto-block events; the policy toggle is context.
  {
    let status = fromProbe(autoFired);
    const policyOn = input.autoBlockEnabled && input.enforceMode === "enforce";
    if (status === "active" && !policyOn) status = "partial";
    add({
      id: "enforce.auto_block",
      title: "Auto-block proven threats",
      status,
      evidence: [autoFired],
      detail:
        status === "active"
          ? `Auto-block fired: ${describeProbe(autoFired)}.`
          : status === "partial"
            ? `Auto-block events fired (${describeProbe(autoFired)}) although the edge policy has auto-block ${input.autoBlockEnabled ? "on" : "off"} in ${input.enforceMode} mode, so the policy toggle does not govern it.`
            : status === "unknown"
              ? `Auto-block evidence could not be read: ${describeProbe(autoFired)}.`
              : `No auto-block fired (${describeProbe(autoFired)}).`,
    });
  }

  // -- Enforcement never blinds observation: a recorded block is the proof.
  {
    const status = fromProbe(block);
    add({
      id: "enforce.never_blinds",
      title: "Enforcement never blinds observation",
      status,
      evidence: [block],
      detail:
        status === "active"
          ? `Blocked requests were still recorded with their behavior (${describeProbe(block)}).`
          : status === "unknown"
            ? `Could not be measured: ${describeProbe(block)}.`
            : "Nothing was blocked in the window, so there is no recorded block to prove this.",
    });
  }

  // -- Web decoy traps: proven by trap trips on this site.
  {
    const status = fromProbe(trap);
    add({
      id: "detect.decoys",
      title: "Web decoy traps",
      status,
      evidence: [trap],
      detail:
        status === "active"
          ? `Decoy traps tripped on ${site}: ${describeProbe(trap)}.`
          : status === "unknown"
            ? `Could not be measured: ${describeProbe(trap)}.`
            : `No decoy trap tripped on ${site} (${describeProbe(trap)}).`,
    });
  }

  // -- Agent tripwire: self-test pass through the real code AND the guard ran.
  {
    let status: ControlStatus;
    let detail: string;
    if (tw === null || dispatch.state === "error") {
      status = "unknown";
      detail = tw === null ? "The canary registry could not be read." : `Agent-dispatch evidence could not be read: ${describeProbe(dispatch)}.`;
    } else if (tw.reachable === 0) {
      status = "gap";
      detail = `No active canary is reachable by the live caller${tw.unreachableKinds.length ? ` (unreachable kinds: ${tw.unreachableKinds.join(", ")})` : ""}.`;
    } else if (tw.tripped < tw.reachable) {
      status = "gap";
      detail = `Self-test FAILED: ${tw.tripped} of ${tw.reachable} reachable canaries tripped.`;
    } else if (dispatch.state !== "fresh") {
      status = "gap";
      detail = `Self-test passed (${tw.tripped}/${tw.reachable}), but no agent action reached the guard (${describeProbe(dispatch)}), so it is armed, not running.`;
    } else {
      status = "active";
      detail = `Self-test passed (${tw.tripped}/${tw.reachable}) and agent actions passed the guard: ${describeProbe(dispatch)}.${tw.unreachableKinds.length ? ` Unreachable kinds: ${tw.unreachableKinds.join(", ")}.` : ""}`;
    }
    add({ id: "detect.tripwire", title: "Agent tripwire (canaries)", status, evidence: [tripwireSample, dispatch], detail });
  }

  // -- Alerts reach a person: a dispatch whenever hostile events exist.
  {
    let status: ControlStatus;
    let detail: string;
    if (hostile.state === "error" || alerted.state === "error") {
      status = "unknown";
      detail = "Hostile-event or alert evidence could not be read.";
    } else if (hostile.state !== "fresh") {
      status = "gap";
      detail = `No hostile events in the window (${describeProbe(hostile)}), so alerting has not been exercised.`;
    } else if (alerted.state === "fresh") {
      status = "active";
      detail = `Hostile events (${describeProbe(hostile)}) produced alerts: ${describeProbe(alerted)}.`;
    } else {
      status = "gap";
      detail = `Hostile events occurred (${describeProbe(hostile)}) but no alert was dispatched (${describeProbe(alerted)}).`;
    }
    add({ id: "alerts.dispatch", title: "Security alerts dispatched", status, evidence: [hostile, alerted], detail });
  }

  // -- Know the Principal: proven by verified delegations (consumed jti rows).
  {
    const status = input.delegationIssuers === null ? "unknown" : fromProbe(delegated);
    add({
      id: "verify.principal",
      title: "Know the Principal (verify the human + mandate)",
      status,
      evidence: [delegated],
      detail:
        status === "active"
          ? `Delegations were verified: ${describeProbe(delegated)}.`
          : status === "unknown"
            ? "Issuer or verification evidence could not be read."
            : `${input.delegationIssuers ?? 0} issuer(s) registered; no delegation was verified (${describeProbe(delegated)}).`,
    });
  }

  // -- Replay defense: the sample passes AND the live replay store ran.
  {
    const status = allOf(replaySample, delegated);
    add({
      id: "verify.replay",
      title: "Delegation replay defense (jti)",
      status,
      evidence: [replaySample, delegated],
      detail:
        status === "active"
          ? `Replay self-test passed and the live replay store recorded credentials: ${describeProbe(delegated)}.`
          : status === "unknown"
            ? "The replay self-test or the replay store could not be read."
            : replaySample.state !== "fresh"
              ? "Replay self-test FAILED: a captured credential was accepted twice."
              : `The replay logic passes its self-test, but no delegation was presented (${describeProbe(delegated)}), so the live check has not run.`,
    });
  }

  // -- Asymmetric issuers: registered AND exercised.
  {
    let status: ControlStatus;
    if (input.asymmetricIssuers === null || delegated.state === "error") status = "unknown";
    else status = input.asymmetricIssuers > 0 && delegated.state === "fresh" ? "active" : "gap";
    add({
      id: "verify.asymmetric",
      title: "Asymmetric, no-shared-secret issuers (PQ on-ramp)",
      status,
      evidence: [delegated],
      detail:
        status === "active"
          ? `${input.asymmetricIssuers} ES256 issuer(s) registered and delegations were verified.`
          : status === "unknown"
            ? "Issuer evidence could not be read."
            : `${input.asymmetricIssuers ?? 0} ES256 issuer(s) registered; ${delegated.state === "fresh" ? "verifications exist but none from an ES256 issuer is provable" : "no delegation was verified in the window"}.`,
    });
  }

  // -- Deterministic gate: a sample through the real classifier, this request.
  {
    const status = fromProbe(injectionSample);
    add({
      id: "defense.deterministic_gate",
      title: "Deterministic gate (no prompt-injection surface)",
      status,
      evidence: [injectionSample],
      detail:
        status === "active"
          ? "A request path carrying prompt-injection text was classified identically to a clean one in this request (injected text is inert data)."
          : status === "unknown"
            ? "The injection self-test did not run."
            : "Self-test FAILED: injected text changed the classification.",
    });
  }

  // -- Reputation network: opted in AND the network carries signal.
  {
    let status: ControlStatus;
    if (input.reputationConsume === null || repSignal.state === "error") status = "unknown";
    else status = input.reputationConsume && repSignal.state === "fresh" ? "active" : "gap";
    add({
      id: "network.reputation",
      title: "Cross-workspace reputation network",
      status,
      evidence: [repSignal],
      detail:
        status === "active"
          ? `Consuming the network, which carries signal: ${describeProbe(repSignal)}.`
          : status === "unknown"
            ? "Opt-in or reputation evidence could not be read."
            : input.reputationConsume
              ? `Opted in, but the network carries no signal (${describeProbe(repSignal)}).`
              : "Not consuming the network (opt-in, off).",
    });
  }

  // -- Hash chain: a passing verification run inside the window.
  {
    const status = fromProbe(chain);
    add({
      id: "audit.hash_chain",
      title: "Tamper-evident audit (hash chain)",
      status,
      evidence: [chain],
      detail:
        status === "active"
          ? `The audit hash chain verified intact: ${describeProbe(chain)}.`
          : status === "unknown"
            ? `Could not be measured: ${describeProbe(chain)}.`
            : `No passing chain verification (${describeProbe(chain)}).`,
    });
  }

  // -- External anchoring: an anchor published inside the window.
  {
    const status = fromProbe(anchor);
    add({
      id: "audit.external_anchor",
      title: "External audit anchoring (transparency)",
      status,
      evidence: [anchor],
      detail:
        status === "active"
          ? `The chain head was published externally: ${describeProbe(anchor)}.`
          : status === "unknown"
            ? `Could not be measured: ${describeProbe(anchor)}.`
            : `No external anchor published (${describeProbe(anchor)}); a DB-admin compromise is not externally detectable.`,
    });
  }

  // -- Signed ingest: no execution record exists, so it can never read active.
  {
    const status: ControlStatus = input.ingestSources === null ? "unknown" : "gap";
    add({
      id: "ingest.source_signed",
      title: "Signed telemetry ingest (untrusted-forward)",
      status,
      evidence: [],
      detail:
        status === "unknown"
          ? "Ingest sources could not be read."
          : input.ingestSigningEnforced && (input.ingestSources ?? 0) > 0
            ? `Signing is enforced with ${input.ingestSources} source key(s), but accepted signed batches are not recorded, so execution is unproven.`
            : "Not enforced: ingest is guarded by a shared token.",
    });
  }

  // -- PQ transport: CI asserts it; this runtime cannot measure the TLS group.
  {
    const status: ControlStatus = input.hybridTlsAssertedInCi ? "partial" : "unknown";
    add({
      id: "crypto.pq_transport",
      title: "Post-quantum transport (hybrid TLS)",
      status,
      evidence: [],
      detail: input.hybridTlsAssertedInCi
        ? "X25519MLKEM768 is asserted by the CI handshake check against PROD_DOMAIN; the running app cannot observe the negotiated group per request."
        : "Not measured by this deployment: the CI handshake check needs PROD_DOMAIN.",
    });
  }

  // -- PQ signatures: a reserved slot is not a running control.
  {
    const status: ControlStatus = input.pqSlotImplemented ? "partial" : "gap";
    add({
      id: "crypto.pq_signatures",
      title: "Post-quantum signatures (ML-DSA)",
      status,
      evidence: [],
      detail: input.pqSlotImplemented
        ? "ML-DSA-65 is implemented; no signed record proves it is in use yet."
        : `Not running: the ML-DSA-65 slot is reserved and fails closed. ${input.pqQuantumVulnerable} asymmetric algorithm(s) are migration targets. Quantum-migration-ready, not quantum-safe.`,
    });
  }

  const ENABLEMENT: Record<string, string> = {
    "enforce.inline": "Turn protection on (enforce) with the Forcefield hero switch, then confirm blocks appear on the board.",
    "enforce.auto_block": "Enable 'Auto-block proven threats' on the Forcefield hero (enforce must be on).",
    "enforce.never_blinds": "Proven once the edge blocks a request and the board shows its recorded behavior.",
    "detect.decoys": "Confirm the decoy trap paths are served by the edge for this site.",
    "detect.tripwire": "Seed a token canary into data an agent reads (route, row and tool canaries are not reachable by the live caller today).",
    "alerts.dispatch": "Check the web-alert cron and its recipients; hostile events must produce a dispatched alert.",
    "verify.principal": "Register your agent fleet's delegation issuer (Admin -> Forcefield -> delegation issuers) and have agents present delegations.",
    "verify.replay": "Proven once a delegation is presented and its jti is recorded.",
    "verify.asymmetric": "Register an issuer with an ES256 public key instead of a shared secret.",
    "network.reputation": "Opt in to consume the reputation network from the operator view.",
    "audit.hash_chain": "Check the hourly audit-chain verification job.",
    "audit.external_anchor": "Set FORCEFIELD_AUDIT_ANCHOR_URL, then publish the chain head on a schedule.",
    "ingest.source_signed": "Set SITE_ANALYTICS_INGEST_SIGNING=on, register a source key, and record accepted signed batches.",
    "crypto.pq_transport": "Set PROD_DOMAIN so CI asserts the hybrid-TLS handshake.",
    "crypto.pq_signatures": "Implement the ML-DSA-65 slot when a compliant FIPS-204 library lands, then dual-sign the audit head.",
  };
  for (const c of controls) {
    if (c.status !== "active" && ENABLEMENT[c.id]) c.enablement = ENABLEMENT[c.id];
  }

  const count = (s: ControlStatus) => controls.filter((c) => c.status === s).length;
  const activeCount = count("active");
  const partialCount = count("partial");
  const gapCount = count("gap");
  const unknownCount = count("unknown");
  const total = controls.length;
  const score = total === 0 ? 0 : Math.round(((activeCount + partialCount * 0.5) / total) * 100);
  return { controls, activeCount, partialCount, gapCount, unknownCount, total, score, measuredAt: nowIso };
}
