# Architecture standard: deterministic runtime, AI in the factory

Status: ADOPTED standard. Enforced by `src/__tests__/ai-decision-path-boundary.test.ts`
(build-failing). No em dashes.

## The principle

The software that runs in production is DETERMINISTIC and holds all authority. AI
(LLMs, ML) is a supplier of proposals and artifacts in the FACTORY (our build +
learning loop), never an actor in the runtime decision path. We keep AI OUTSIDE the
trust boundary of the deployed system and let a deterministic, audited layer decide
what, if anything, its output becomes.

This is one discipline with three payoffs:

1. **Safety.** AI cannot do harm if it has no authority. The worst a misbehaving or
   compromised model can do is PROPOSE something a deterministic gate + a human
   reject. We protect our users (and ourselves) from the AI by denying it the
   ability to act.
2. **Compliance reduction (real but earned).** A deterministic runtime makes no
   probabilistic decision about a person, so the AI-specific regimes (ISO/IEC 42001,
   EU AI Act high-risk, NIST AI RMF) largely do not bind the PRODUCT. The obligation
   shifts from "govern a runtime AI system" to "govern an SDLC that uses AI to
   produce artifacts", which is lighter, familiar, and evidence we already generate
   (gate + hash-chained audit). It does NOT go to zero: general SaaS security certs
   (SOC 2 / ISO 27001) still apply, and the reduction only holds while the boundary
   is actually enforced.
3. **Moat.** Anyone can call an LLM. The defensible asset is the curated, verified,
   deterministic artifact the LLM helped produce, plus the gate that keeps it honest.

## The boundary

- **Deterministic cores (decide; no model calls):** `src/lib/compliance`,
  `src/lib/readiness`, `src/lib/forcefield`, `src/lib/forcefield-web`,
  `src/lib/platform-scan`, `src/lib/ogiam`. The guardrail test forbids `getAIClient`
  / `getEmbeddingProvider` here.
- **The factory (AI lives here, offline):** generating/improving rulesets, control
  checks, crosswalks, code; analyzing data to propose changes. Output is reviewed,
  gated, versioned-with-provenance, and FROZEN into a deterministic artifact the
  cores then execute. Examples: the Code Factory / Secure Agent (LLM proposes code
  -> gate -> human), and the compliance/ruleset improvement loop.

Note: deterministic utilities that happen to live under `@/lib/ai` (e.g.
`@/lib/ai/redaction`, a pure regex redactor with no network call) are NOT model
calls and are allowed in cores. The forbidden signal is the MODEL CLIENT itself.

## The rules

1. **No model calls in a deterministic core.** Enforced by the build-failing
   guardrail. A core must not import `getAIClient` or `getEmbeddingProvider`.
2. **Every boundary crossing is gated + human-reviewed + provenance-stamped.** An
   AI-produced artifact passes the same deterministic gate + tests + a human
   approval, and records which model/run produced it, before it ships.
3. **Contain the AI side.** The factory runs with least privilege: no production
   secrets, egress limits, and a kill-switch, so a compromised model cannot act or
   exfiltrate.
4. **Runtime advisory AI is the rare, explicit exception.** If a probabilistic
   output must appear at runtime, it is advisory, non-authoritative, off by default,
   degrades to a typed non-answer, and is listed in the guardrail's allowlist with a
   reason. The deterministic layer still makes the decision.

## The test that classifies each product

Ask: does any probabilistic output reach a person or a consequential decision
WITHOUT a deterministic + human checkpoint?

- No  -> the AI is contained; the product is deterministic; the AI regimes mostly
  fall away.
- Yes -> it is an AI system in scope, regardless of an "advisory" label. Regulators
  judge the reality, not the label.

## Per-product mapping (current)

- **Compliance & Assurance, Readiness, Scan/Pentest, OGIAM gate:** pure
  deterministic runtime. AI only in the factory (drafting checks/rules, analyzing
  evidence). No runtime model calls.
- **Forcefield:** deterministic detection + enforcement core. One allowlisted
  advisory touchpoint (`forcefield-web/signup-risk-summary.ts`): an operator aid,
  off by default, never in the enforcement path.
- **Secure Agent / Code Factory:** the factory itself. The LLM proposes code; the
  deterministic gate decides; a human approves. Nothing it writes goes live
  unverified.

## Honest limits

- A frozen ML model artifact at temperature 0 is reproducible, but it is still ML
  in the product (a different, heavier posture than "pure deterministic rules the AI
  wrote offline"). State which flavor a product is; prefer the latter for the cores.
- The factory still has data obligations (training-data provenance, IP, privacy of
  what it processes). Those are SDLC/data-governance concerns, not runtime ones.
- "Fully deterministic" is a boundary we MAINTAIN, not a state reached once. Rule 1's
  guardrail is what keeps it real.
