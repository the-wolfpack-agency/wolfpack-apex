# OGIAM flagship products: definition of done

Two products, one substrate. "Done" here has two parts:

1. **Scope-complete** (product-specific): the shortest capability set that makes the
   product sellable on its own.
2. **Quality-complete** (the universal floor below): live-URL verified, tested at
   every layer, no regressions, wired to analytics and the ledger.

A product is done only when **both** hold. Scope without quality is a demo; quality
without a drawn scope is the infinite build. This doc draws the scope line so these
products can be called complete this week, then grown later by composing in a new
module (the builds are modular by design).

## Quality floor (applies to every product below)

- Works against the deployed URL (https://wolfpack-instinct.vercel.app), not only unit tests.
- Tests at every layer touched: contract (200 / 401 / 403), DB (migration idempotent, RLS, hash chain), UI, and E2E through the browser.
- Full verify suite green (`scripts/verify.sh`), no regressions.
- Every action writes to analytics and the OGIAM ledger.
- Any repeated process is codified into a script or CI job.

---

## Product 1: Secure Agent (the agent factory)

**Scope in one line:** a plain-language request becomes production code proven against
your rules before a human ever sees it, delivered as a per-tenant GitHub App.

**Scope-complete checklist** (x = verified in-repo, [ ] = remaining):

- [x] Prompt to authored change, cheapest-capable model via the router
- [x] Deterministic gate: security + engineering invariants + deep static scan, fail-closed
- [x] Independent-family judge (no vendor marks its own homework)
- [x] Auto-repair before handoff, both diff and files mode (PR #878)
- [x] Human-approved real PR; the model never merges, its code never runs on our infra
- [x] CI-as-runner: the PR opens on the tenant's repo, their own CI verifies it (`ci-status.ts`)
- [x] Per-tenant GitHub App: install-callback links the installation to the workspace (migration 195), `resolveGithubToken(workspaceId)` mints the scoped installation token, the executor calls `workspaceGithubClient(workspaceId)`
- [x] Entitlement gate: `requireEntitlement(workspaceId, "secure_agent")`
- [x] Admin UI `/admin/ai-code` with example chips and a governance panel; products-catalog entry
- [x] Install UI on `/admin/connectors/github-app` (install button + manual installation-id fallback)
- [x] E2E spec: positive (governance panel, approve to PR link) and negative (invariant withheld)
- [ ] Register the GitHub App in GitHub. Permissions: contents:write, pull_requests:write, checks:read, metadata:read. Setup URL points at the install-callback route. (ops, not code)
- [ ] Set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `NEXT_PUBLIC_GITHUB_APP_INSTALL_URL` in Vercel
- [ ] E2E on the deployed URL: install the App on a real second repo, submit a prompt, watch the gate decide, land a PR
- [ ] Grant the `secure_agent` entitlement to one pilot tenant

**Done when:** a pilot user installs the App on their repo, submits a prompt, and only
gate-passing code reaches a PR they approve, verified live on the deployed URL.

**Explicitly deferred** (not done-blocking; each is its own follow-on):

1. **Gate any GitHub PR, Copilot included (highest-leverage expansion).** A `pull_request`
   webhook runs the same gate and independent judge on the diff and posts a required
   status Check. Copilot's coding-agent PRs get governed with no extra user work. Needs
   the webhook infra plus checks:write on the App and client-side branch protection.
   Positioning: keep your Copilot, we make its output shippable. Inline in-editor Copilot
   stays outside our reach and we say so.
2. **Post-PR CI auto-fix driver** (red CI to re-author to update PR to re-check). Same
   webhook or cron infra as (1).
3. **Codebase / website generator** (the "secure web-builder"). A separate product.
4. **Repo-aware retrieval** (author from loaded repo context, not the prompt alone).

---

## Product 2: Forcefield

**Scope in one line:** protect a running system from an agent that turns hostile. The
runtime half of OGIAM.

**Scope-complete checklist** (code present in `src/lib/forcefield/` + routes + `/admin/forcefield`):

- [x] Detect / contain / triage of a hostile agent (`contain.ts`, `contain-live.ts`, `triage.ts`)
- [x] Edge enforcement and policy (`edge-enforcement.ts`, `edge-policy.ts`) and a central ruleset (`api/forcefield/ruleset`)
- [x] Deception: grid, canary store, tripwire, breach corpus; coverage scoring
- [x] Know-the-Principal (`principal.ts`, `principal-types.ts`) and operator reputation
- [x] Learned signatures (live) and cron learn / alerts
- [x] Audit anchor and ingest signing (tamper-evident)
- [x] Entitlement: `requireEntitlement(workspaceId, "forcefield")`; env default `OGIAM_FEATURE_FORCEFIELD`
- [x] Admin UI `/admin/forcefield` and `/admin/forcefield-web`
- [ ] Flip it live for at least one tenant (set the env flag / grant the entitlement) and verify on the deployed URL
- [ ] E2E through the UI: an observed hostile action is contained and appears on the board with a ledger entry
- [ ] Confirm the cron jobs (`forcefield-learn`, `forcefield-alerts`) run in prod

**Done when:** Forcefield is live for one tenant, a hostile action is observed and
contained end to end, verified on the deployed URL with a ledger entry.

**Explicitly deferred:**

1. Multi-site portfolio board fanned out to every Wolfpack site (that is rollout, not product-done).
2. Cross-tenant TTP-sharing network beyond our own sites.

---

## Shared substrate (OGIAM: gate, ledger, router, judge, entitlements)

Not sold on its own; both flagships depend on it. Its done conditions are already met:
`decide()` is deterministic over an ordered rule registry, `authorize()` is fail-closed
with a hash-chained ledger, the router is cheapest-first with an independent-family
judge, and per-tenant entitlements are enforced. Treat any change here as touching both
products: run both E2E suites.

---

## After done: marketing

Only once both products are scope-complete and quality-complete. Marketing cannot lead,
because you cannot position a scope you have not drawn. Core message: the rules live in
the gate, not the model, so the same governance holds no matter which AI wrote the code
or took the action. Secure Agent governs the code AI writes; Forcefield governs what a
running agent does. The Copilot-gating expansion, if built, is the wedge into GitHub's
installed base.
