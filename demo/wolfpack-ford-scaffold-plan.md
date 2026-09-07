# wolfpack-ford — Phase 1 scaffold plan

Draft for review. No code until approved. Phase 1 = **dashboard + assistant only**, incredibly simple, built to add tools modularly later. Reuses Instinct's proven libraries; emulates weekendwithporsche.com's (WWP) rollout + analytics because that rollout was flawless.

---

## 1. Principles

- **Reuse, don't fork.** Import Instinct's proven libs; build only the thin client-facing surface fresh. Instinct stays the proving ground.
- **Name is one config value.** `APP_NAME` env drives the UI title, `<title>`, and the assistant identity prompt ("You are {APP_NAME}…"). No product name baked anywhere — the Apex→Instinct rename was that mistake. "Ford DOS" vs "Ford Intelligence" becomes a one-line change.
- **Repo name `wolfpack-ford`** — client-anchored (matches wolfpack-apex/auto/beyond/porsche-weekend), survives the product-name decision.
- **Nothing reaches the client unverified** — testing at every layer, including a **manual "what did the assistant actually say" review** before and during rollout.

## 2. Copy from Instinct (proven) vs build fresh (minimal)

**Copy (libraries, near-verbatim):**
- Assistant core: `chat()`, the router, the **gate** (redact/reject answer boundary), the answer-path rendering fixes shipped this week (clean clickable source cards across all paths, concise answers).
- Brain: retrieval (`queryBrain`), ingest, the estate model + scoping.
- Connectors substrate: `src/lib/connectors/` + Microsoft Graph OAuth/token/ingest.
- Governance/quality harness: AgenticQA scan, `verify.sh` (lint+tsc+jest), the E2E suite, `eval-retrieval`, `answer-audit`, `audit-eval-pairs`.
- Tenancy: per-client-DB + tenant-from-session (Instinct migration 137).

**Build fresh (thin, client-facing):**
- Minimal dashboard shell (WWP-styled, see §3).
- The assistant page (the polished current one), themed fDOS (§5).
- fDOS theme tokens + robot mascot.
- Connector-status + baked-in-data tiles (§6).

## 3. Emulate WWP's rollout + analytics (the proven, flawless part)

Extract and adapt these real WWP components (`wolfpack-porsche-weekend`):
- **Auth + account lifecycle (reuse wholesale, do NOT rebuild):** WWP already has a fully working sign-in, role hierarchy, invite + transactional email, and forgot/reset-password flow. Carry those verbatim (`app/api/auth/*`, invite + reset routes, the email templates) so Ford gets a proven account lifecycle on day one and we never re-solve auth. This is the single biggest anti-duplication win.
- **Tiered/hierarchy rollout:** `lib/admin/waves.ts`, `lib/admin/wave-sheet.ts`, `app/api/admin/waves/route.ts`, `waves/assign/route.ts` — the wave-based "add users, roll out in tiers" mechanism. Roles/hierarchy from `lib/admin/role-labels.ts` (org → region/division → dealer/location → user), with **role-gated dashboards** (a limited view for lower tiers, full view for operators).
- **Analytics:** `lib/analytics.ts`, `lib/admin/analytics.ts`, `app/admin/analytics/AnalyticsView.tsx`.
- **Customer-success metrics:** `lib/admin/dashboard.ts` + `components/admin/charts/GuestFunnel.tsx` — the funnel + adoption/engagement view. Adapt the funnel to the assistant/knowledge use case (reach → asked → answered → returned).

Result: Ford rolls out exactly like WWP did — add a wave of users at a tier, watch adoption/success metrics per tier, expand. Same shape that worked.

## 4. Connectors — link ALL the client's tools, fast

Carry the **substrate**, not just SharePoint, so each system is config not a rebuild:
- **SharePoint** (day 1, proven — estate sync + scoping).
- **DMS** — reuse Instinct's already-built DMS driver (never run in prod; wire + test).
- **CRM** — reuse the existing CRM connector tools.
- **Connector-status dashboard tile:** "SharePoint ✓ · DMS — not yet · CRM — not yet", each a one-click connect step.

## 5. Styling — fDOS placeholder until the designer delivers

From `~/Downloads/fDOS_New Slides 1.pptx`, as swappable theme tokens so the designer's real system drops in later:
- Palette: navy `#001E50`, indigo `#00095B`, **primary blue `#0860D2`**, slate `#16202A`, green accent `#92D050`, grey `#66717E`, white.
- Mascot: the blue robot (squircle face, two white eyes) → assistant avatar, thinking indicator, empty states.

## 6. Dashboard tiles — surface the baked-in value

Beyond the WWP adoption/success metrics: **connectors status**, **model router in use** (which model answered, cost), **gate/compliance status** (answers checked, redactions), **knowledge coverage** (docs indexed, per estate). These make the platform's governance visible to Ford's team — the differentiator.

## 7. Testing — extensive, all layers, including MANUAL assistant verification

Non-negotiable, carried from Instinct + one addition you asked for:
- **Contract / DB / unit / component** tests (per the standing directive).
- **User-simulation E2E** (drive the real assistant, assert what the client sees renders — the guard that would have caught this week's UI bugs), on the **deployed URL** with a smoke user.
- **`answer-audit`** — real prompts replayed through the live router+gate + LLM-graded; `--from-feedback` turns thumbs-downs into regression cases.
- **`eval-retrieval` + `audit-eval-pairs`** — retrieval recall on a *clean* pair set.
- **Manual assistant-response review (new):** a transcript/replay surface (extend `scripts/prompt-transcript.ts`) so before/during rollout we can **read exactly what the assistant responds to real client questions** — no surprises, full visibility into how it's functioning. This is a first-class deliverable, not an afterthought.
- **AgenticQA scan** — carried, but **tuned for precision first** (Instinct's scan cried wolf at 2,113 findings; a client security team must not see that).
- `verify.sh` gated in CI; nothing merges red.

## 8. Build sequence

1. Repo + `APP_NAME` config + fDOS theme tokens + CI/verify.sh/AgenticQA (tuned) from commit one.
2. Assistant page (polished, themed) + brain/gate/connector libs wired; SharePoint connect.
3. Dashboard shell + WWP wave-rollout + role hierarchy + analytics/success funnel.
4. Connector-status + baked-in-data tiles; DMS/CRM wired as modules.
5. Manual-review + user-sim E2E + answer-audit running in CI.

## 9. Gates before Ford's real data goes in

- Human pass on the flagged eval pairs (recall is really 71–83%, not 71%).
- AgenticQA scan: NOT retuned on Instinct (owner decision 2026-09-07 - leave that scanner as-is). For ford, stand up the scan **precision-first from commit one** (vendor/ excluded, provider-signature secrets only, Semgrep for taint classes) so the client security team never sees the 2,113-finding noise. See section 7.
- [DONE, PR #681] Live-UI assistant user-sim E2E wired into e2e-reality-check.yml (runs post-merge against prod with the smoke user).
- One clean end-to-end rollout rehearsal on a test tier, mirroring WWP.
