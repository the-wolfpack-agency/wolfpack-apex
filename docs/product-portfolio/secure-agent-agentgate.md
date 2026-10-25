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

## Operator install steps for the agentgate-ai GitHub App

Read from the code (`src/app/api/github-app/webhook/route.ts`,
`src/lib/github-app/`, `src/lib/github-client.ts`). The live App's current
settings were not inspected; compare them against this list.

1. App settings (GitHub, the App's "General" page):
   - Webhook URL: `https://wolfpack-instinct.vercel.app/api/github-app/webhook`
   - Webhook secret: the same value as the env var **`GITHUB_APP_WEBHOOK_SECRET`**
     (the route verifies `x-hub-signature-256` with it and returns 401 on a
     mismatch or a missing signature).
   - Setup URL (post-install redirect):
     `https://wolfpack-instinct.vercel.app/api/admin/connectors/github-app/install-callback`
     (links the installation to the signed-in admin's workspace).
2. Permissions the gate uses: Pull requests: read (diff), Contents: read
   (post-images of changed files, so modified files are deep-scanned), Checks:
   write (the verdict), and write access for PR comments (posted through the
   issues comments API on a block). Subscribe to the **Pull request** event.
3. App credentials in the deployment env: `GITHUB_APP_ID` and
   `GITHUB_APP_PRIVATE_KEY` (`readAppConfigFromEnv`). Without them no
   installation token can be minted, and the gate falls back to the
   `GITHUB_TOKEN_WOLFPACK_AGENCY` PAT where one applies.
4. Which repos:
   - Client repos: the repos the client selects at install. Nothing else is
     needed on their side. Making "Secure Agent / gate" a required check is
     their optional branch-protection step.
   - Our own repo `the-wolfpack-agency/wolfpack-apex`: installing it does nothing
     until `SELFHOST_GATE_MODE` is raised from its default `off` to `comment`
     (neutral, non-blocking check) and later `enforce`.
5. Entitlement: the workspace needs `secure_agent` enabled (a per-workspace row
   in `instinct_org_entitlements`, else the env default
   `OGIAM_FEATURE_SECURE_AGENT`, which is on unless set to `off`/`false`/`0`).

What a PR shows when it was NOT gated (every case also fires
`ai_code.pr_gate_skipped` with the reason):

| Reason | Check posted | Conclusion |
|---|---|---|
| `unknown_installation` (installation not linked to a workspace) | yes, via an installation token minted from the payload | neutral |
| `not_entitled` | yes, via an installation token | neutral |
| `no_token` | no (no token exists to post with) | none |
| `gate_error` | yes, when the failure left a usable token | failure |

Gate layers on a PR: security, engineering invariant, deep static scan (new and
modified files; a finding in a modified file counts only on a line the PR
added), missing authorization CWE-862 (our own repo only, where the
protected-module convention is known), and known-compromised package versions in
`package-lock.json` / `pnpm-lock.yaml` changes (checked offline against
`security/known-compromised.json`, advisory source cited in the verdict).
