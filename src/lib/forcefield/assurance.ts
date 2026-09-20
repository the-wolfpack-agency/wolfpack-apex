/**
 * Forcefield assurance - an honest, per-control protection posture. For each
 * control we claim, is it actually ACTIVE for THIS deployment, or a known GAP?
 * Deterministic and fail-loud: a claimed-but-dark control reads as a gap, never
 * as protection. This is the antidote to "the product says it protects while the
 * defaults leave it passive." Pure + client-safe: the route gathers the state,
 * this computes the verdict, the UI renders it.
 */
export type ControlStatus = "active" | "gap" | "partial";

export interface SecurityControl {
  id: string;
  /** What we claim. */
  title: string;
  status: ControlStatus;
  /** Honest, one-line state for this deployment. */
  detail: string;
}

/** The deployment state the report is computed from. Gathered server-side. */
export interface AssuranceInput {
  enforceMode: "monitor" | "enforce";
  autoBlockEnabled: boolean;
  delegationIssuers: number;
  asymmetricIssuers: number;
  decoysSeeded: number;
  reputationConsume: boolean;
  hybridTlsAsserted: boolean;
  externalAuditAnchor: boolean;
  ingestSourceSigned: boolean;
}

export interface AssuranceReport {
  controls: SecurityControl[];
  activeCount: number;
  partialCount: number;
  gapCount: number;
  total: number;
  /** 0-100, active counts full, partial counts half. Honest, not aspirational. */
  score: number;
}

export function buildAssuranceReport(input: AssuranceInput): AssuranceReport {
  const controls: SecurityControl[] = [
    {
      id: "detect.decoys",
      title: "Active deception (decoys / canaries)",
      status: input.decoysSeeded > 0 ? "active" : "gap",
      detail: input.decoysSeeded > 0 ? `${input.decoysSeeded} decoy(s) live - a proven-signal trap only a bot trips.` : "No decoys seeded; detection leans on inference until one is placed.",
    },
    {
      id: "verify.principal",
      title: "Know the Principal (verify the human + mandate)",
      status: input.delegationIssuers > 0 ? "active" : "gap",
      detail: input.delegationIssuers > 0 ? `${input.delegationIssuers} trusted issuer(s) registered; presented delegations are verified fail-closed.` : "No issuers registered; every delegation is treated as unverifiable (claimed).",
    },
    {
      id: "verify.replay",
      title: "Delegation replay defense (jti)",
      status: "active",
      detail: "Each credential is accepted once; a captured credential cannot be replayed.",
    },
    {
      id: "verify.asymmetric",
      title: "Asymmetric, no-shared-secret issuers (PQ on-ramp)",
      status: input.asymmetricIssuers > 0 ? "active" : "partial",
      detail: input.asymmetricIssuers > 0 ? `${input.asymmetricIssuers} issuer(s) use ES256 public keys (no shared secret to leak).` : "Capability shipped; no issuer has moved off shared HMAC secrets yet.",
    },
    {
      id: "enforce.inline",
      title: "Inline edge enforcement",
      status: input.enforceMode === "enforce" ? "active" : "gap",
      detail: input.enforceMode === "enforce" ? "The edge blocks/challenges in real time." : "Monitor (shadow) mode: decisions are recorded but nothing is blocked.",
    },
    {
      id: "enforce.auto_block",
      title: "Auto-block proven threats",
      status: input.autoBlockEnabled && input.enforceMode === "enforce" ? "active" : "gap",
      detail: input.autoBlockEnabled && input.enforceMode === "enforce" ? "Proven-hostile actors are blocked on sight; never on inference or a good agent." : "Off: proven-hostile actors are flagged, not auto-blocked.",
    },
    {
      id: "enforce.never_blinds",
      title: "Enforcement never blinds observation",
      status: "active",
      detail: "A blocked agent still records its behavior; protection never costs us the intel.",
    },
    {
      id: "network.reputation",
      title: "Cross-workspace reputation network",
      status: input.reputationConsume ? "active" : "gap",
      detail: input.reputationConsume ? "Consuming the network: an actor known-hostile elsewhere is flagged on sight." : "Not consuming the network (opt-in, off by default).",
    },
    {
      id: "audit.hash_chain",
      title: "Tamper-evident audit (hash chain)",
      status: "active",
      detail: "Security-relevant actions are recorded in an append-only, hash-chained ledger.",
    },
    {
      id: "audit.external_anchor",
      title: "External audit anchoring (transparency)",
      status: input.externalAuditAnchor ? "active" : "gap",
      detail: input.externalAuditAnchor ? "The chain head is published to an external witness; a DB compromise cannot rewrite history undetected." : "Not yet: the chain is DB-internal, so a DB-admin compromise is not externally detectable.",
    },
    {
      id: "ingest.source_signed",
      title: "Signed telemetry ingest (untrusted-forward)",
      status: input.ingestSourceSigned ? "active" : "gap",
      detail: input.ingestSourceSigned ? "Each forwarded batch is signed by a registered source key." : "Not yet: ingest is guarded by a shared token; a leak would let forged events in.",
    },
    {
      id: "crypto.pq_transport",
      title: "Post-quantum transport (hybrid TLS)",
      status: input.hybridTlsAsserted ? "active" : "gap",
      detail: input.hybridTlsAsserted ? "Hybrid X25519MLKEM768 asserted in CI; harvest-now-decrypt-later is mitigated on the wire." : "Hybrid TLS assertion not enabled for this deployment (set PROD_DOMAIN).",
    },
    {
      id: "crypto.pq_signatures",
      title: "Post-quantum signatures (ML-DSA)",
      status: "partial",
      detail: "Crypto-agility registry + reserved ML-DSA-65 slot; asymmetric ES256 live, PQ signing fails closed until implemented.",
    },
  ];

  const activeCount = controls.filter((c) => c.status === "active").length;
  const partialCount = controls.filter((c) => c.status === "partial").length;
  const gapCount = controls.filter((c) => c.status === "gap").length;
  const total = controls.length;
  const score = Math.round(((activeCount + partialCount * 0.5) / total) * 100);
  return { controls, activeCount, partialCount, gapCount, total, score };
}
