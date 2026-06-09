# Survey Builder — Build vs. Buy Decision Spec

**Date:** 2026-06-09
**Author:** CTO (drafted with Claude)
**Status:** Decision doc — no code written yet
**Scope decided:** Client-facing surveys (sent to clients / their audiences via QR + link), built and managed internally in Instinct.

---

## 1. TL;DR recommendation

**Don't rebuild Cognito Forms. Don't hand-roll a drag-drop builder either.**

Build a thin, owned **survey responder + response-data layer inside Instinct**, and **embed a proven open-source form engine (SurveyJS)** for the builder and renderer. Keep **Cognito Forms** in service for anything that needs its heavy features (payments, e-signature, HIPAA) until we prove parity isn't worth chasing.

The value we're buying by building is **not the form builder** — that's a commodity. It's **owning the response data**: every answer becomes a first-class entity in Postgres + Qdrant + Neo4j, joined to clients, people, journeys, and the QR scans we already ship. The differentiator is the funnel **scan → survey → response → learning**, which Cognito structurally cannot give us.

Phased: **build + buy**, not rip-and-replace. Earn the right to replace Cognito on real client use.

---

## 2. Why not just keep Cognito Forms?

Cognito is fine at what it does. The problem for a client-facing, data-compounding platform is structural:

- **Siloed data.** Responses live in Cognito's DB. We get them back via CSV export or webhook — never natively joinable to our clients/people/QR/journey graph. The learning loop can't see them without a brittle sync.
- **No QR-native funnel.** We just shipped `/q/<slug>` short links + scan analytics. Cognito has no concept of "this response came from the windshield QR scanned in Albany at 2pm." We'd be re-stitching attribution by hand.
- **Brand + UX ceiling.** Client-facing means it should look like the client's brand (or Instinct's), not Cognito's chrome.
- **Per-form / per-seat economics** scale the wrong way as survey volume grows across clients.

None of this means Cognito is *bad* — it means it's the wrong primitive for a platform whose moat is integrated data.

## 3. Why not build the whole thing from scratch?

Because a survey *builder* is a deceptively large commodity:

- Drag-drop builder UI, 10+ question types (single/multi choice, rating, NPS, matrix, ranking, file upload, date, signature), conditional logic / skip patterns, page breaks, validation, calculations.
- Public responder: anonymous response capture, partial-save/resume, anti-bot/spam, rate limiting, accessibility (WCAG), i18n, mobile rendering.
- Response analytics, aggregation, exports, email notifications.

Matching Cognito here is **months** of work to rebuild a solved problem. That's the low-ROI trap.

## 4. The middle path: own the data, embed the engine

| Concern | Decision | Rationale |
|---|---|---|
| **Builder UI** (drag-drop) | Embed **SurveyJS Creator** (commercial license ~$500–2k/yr) OR start with a simple form-spec UI | Don't hand-roll drag-drop. SurveyJS is battle-tested, JSON-schema based. |
| **Renderer** (public responder) | Embed **SurveyJS form library (MIT, free)** | Free, self-hosted, themeable, accessible, every question type. We render it on our own public route. |
| **Response storage** | **Build — Instinct Postgres + triple-write** | This is the whole point: own the data, RLS-scoped, joinable, fed to the learning loop. |
| **QR integration** | **Build — reuse `/q/<slug>` + scan analytics** | A survey is just a QR destination type; the scan already carries attribution. |
| **Heavy features** (payments, e-sign, HIPAA) | **Keep Cognito** short-term | Don't chase parity on the expensive 20% until a client actually needs it. |

### Tools compared (don't default — this is the comparison)

- **Cognito Forms (status quo):** mature, cheap, but siloed + no QR/learning integration. *Keep for heavy edge cases.*
- **Typeform / Tally:** nicer UX, still SaaS-siloed, recurring per-response cost. *No — same silo problem, more money.*
- **SurveyJS (recommended engine):** OSS MIT renderer + JSON schema; commercial Creator UI. Self-host, **we own the data**. *Best fit — buy the commodity UI, build the data moat.*
- **Full hand-roll:** max control, months of commodity work. *No — rebuilds a solved problem.*

## 5. Proposed MVP scope (client-facing, phase 1)

**In scope:**
- Survey model: a survey = title + SurveyJS JSON schema + status (draft/published/closed) + owner + optional `client_id` + optional linked QR code.
- Builder surface in Instinct (`/surveys`) — start with SurveyJS Creator embedded, or a minimal field-add UI if we defer the Creator license.
- **Public responder route** (no auth for respondents): `/s/<slug>` renders the survey via SurveyJS form library; anonymous submissions allowed; rate-limited + bot-guarded.
- **QR link:** "Generate QR for this survey" → reuses the QR module; scan → `/s/<slug>`; scan attribution carried into the response row.
- Response capture → Postgres (RLS) + triple-write (Qdrant embedding of free-text, Neo4j edge survey→client→respondent) + analytics events (`survey.published`, `survey.response_submitted`, etc.) feeding the learning loop.
- Response dashboard: counts, completion rate, per-question aggregation, CSV export.

**Out of scope (stays on Cognito for now):** payments, e-signature, HIPAA, file uploads at scale, complex calculations, multi-party workflows.

## 6. Architecture sketch (Instinct / wolfpack-apex)

- **Migration:** `instinct_surveys` (id, slug, title, schema JSONB, status, client_id, qr_code_id, created_by, timestamps) + `instinct_survey_responses` (id, survey_id, answers JSONB, respondent fingerprint, qr_scan_id, submitted_at). RLS on workspace/client.
- **Public route** `/s/[slug]` — unauthenticated, like `/q/[slug]`; `checkRateLimit` + bot guard; writes via a single `submitResponse()` through triple-write.
- **QR tie-in:** survey carries an optional `qr_code_id`; the QR's target is `/s/<slug>`; the scan row's id is stamped onto the response so the funnel joins cleanly.
- **Analytics/learning:** new `InstinctEventType` events; response free-text embedded to Qdrant for thematic clustering; Neo4j edges for "which clients/segments respond."
- **Deliverability (client-facing):** link + QR distribution first; email-send via existing Resend layer is a fast-follow.

## 7. Effort estimate (rough)

- **Phase 0 — spec sign-off + SurveyJS license decision:** ~0.5 day.
- **Phase 1 — MVP (model, public responder, QR link, response capture + learning, basic dashboard):** ~1–1.5 engineer-weeks with SurveyJS doing the heavy UI/render lifting.
- **Phase 2 — builder polish (SurveyJS Creator), email distribution, richer analytics:** ~1 week.
- **Phase 3 — parity features only if a client needs them** (file upload, payments via Stripe layer, e-sign).

Hand-rolling the builder instead of SurveyJS adds ~3–5× to Phase 1 for zero strategic gain.

## 8. Risks / things that bite on client-facing

- **PII + compliance.** Client-audience responses may carry PII → RLS, redaction in audit log, retention policy, GDPR delete path. Higher bar than internal.
- **Spam/abuse** on public unauthenticated routes → rate limit + bot guard mandatory (we have the rate-limit primitives).
- **Accessibility + mobile** are non-negotiable client-facing (SurveyJS helps here).
- **SurveyJS Creator license** is a real (small) cost — decide before Phase 2.
- **Scale** if a client blasts a survey to a large list — public route must be cache/edge-friendly and the write path resilient.

## 9. Open decisions (need your call)

1. **SurveyJS Creator license** (~$500–2k/yr) for the drag-drop builder, or start with a minimal field-add UI and defer? 
2. **Where it lives:** Instinct (`wolfpack-apex`) is the natural home given QR + learning already there. Confirm.
3. **Branding:** responder themed as Instinct, per-client, or both?
4. **Migrate existing Cognito surveys**, or only new surveys go through the new system?

---

### Bottom line
Buy the commodity (SurveyJS renderer/builder), build the moat (owned, QR-linked, learning-fed response data), keep Cognito as the fallback for heavy features. That gets a real client-facing survey funnel live in ~1–1.5 weeks without rebuilding a form builder from scratch — and it compounds, which Cognito never will.
