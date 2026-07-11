# Wolfpack Instinct — Release Report 2026-07-11

## TL;DR

The **deploy control plane + agent evals** arc shipped to production on `wolfpack-instinct.vercel.app` (main `05947741`, verified via `/api/version`). Three capabilities are the headline, built reuse-first as one connected story:

1. **Model-version regression detection (#151).** The differentiated net-new for "agent evals": every prior eval/drift check compares an agent across *time*, so a model bump, a prompt change, and data drift collapse into one undifferentiated "score dropped." This keys on **model version** — groups `agent.task_completed` (which already stamps `model_id`) by model, computes per-model task-success rate, compares the newest model against the prior one, and on a regression **notifies the owner for a rollback decision** (no auto-pause — the agent isn't misbehaving, its model got worse). New table `instinct_agent_model_regressions` (migration `221`), daily sweep `0 5 * * *`.

2. **Full deployment pipeline view (#152).** One stitched, staged timeline per change — **CI → merge → build → promote → verify → health** — composing *existing* readers (the release-gate GitHub GraphQL, `src/lib/integrations/vercel.ts`, the `/api/version` serving-sha, the readiness probe). New `Stepper` console primitive. Surfaced fleet-wide on `/admin/deployment` **and** in a new **Deployments tab** on agent detail. Read-only; promotion stays the release gate's one-click action.

3. **Deploy → agent-quality correlation (#153).** The cross-data payoff that ties (1) and (2) together: on the LIVE deploy, surface the agent model regressions flagged *since it went live* — the rollback signal, framed honestly as temporal correlation, not causation.

Also landed in this window (since the 2026-07-07 report): the **OGIAM Agent Constitution** governance of the assistant + agents (#142, #144), the **agent run-task template + assistant widget** (#143), **screenshot capture as agent verification output** (#146), the **governed LLM reasoning fallback** so agents stop failing on `no_match` (#147), the **release gate on the agents page** + **agent triage dispatch** (#149, #150), and fixes for **Tasks "New task"** (#145) and **HR re-add reactivation** (#148).

**Infra (not a commit):** Instinct's vector store was wired to the **existing `wolfpack-prod` Qdrant cluster** — env-only (`QDRANT_URL`/`QDRANT_API_KEY`), zero code. Neo4j was **deliberately deferred** (write-only, no reader).

## Commits (this session → main)

### Features

| SHA | What |
|---|---|
| `f0013e60` | **feat(agents): model-version regression detection (agent evals, phase 1) (#151).** `src/lib/agents/evals/{model-eval,store}.ts` — pure per-model success-rate comparison (newest vs prior model), migration `221` regression ledger, `agent.model_evaluated` + `agent.model_regression_detected` analytics, owner notification + hash-chain audit on regression, daily cron. No producer changes (reuses the `model_id` already on `agent.task_completed`). |
| `7600e3d4` | **feat(deploy): full deployment pipeline view (phase 3) (#152).** `src/lib/deploy/pipeline.ts` stitches 6 stages per change from the release gate + Vercel + `/api/version` + readiness; new `Stepper` primitive; `DeploymentPipelinePanel` on `/admin/deployment` + a `Deployments` tab on agent detail. Honest-degrade per source (no false all-clear). |
| `439bef7e` | **feat(deploy): correlate the live deploy with agent model regressions (#153).** `listModelRegressionsSince` + `agentImpact` on the live pipeline; `deploy.agent_regression_correlated` analytics; correlation line on the live row. Temporal, not causal — worded as such in UI + event. |
| `7f621863` | **feat(agents): surface the Production Release Gate on the agents page (phase 1) (#149).** Reuses the release-gate data source + console kit on the agents surface. |
| `c4868d15` | **feat(agents): governed LLM reasoning fallback — agents no longer fail at `no_match` (#147).** Budget-gated, constitution-applied reasoning when no deterministic tool matches. |
| `13dfabe7` | **feat(agents): screenshot capture as agent verification output (#146).** Serverless-Chromium provider behind an abstraction; SSRF-guarded; audited. |
| `1672d7f0` | **feat(maintenance): intake + telemetry rails for the daily bug/feature queue (#137).** |

### Fixes

| SHA | What |
|---|---|
| `3840a85b` | **fix(hr): re-adding a removed person reactivates instead of failing (#148).** Confirmed a real client need — upsert on email reactivates the row (`reactivated` flag on the `hr.employee_added` event) rather than 409-ing. |
| `59ce1ebc` | **fix(tasks): don't force a list pick — default to the user's default To Do list (#145).** The list dropdown was a dead-end on an empty cache; server now resolves the default To Do list when `listId` is omitted. A coworker was blocked on this. |
| `a049e2e2` | **fix(deploy): remove duplicate release-gate-check cron (unblocks prod deploy) (#139).** |
| `76f7dd3a` | **fix(deploy): re-schedule the release-gate notifier cron + restore its guardrail (#138).** |

### Governance / control plane (Other)

| SHA | What |
|---|---|
| `d478a0c5` | **Govern the assistant + OGIAM agents with the OGIAM Agent Constitution (#142).** Single source-of-truth rules loaded per runtime (Claude Code hooks + apex AI-router `apply_constitution`). |
| `39da049d` | **chore(constitution): sync to v1.1.0 — mandatory E2E UI verification per feature (#144).** |
| `69a3564c` | **Agent control plane: run-task template on the detail page + assistant chat widget (#143).** Objective + Success criteria (required) + Context + Target (optional), structured columns, migrations `219`/`220`. |
| `f323d725` | **Deploy control plane #2: dispatch an agent to triage a blocking deploy (#150).** `source: "deploy_gate"` tasks + `deploy.triage_dispatched` — the agent↔deploy link reused by #152/#153. |

## Numbers

| Metric | Value |
|---|---|
| PRs merged to main this session | ~16 (`#137`–`#153`) + Dependabot bumps |
| New migrations | 3 (`219_agent_task_template`, `220_agent_screenshots`, `221_agent_model_regressions`) |
| New analytics events | 8+ (`agent.model_evaluated`, `agent.model_regression_detected`, `deploy.pipeline_viewed`, `deploy.agent_regression_correlated`, `agent.constitution_applied`, `agent.reasoned`, `tools.screenshot_captured`, `deploy.triage_dispatched`) |
| New console primitive | 1 (`Stepper`) |
| New E2E specs | 3 (agent model-regression, agent deployments tab, fleet deployment pipeline) |
| Full suite | green (**14,077** tests) |
| tsc / lint / `scan:tenant-isolation` | clean / clean / `unclassified: 0` |
| Infra wired | Qdrant (existing cluster reuse, env-only) |

## What's measurably different in production

### `/admin/agents` + agent detail
- Agents now have **model-version regression detection** running daily — if the newest model an agent runs on does materially worse than the prior one, the owner is notified with the deltas (rollback signal). A "Model regression watch" surfaces the fleet's regressed agents.
- Each agent has a **Deployments tab** showing the code changes it engaged with (the deploys it was dispatched to triage), each as its full pipeline.

### `/admin/deployment`
- Below the release gate, a **Deployment pipeline** panel shows every recent prod deploy + in-flight PR as a stitched **CI → merge → build → promote → verify → health** timeline, pulling real GitHub + Vercel + serving-sha + health data. The **live** deploy is marked, and — once the eval sweep has data — shows **agent model regressions flagged since it went live**.
- Honest-degrade: if Vercel/GitHub can't be read, the affected stages say so rather than showing a false all-clear.

### Vector store
- Triple-write's vector fan-out and the brain semantic search are now **live against the shared Qdrant cluster** (was degraded to Postgres-only). No code changed — env only.

## Operational notes / carry-forward

- **No provisioning pending.** Microsoft Graph + Resend were already live; Neo4j is deferred by decision (write-only, no reader).
- **Do not delete `src/lib/rag-providers/*`, the `neo4j.ts` graph-read fns, or `src/lib/ai/semantic-cache.ts`** — they are parked, tested (97 tests) Azure-migration scaffolding (`docs/azure-migration.md`), not dead code.
- The **Azure vector/graph migration** (`docs/azure-migration.md`) is the parked next-big-thing if consolidating onto Azure — a deliberate build (wire the adapters into the live write path), not a config flip.
