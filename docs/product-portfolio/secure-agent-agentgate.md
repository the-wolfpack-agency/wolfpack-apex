# Secure Agent / AgentGate (DRAFT, internal, strategy)

## What it is
Deterministic, model-agnostic governance of AI-generated code: a gate that reviews
a diff (secrets, disabled TLS, injection, eval, sql-concat), an independent-family
judge that confirms findings, a bounded repair loop, and a PR handoff that never
auto-merges. Governs ANY GitHub PR via a webhook. Named in `src/lib/products.ts`
(Secure Agent); the GitHub App is "AgentGate AI".

## Who buys it
Teams shipping AI-written code (Copilot, Cursor, agents) who need a deterministic
safety gate on every PR, and who want "models propose, policy decides."

## What we ALREADY have
- `src/lib/ai-code/` - `detect.ts` + `gate.ts` (decide block/escalate/allow),
  `judge.ts` (independent-lineage confirmation), `repair.ts` (gated rewrite loop),
  `pipeline.ts` (intake -> gate -> repair), conformance, and the PR-handoff route.
- Webhook PR-gating design + the "AgentGate AI" GitHub App identity.
- The adversarial corpus test proving accept-good / reject-bad.

## Product surface to add
- The GitHub App live + installed (the main blocker; a bot policy-approver tail
  exists but is dark until the App is on).
- A findings + decision dashboard per repo; billing per repo/seat.
- A correctness gate (today it governs security, not compile/test-run) - noted as
  the known gap that keeps good-but-broken code from being called ready.

## Honest gap to market
The gate/judge/repair chain is merged and tested; the two gaps are the live GitHub
App and a correctness gate. ~65%.

## Positioning + pricing hook
"A deterministic reviewer on every AI-written PR: it blocks the dangerous classes,
confirms with a second independent model, and never merges itself." Priced per repo
or per seat.
