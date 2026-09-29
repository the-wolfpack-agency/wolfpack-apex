# Secure Agent — Product Architecture (working draft, red-line me)

**Thesis.** A new repo that is *just the site*, plus a thin integration surface, where a hosted **control plane** does the building and gating and **Forcefield** guards the running site and the agent operating it. Any LLM (or a person) talks to a **system-aware assistant** embedded in the site to build, update, and run it — safely, because every change flows through the deterministic gate and every runtime action is monitored and revocable. The product is *practical infrastructure for an LLM to safely build, run, and maintain its own site.*

**Standard of proof.** The dogfood harness is the source of truth. Every capability claim in this doc is either (a) already dogfood-verified, (b) verifiable on demand by pointing the dogfood at it, or (c) explicitly unbuilt. No claim rests on assertion.

---

## 1. Core architecture decision: hosted control plane + thin vendored shim

Not a fat, self-contained repo. Rationale, grounded in what exists:
- The factory already operates on *external* repos via the AgentGate GitHub App + the pipeline API — it is built to be hosted.
- The Forcefield rollout model is already two-plane: a **central ruleset** (data; updates instantly across every site) + a **vendored core** (code; scripted in). A fat repo fights that.
- Central maintenance = every site inherits gate/control improvements with no per-repo migration (scalability-first).

```
   NEW SITE REPO (thin)                       HOSTED CONTROL PLANE (Instinct)
   ─────────────────────                      ──────────────────────────────
   • the site (Next.js)                        • factory pipeline (author→gate→fix)
   • CI workflows (installed templates) ─────▶  • deterministic gate + all controls
   • AgentGate GitHub App  ─────────────────▶   • model router (cheapest-first, cross-family)
   • embedded assistant (route+widget) ─────▶   • central ruleset + entitlements
   • Forcefield edge shim (middleware) ─────▶   • Forcefield brain + monitor
   • config (site identity, ruleset ref)        • OGIAM hash-chained ledger
```

---

## 2. The operations plane (the "full combo" — more than factory + Forcefield)

Every box below already exists in some form; the product wires them together.

| Capability | Built-from | Role in the product |
|---|---|---|
| **Build** | factory pipeline + intake (spec governs authoring) | author/update the site from a prompt |
| **Gate** | deterministic controls (anchor, phantom-dep, completeness, spec-directives, contradiction-guard, secret/PII scrub, governance classify, attribution) + web gates (browser-check, preview-verify, prod-promote, deploy-health) | nothing unsafe/broken ships |
| **Scan** | **platform-scan** (bug/UX/a11y over http/static/browser) | Forcefield's *eyes* — continuous scanning of the running site |
| **Monitor** | **Forcefield** runtime protection | guards the live site + the agent; revocable runtime |
| **Audit** | **OGIAM hash-chained ledger** + **approvals surface** | every gate decision + agent action is audited; prod = human approve |
| **Converse** | **FDOS self-knowledge responder + page/route catalog** | the system-aware assistant (deterministic, never brain-seeded) |
| **Measure** | **outcomes/KPI + friction analytics** | operator sees the site's health + adoption |
| **Onboard** | **client-deploy hardening** (GitHub App / AI-budget / RLS tripwire / offboarding) + **target-ownership gate** | productized onboarding of a real client site |
| **Route/cost** | model router + per-run budget ceiling | cheapest-model-first, bounded spend |

---

## 3. What lives where

**In the new repo (thin):**
1. The site (framework: **Next.js** — path of least resistance; matches our gates + workflow templates).
2. Installed CI workflows — already built as templates: `factory-validate.yml`, `factory-browser-check.yml`, `factory-deterministic-fix.yml`.
3. The AgentGate GitHub App (PR-gating + factory-driven fix PRs).
4. Embedded assistant: a route + widget with build context (page/route catalog + `/api/version`), calling the hosted factory to answer and to *propose gated updates*.
5. Forcefield edge shim (middleware/edge hook).
6. Config: site identity, which ruleset/entitlements apply.

**Hosted (Instinct):** factory pipeline, gate + all controls, router, central ruleset, Forcefield brain, ledger, platform-scan, outcomes.

---

## 4. Operator / LLM UX

The embedded assistant is the work surface (reused from FDOS, §13): **role-scoped prompt chips** ("Add a page", "Fix the broken nav", "What changed since Tuesday?") lower the operator into ready-made intents; a free-text box handles the rest. A chosen intent renders as an **editable chat form** the operator adjusts and confirms — *that* is the proposal → factory authors → gate → PR → CI incl. **live browser-check** → **preview-autonomous, prod = human approve** → deploy-health monitors → Forcefield + platform-scan guard runtime. Operator sees input and output; machinery is invisible. Declined chips feed resistance analytics; friction (rage/dead-click) on the live site feeds back too.

---

## 5. Safety model (sharper than PR-gating — this runs a live site)

- **Environment authority, enforced in code:** the agent *can* push branches / run preview CI / write preview env; it *cannot* merge to main, promote, or write prod env — prod-promote routes through `require_human`.
- **Kill-switch** for any autonomous action path (build trigger: first per-action-confirm-free path).
- **Egress guards inherited** (no real email/Graph/external sends from a preview/agent run).
- **Per-run budget ceiling** + **Forcefield monitoring** of the live site and the agent.
- **Hash-chained ledger** over every decision and action.

---

## 6. Status: proven / verifiable-on-demand / unbuilt (honest)

**Proven by dogfood (0 unsafe, ever):** author→gate→CI-fix→converge for **new-file logic, multi-file features, edits to existing files, and an unfamiliar stack (vitest/`source/` layout, first fully-green `merge_ready`)** — on both jest/Next and vitest. The gate + all controls hold; spec-ambiguity is closed (prevented at authoring + safely recovered); the edit path was found broken and fixed (#981). Code-work convergence has **plateaued at the pilot bar.**

**Honest residuals (small, low-risk):** the vitest *fix loop* is unexercised (the model kept succeeding first-try; vitest≈jest output); very large/complex tasks are lightly tested.

**Unbuilt (the capstone's real work, in dependency order):**
1. Factory authoring a **web surface** (routes/components) that converges — never attempted.
2. A **green deploy** through the factory + the **web gates firing live** (browser-check on a real preview) — never done (cayenne's deploy has been infra-failing all along).
3. **Forcefield wired to a live factory-operated site** — unbuilt.
4. **System-aware assistant** scoped to a specific built site — design, from the FDOS responder pattern.
5. **Product packaging** to a fresh repo (the thin shim + App + config as an installable) — unbuilt.

---

## 7. Build sequence (incremental; each de-risks the next; nothing throwaway)

1. ~~**Firm the "proven" claim** — dogfood edit-existing, multi-file, unfamiliar stack.~~ **DONE this session:** multi-file ✓, edit-existing (found a real gap → fixed #981) ✓, vitest/`source/` unfamiliar stack ✓ (first fully-green `merge_ready`). Code-work convergence has plateaued at the pilot bar.
2. **Web-authoring increment (Increment 1, §10)** — factory authors a minimal web change and drives it to a **green deploy + live browser-check** on a fresh deployable Next.js repo. The first real "web lifecycle" proof, and the kept seed of the capstone repo.
3. **Wire the web gates live** on that repo (preview-verify, prod-promote, deploy-health).
4. **Forcefield + platform-scan** on the running site.
5. **System-aware assistant** embedded — the FDOS layer (§13): page/route-catalog grounding + prompt chips + editable chat forms + comprehension + reliability judge, all deterministic.
6. **Package** the thin shim + App + config as the installable product; deploy the fresh repo as the demo/showcase (kept).

---

## 8. Open decisions to pin

1. **Hosted control plane + thin shim** (recommended above) vs a more self-contained repo. — *open, confirm.*
2. **Demo-site framework** — Next.js recommended. — *open, confirm.*
3. ~~Single- vs multi-tenant~~ — **RESOLVED (§14):** build hierarchy-native seams from day one, single first demo.
4. **Where the capstone repo lives** — a fresh kept repo in the org, deployed as the product proof. — *open.*
5. **Brownfield onboarding order** — dogfood brownfield on one of *our own* existing repos (preview-only) before any client repo (§15d). — *recommended.*

---

## 9. Code-factory → web-factory: the deltas that must be built

What the proven code-factory does NOT yet do, and what each needs:

| Piece | Today | Delta for the web product |
|---|---|---|
| **Authoring** | authors pure modules + tests | author WEB surfaces (routes/pages/components/layouts) in the right place and wire them (nav, imports). Grounding already detects Next.js app/pages; likely mostly works via grounding + files mode — **unproven, Increment 1 settles it.** |
| **Gates** | code gates fire live | the WEB gates (browser-check, preview-verify, prod-promote, deploy-health) exist but have **never fired live** — wire browser-check (Playwright/axe) to a REAL preview URL. |
| **Deploy** | never a green deploy through the factory | a repo whose Vercel project actually deploys green (Vercel is installed org-wide, so previews work — the capstone repo needs a real Vercel project). |
| **Runtime** | none | Forcefield edge shim + hosted monitor on the live site + the agent. **Unbuilt integration.** |
| **Assistant** | none | build-context responder (page/route catalog + `/api/version`) scoped to the site. **Unbuilt.** |

## 10. Increment 1 — the first buildable proof (concrete)

**Goal:** prove the factory can author a *web change* and drive it to a **green deploy + a live browser-check** — the crux everything else sits on.

- **Setup:** a fresh deployable **Next.js** repo in the org with a working Vercel project + the `factory-validate` and `factory-browser-check` workflows installed.
- **Test:** prompt the factory — *"add a `/pricing` page with a heading and three plan cards."*
- **Pass criteria:** authors the route + component in the right place; code gates (tsc/lint/unit) green; **Vercel preview deploys**; **browser-check asserts HTTP 200 + the heading renders + no CSP violations** → `merge_ready`.
- **De-risks 3 of the 5 unbuilt pieces at once:** web authoring, web gates firing live, the deploy path. Forcefield + the assistant come after.

## 11. Risk & unknown register (mapped to the increment that closes it)

| Risk | Closed by |
|---|---|
| Factory places web files wrong / fails to wire them | Increment 1 (web authoring) |
| browser-check flaky / preview-URL timing races | Increment 1 (harden the workflow against a real preview) |
| Deploy needs secrets/config the factory can't set | Increment 1 setup (real Vercel project) |
| Forcefield shim adds latency / can break the site | its own increment, behind a flag, measured |
| Assistant self-knowledge drifts from reality | deterministic responder (no brain-seed), verified against `/api/version` |
| vitest fix-loop extraction gap (carried residual) | verify when a real vitest failure occurs; low risk (vitest≈jest output) |

## 12. Data & learning integration (per the engineering directive — no data lost)

Every factory run already emits `ai_code.pipeline_run` analytics + a hash-chained OGIAM ledger entry. The product inherits this end to end: every **build / update / deploy / Forcefield action** is an analytics event + a ledger entry → the learning loop + the immutable audit. The assistant's Q&A and the operator's **accept/reject** on proposed changes feed the adoption/resistance analytics we already built. Nothing the system does is unlogged or unlearned.

---

## 13. Capabilities folded in (reuse from FDOS + the platform — do NOT rebuild)

The product is stronger by reusing what we've already built. Each is a reuse target, not a new build:

**From FDOS (the assistant/operator layer):**
- **Prompt chip management** — the role-annotated **prompt registry + chip catalog**. The operator gets ready-made, role-scoped prompt chips for common site operations; the catalog is data-driven (extendable per site). Declined chips feed **resistance analytics** (which intents get dismissed → the learning loop).
- **Assistant as the work surface** — every action is an **editable chat form** (`/api/assistant/forms/submit`): a proposed site change is a form the operator edits + confirms *before* it's gated. This is the natural "propose a gated update" UX.
- **Capability tour + page catalog** — the assistant builds a **CapabilitiesWidget** from the site's page/route catalog (also the self-knowledge grounding, §3/§5), role/flag scoped: "what can this site do?"
- **Comprehension layer** — coach-mark tour + "How it works" + **"This page"** explainer, so the operator understands the site the agent built and maintains.
- **Assistant reliability** — the LLM **relevance judge** + honest **NO_MATCH** (never fabricate a capability) + the verify-button / role-safety guardrail scripts, so the assistant never mis-fires or surfaces a control a role can't use.
- **Friction analytics** — the rage-click / dead-click tracker on the live site → surfaces controls that don't work or are shown to the wrong role (Forcefield-adjacent runtime UX signal).
- **Outcomes / KPI / customer-success** — the `analytics_events`-derived outcomes view so the operator sees adoption + health of their site (never rating prompts — derived).
- **Agent workflows** — confirm-gated **multi-step flows** on a shared template, for site operations that are more than one step.

**From the platform:**
- **Model router** (cheapest-first, cross-family, version-attributed) + **per-run budget ceiling** — bounded, attributed spend on every build.
- **BYO-model / Foundry plug-in** — a client can plug their own model/key into the router+gate; the product demos the *governance*, model-agnostic.
- **Per-tenant cost metering** (effectiveness-cost-metering) — per-site AI spend + usage (managed-LLM COGS), so the product is sellable with real unit economics.
- **Platform-scan** + **OGIAM ledger** + **agent-evals** — scanning eyes, immutable audit, and model-version-attributed quality evals over time.

**Reuse discipline:** these live in FDOS (wolfpack-ford) / Instinct today. Fold in the PATTERNS via the hosted control plane + thin shim; do not fork or re-implement (reuse-don't-duplicate). Each carries its analytics + ledger wiring, so §12 (no data lost) holds automatically.

---

## 14. Multi-site, hierarchy & customer success (reuse from FDOS + WWP + Instinct)

Turns the product from "one LLM runs one site" into "one operator governs *many* sites, safely, in a hierarchy." All reuse:

- **Hierarchy model** (FDOS federation): sites organized **HQ → area → site → user**, with `FedSession`/`area_id` scoping and **per-node module gating** (each node gets only the modules/entitlements it's granted). The `fedSessionFor(session)` scoping discipline (never raw claims) comes with it. Lets an enterprise operator manage a fleet of governed sites, not one.
- **Cohort benchmarking + rollups** (FDOS HQ benchmarking): comparable-node grouping + **auto rollup reports**, so an HQ sees how its sites compare on adoption, health, and outcomes — and the assistant can answer "which sites are lagging?"
- **Customer success** (customer-success-engineering + FDOS customer-success layer): outcomes **derived** from `analytics_events` (never rating prompts); the standing guardrail that a **control shown to a role that can't use it (a silent 403) is a UI defect** the analytics must catch. Surfaced per-site and rolled up across the hierarchy — so "is this working for the client?" is answered with data.
- **WWP microsite-builder standard** (dealer-microsite-scaffold-standard): a new site the factory scaffolds must meet the **full standard** — full template + all CI + AgenticQA + every test layer (contract/DB/UI/E2E) — not a bare app. The factory's output *is* a properly-scaffolded, gated site from day one.

**Why this matters:** it makes the product **enterprise-sellable** — a single governed control plane over a hierarchy of AI-built-and-maintained sites, with real per-site + cohort customer-success signal. Reuse-don't-duplicate: fold the patterns via the hosted control plane; these already carry their analytics + ledger wiring (§12 holds).

**Open decision it resolves:** §8's "single-tenant vs multi-tenant" → build **hierarchy-native seams from day one** (FedSession scoping, per-node gating), even while the first demo is a single site. Retrofitting hierarchy later is far more expensive than leaving the seams in.

---

## 15. The two rollout scenarios: NEW repo vs EXISTING repo (both are primary)

A client will onboard either a fresh site (greenfield) or their existing one (brownfield). These have **different failure modes**; the product must handle both, and brownfield is materially harder.

### 15a. New repo (greenfield) — the easier path
We control everything, so most risk is setup, not the unknown.

| Issue | Mitigation (mostly in hand) |
|---|---|
| Vercel project + domain provisioning | part of onboarding; Vercel is org-wide-installable |
| Framework/stack choice | default Next.js (matches our gates + workflow templates) |
| Scaffold must be production-grade, not a bare app | the **WWP microsite-builder standard** (§14): full template + all CI + AgenticQA + every test layer, from commit 1 |
| Initial design/content | assistant-driven, gated like any change |

Greenfield is essentially **Increment 1 (§10)** generalized. Low residual risk once Increment 1 passes.

### 15b. Existing repo (brownfield) — the hard path (honest risk list)
Onboarding a real, live, human-maintained codebase. Each is a real issue with the reuse that addresses it — and where we're still unproven:

| Issue | Mitigation / reuse | Proven? |
|---|---|---|
| **Messy baseline** — the repo already has failing tests / lint / type errors | **baseline attribution** (introduced-vs-pre-existing, already built + dogfood-proven) + **onboarding baseline snapshot** (record pre-existing red before touching anything) so the factory never fixes-or-is-blamed-for pre-existing red | attribution ✓; snapshot exists, unproven on a real messy repo |
| **CI / branch protection blocks the factory's PRs** (required reviews/checks) | this is the human gate *working* — but the UX must read "awaiting your approval," not "stuck." We literally hit this (#981 `BLOCKED`). Factory workflows install **alongside** existing CI, non-destructively | partially — needs the "why blocked" surfacing |
| **Large / unfamiliar conventions** (proprietary patterns, internal libs, big tree) | grounding (framework/test/layout detection) + files-mode authoring + **human review as backstop**. Small unfamiliar stack (vitest) proven; **large brownfield is NOT** | ❌ the top brownfield unknown |
| **Non-Next / monorepo / app-in-subdir layout** | grounding must detect the layout + root; our gates are Next-oriented; browser-check is generic (Playwright) but build/deploy assumptions differ | ❌ unproven |
| **Deploy + secrets are the client's** (their Vercel/AWS, their env) | the factory can't set their secrets; preview deploys may fail → **graceful degrade** (gate on code checks; mark deploy/browser-check "unavailable, not failed") rather than block | ❌ needs the degrade path |
| **Active human development** — PRs go stale, conflict, race with human commits | small scoped PRs + rebase discipline; we've hit squash-conflict pain ourselves | partially |
| **Trust / least-privilege / clean exit** | **environment authority** (never prod), **target-ownership** verify before operating, **kill-switch**, **offboarding** (clean App removal, no residue) — all from client-deploy hardening | designed; offboarding unproven live |
| **Cost/scale on a big repo** (bigger grounding, more tokens) | **per-run budget ceiling** + **per-tenant cost metering** | ✓ mechanisms exist |

### 15c. What brownfield specifically requires (the honest gap list)
1. **Large-repo grounding** — detect framework/test-runner/layout/root on an arbitrary repo (monorepo, subdir), not just a clean template.
2. **Install-alongside-existing-CI** — add factory workflows without colliding with the client's, and read *their* checks for the fix loop.
3. **Baseline snapshot on onboard** — capture pre-existing red so attribution is exact from run 1.
4. **Graceful deploy/browser-check degrade** — when the client's preview infra/secrets aren't reachable, mark those gates "unavailable" (n/a, not fail) and gate on what we *can* verify.
5. **"Why is my PR blocked" surfacing** — distinguish "the human gate is waiting on you" from "the factory is stuck."

### 15d. Sequence implication
Greenfield (Increment 1) proves the happy path. **Brownfield needs its own increment against a real EXISTING repo** — start with one of *our own* existing sites in read-mostly/preview-only mode (safe, we own it) before any client repo. Brownfield is where the real adoption risk lives, so it gets deliberately dogfooded, not assumed.
