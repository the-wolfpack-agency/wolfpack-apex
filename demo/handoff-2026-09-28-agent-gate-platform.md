# Handoff — Agent Gate platform (2026-09-28)

## What this is
A governed, model-agnostic, transparent **Agent Gate** platform in `wolfpack-apex`
(product: Wolfpack Instinct) — our TypeScript successor to AgenticQA. A *gate* is
one narrow, deterministic checkpoint: `input -> verdict -> out`, with an optional
model call *only when the gate needs it*. Enforcement lives in the gate, not the
model, so it's model-agnostic. Gates are individually deployable and chainable.

**Thesis (validated this build):** "any client use of AI goes through a gate" is
the product; code review is just the first app on it. The #1 AI-adoption blocker
(data leaking to an LLM) is answered by construction.

## The four verdicts
`allow` (advance) · `auto_fix` (self-heal, then re-check) · `require_human` (the
only intended stop for a passing flow) · `deny` (hard, deterministic). `AUTO_FIX`
is what makes it an autonomous relay, not just a checkpoint.

## Core files
- `src/lib/gates/types.ts` — the contract (verdicts, CompliancePolicy, transparency).
- `src/lib/gates/run-gate.ts` — the framework wrapper: enforces the client's data
  policy (a gate physically cannot send data a policy forbids), a DEFAULT
  secret/PII scrub before ANY model call (even `full`), stamps frameworks + audit.
- `src/lib/gates/registry.ts` — one-line gate registration; `getGate`/`listGates`.
- `src/app/api/gate/[gate]/route.ts` — the deployable endpoint. Records every
  decision to the OGIAM hash-chained ledger (`recordGateDecision`) + emits
  `ai_gate.decision` for the /admin/ai-code safety panel.
- `src/lib/gates/chain.ts` + `factory-chain.ts` — the chain runner (advance on
  allow, self-heal on auto_fix, stop only at a human/deny).

## The gate catalog (10)
| Gate | Guards |
|---|---|
| safe-review | secrets/injection/unsafe patterns/invariants (+ test-fixture allowlist) |
| ci-autofix | red CI — auto-fix (subtype-aware) or escalate; the AUTO_FIX engine |
| deploy-health | broken deploy -> auto-revert a factory branch (never forces prod) |
| preview-verify | a green PR's preview actually serves the full treatment |
| prod-promote | the ONE human touchpoint (production promotion) |
| dependency-review | supply chain (new runtime dep) |
| migration-safety | idempotent + additive DB migrations only |
| data-egress | data leaving TO a model (secrets/PII) |
| prompt-injection | injection/jailbreak in text bound for an agent |
| response-review | model OUTPUT leaking secrets/PII or showing manipulation |

## Verification — three enforced layers (a gate can't ship unverified)
1. **Unit** — each `*-gate.test.ts` (every verdict path).
2. **Conformance** — `registry-conformance.test.ts`: every `*-gate.ts` file is
   registered + every gate is contract-valid. Build fails otherwise.
3. **Battery coverage** — `battery-coverage.test.ts`: every gate has a live-battery
   scenario or a recorded exemption (only `ci-autofix`: needs a live red PR).
4. **Live acceptance** — `scripts/dogfood-battery.mjs` (one command, all gates vs
   the deployed app). Last run: **12/12**, all `modelInvoked=null`, ledger #7740+.

## Dogfood scripts (creds from FACTORY_EMAIL/FACTORY_PASSWORD env)
- `scripts/dogfood-ci-fix.mjs` — self-driving CI-fix loop; `--prompt` runs the
  whole build->approve->drive cycle on the test repo (wolfpack-cayenne-e4).
- `scripts/dogfood-battery.mjs` — the fast gate-verdict battery.
- `scripts/selfhost-observe.mjs <PR>` — read-only: run safe-review on an apex PR.

## Self-host (the tool guarding the tool) — graduated + reversible
`SELFHOST_GATE_MODE` env (default `off`): `off` (skip our own PRs) -> `comment`
(non-blocking neutral check + comment) -> `enforce` (block). Client repos are
never affected. Runbook to activate:
1. Install the "AgentGate AI" GitHub App on `the-wolfpack-agency/wolfpack-apex`.
2. Set `SELFHOST_GATE_MODE=comment` in Vercel; watch non-blocking verdicts on live PRs.
3. Flip to `enforce` once trusted.
Nothing acts on our repo by accident (two explicit steps).

## KNOWN GAPS (be honest about these)
1. **THE major gap: the execution/sandbox layer (Wave 2).** Everything that needs
   to RUN code is blocked on it:
   - deterministic fixers (`eslint --fix`/`prettier`) — zero-model lint/format fix
   - PRE-PR TEST EXECUTION — the root-cause fix for the wrong-test class (today the
     ci-autofix gate only *corrects* a wrong test's expected value via the model;
     executing the authored tests before opening a PR kills the class at source)
   - e2e / a11y gates (run real checks vs a preview)
   ONE sandbox investment unlocks all three. **Decision needed before building:**
   GitHub-Action-based runner (reuse GitHub's isolation, repo-side workflow) vs a
   dedicated container runner (our infra) vs an in-app worker (unsafe on Vercel).
   Recommendation to evaluate first: the GitHub-Action runner (AgenticQA's
   sre_autofix ran fixers in CI; reuses isolation, no new infra to secure).
2. Minor: the chain isn't exposed as its own endpoint (only individual gates are);
   no license/SBOM gate; gate endpoints have no rate-limit (ogiam/gate-rate-limit
   exists to reuse).

## Ci-autofix internals worth knowing (hardened via an 8-gap program this build)
- history-derived budget (tamper-proof, can't loop past N); governance/guardrail
  failures escalate (never edit code to pass a gate); transient/infra -> re-run;
  flake pre-filter (re-run once before authoring); snapshot -> escalate (never
  auto-update); fail-closed on unauditable (no audit -> no commit); concurrency
  guard; can't-commit -> require_human; mechanical SUBTYPES (lint/type/import/
  snapshot/coverage) route the fix.

## Next session, start here
1. Merge any open PRs (check `gh pr list`; #957 response-review may be open).
2. **Scope + build Wave 2 (the sandbox)** — the one major gap. Pick the runner
   architecture (see above), then: deterministic fixers first (safest), then
   pre-PR test execution, then e2e/a11y gates.
3. Optional quick wins: chain-as-endpoint; license gate; endpoint rate-limit.
