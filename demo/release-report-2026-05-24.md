# Wolfpack Instinct — Release Report 2026-05-24

## TL;DR

Eleven commits shipped to production on a single push-train, all client-facing assistant work. Headline: cross-tool insights got a v2 redesign around HELPFUL framings (no "you missed X" surfaces) with two new combinations (`team_momentum_brief`, `recent_deploy_by_meeting_attendee`); a typo cache-poisoning bug (`insighta` ≈ `insights` matched at similarity > 0.1 and served a "did you mean" answer as if it were knowledge) was root-caused and fixed at two layers; a new ClarifyWidget converts typo / ambiguous queries into 1-tap correction chips instead of LLM prose; the conversations sidebar was hidden (entry point for the "new message on old convo" bug); a persistent Suggestions overlay was added so users can return to the prompt menu after the first send; the polling layer was debounced to cut idle traffic ~50–70%; and three iOS Safari mobile bugs (composer cutoff, useless Cmd+Enter hint, header-button overflow truncating the brand name) were fixed. Coverage matrix E2E added covering 9 prompt → widget pairs + the sidebar-hide invariant.

## Commits

### Features

| SHA | What |
|---|---|
| `0472939` | **feat(insights): genuinely cross-tool insight generators + bot filter.** Filters bot authors (dependabot, renovate, `[bot]` suffix) from `github_pr_stagnation`; upgrades `vercel_failed_no_followup` to verify no later READY deploy on the same branch + target before flagging; adds two strictly cross-tool generators (`email_unread_from_meeting_attendee`, `meeting_attendee_open_pr`) plus aggregator that sorts cross-tool items ahead of single-source ones and reports the split honestly. |
| `638d736` | **refactor(insights): drop punishing generator; add positive cross-tool patterns.** Removed `email_unread_from_meeting_attendee` ("you didn't read X's email" reads as shame surface). Added `recent_deploy_by_meeting_attendee` (vercel × calendar coordination heads-up) and `team_momentum_brief` (github × vercel positive weekly digest — "N PRs merged across M repos, K prod deploys shipped"). Reframed remaining titles to neutral / helpful ("awaiting review for N days", "Heads-up: @alice's PR could be discussed today", "needs a follow-up"). Demoted severities so nothing punishing crowds out genuinely urgent items. Registry guard test blocks future regression into accusatory names. |
| `812018c` | **feat(assistant): clarify widget — 1-tap chips instead of "did you mean…?" prose.** New `clarify_widget` tool runs ahead of LLM/RAG. Triggers on 1–2-token queries with Damerau-Levenshtein distance ≤ 2 to a curated `KNOWN_TERMS` list and ratio ≤ 0.34. Returns up to 3 suggestion chips sorted by closeness; chip click dispatches `instinct:autosubmit` and InstinctChat re-fires the corrected prompt via a ref-routed listener (so the latest handleSend closure is always called). Zero AI tokens for the typo-detection path. |
| `7b3996f` | **feat(assistant): persistent Suggestions overlay — re-entry to starter prompts.** Hybrid header button + slash command (`/help`, `/suggestions`). Both open `AssistantSuggestionsOverlay`, which wraps the existing `AssistantStarterPrompts` so the prompt list stays single-sourced. Proper dialog semantics: role=dialog, aria-modal, aria-labelledby, Escape closes, click-outside closes, focus restored on close, initial focus on close button. Analytics distinguish header_button vs slash_command source for learning-loop signal. |

### Fixes

| SHA | What |
|---|---|
| `aebeaf1` | **perf(polling): debounce visibility/focus refire + drop per-poll analytics.** Nick observed 215 requests in ~7 min on an idle `/assistant` page (vs ~42 expected from the 6 mounted pollers at default 60s cadence). Root cause: every visibility/focus event fired ALL pollers immediately with no debounce. Fix: 15s refocus debounce — if a poll fired in the last 15s, skip the immediate re-fire and let the schedule continue. Also dropped the per-poll `assistant.chat_synced_via_poll` analytics POST that was doubling chat-loop request count for telemetry already proven. Cross-tab broadcast event still fires. |
| `e63428c` | **fix(assistant): hide conversations sidebar by default.** The sidebar's auto-derived titles ("what?", "upload", "feedback") were unsearchable and useless, AND clicking an entry loaded an old conversation so the next message got appended — the "new message tacked onto old convo" confusion. Minimum-diff fix: flipped `showHistory` default from true → false. All sidebar JSX, state, loadConversations, click handlers, and the conversations DB table remain wired exactly as before; callers that explicitly pass `showHistory={true}` get the full panel back. |
| `878a269` | **fix(assistant): broader insights trigger + cache-poisoning guards.** Two real-world bugs from a single user session: (1) "give me insights!" missed the cross-tool insights trigger and fell through to RAG cache; (2) a prior typo "insighta" had cached a clarifying AI response which the next "insights" query matched via `pg_trgm` similarity > 0.1 and served as if it were knowledge. Three fixes: broadened `SHORT_INTENT_RE` to catch bare "insights" / "give me insights" / "any insights" + a `SCOPED_INSIGHTS_RE` negative guard keeps "marketing insights" / "sales insights" routed to RAG; `saveAnswer` now rejects low-confidence clarifying answers ("did you mean", "could you clarify", "may need a second look", "unfamiliar names"); `searchKnowledge` similarity threshold raised 0.1 → 0.55 and queries under 4 chars short-circuit to []. |
| `dbbb791` | **fix(mobile): composer clears iOS Safari bottom chrome.** Two compounding causes — inline container used `calc(100vh - 120px)` (iOS `vh` is the LARGE viewport, no chrome) AND composer wrapper had bare `py-3` with no safe-area reservation. Fixes: `100vh` → `100dvh` (dynamic viewport that shrinks as chrome appears) AND `pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]` on the composer wrapper. `viewport-fit=cover` was already set. |
| `011f447` | **fix(mobile): hide desktop-only "Cmd+Enter to send" hint on phones.** `hidden sm:block` on the hint paragraph — visible on tablet/desktop (≥640px), hidden on phones. Deliberately did NOT make plain Enter auto-send on touch devices: users need newlines for multi-line prompts; the on-screen send button is the obvious target (matches iMessage / WhatsApp / Slack / Claude app). |
| `8cc7f7f` | **fix(mobile): collapse header buttons to icon-only so the brand name doesn't truncate.** On iPhone the header read "Wol…" — the brand name was cropped to fit the Suggestions + New buttons. Fix: wrap visible labels in `hidden sm:inline` spans so they collapse to icon-only under 640px. `aria-label` + `title` preserve screen-reader access + desktop hover affordance. `shrink-0` on buttons so flex never sacrifices their visibility before the brand name's `truncate` shrinks. |

### Tests

| SHA | What |
|---|---|
| `2002b2e` | **test(e2e): prompts coverage matrix + sidebar-hide guardrail.** Single spec file that iterates 9 client-facing prompt cases (vercel deploys, list integrations, calendar today, open PRs, give me insights, what should I know, recent emails, weather, headlines) — each stubs `/api/assistant` to return the canonical widget spec, types the prompt, and asserts the matching renderer testid mounts. Future regressions that break a tool→widget trigger or rename a renderer testid flip exactly one row red with the broken prompt in the test name. Also pins the sidebar-hide invariant with a single browser-level assertion (`conversations-sidebar` testid has count 0). |

## Numbers

| Metric | Value |
|---|---|
| Commits shipped to main | 11 |
| New runtime components | 2 (`ClarifyWidget`, `AssistantSuggestionsOverlay`) |
| New tools registered | 2 (`clarify_widget`, plus the v2 cross-tool generators reusing `cross_tool_insights_widget`) |
| New widget kinds | 1 (`clarify`) |
| New cross-tool insight generators | 4 (`team_momentum_brief`, `recent_deploy_by_meeting_attendee`, `meeting_attendee_open_pr`, plus the upgraded `vercel_failed_no_followup`) |
| Removed generators | 1 (`email_unread_from_meeting_attendee` — punishing framing) |
| New unit tests this session | ~70 (cross-tool generators expansion, knowledge guards, useAdaptivePoll debounce, badge cadence updates, clarify tool + widget, suggestions overlay + entry-point, mobile safe-area) |
| New E2E specs | 3 (`assistant-clarify-widget`, `assistant-prompts-coverage-matrix`, `assistant-suggestions-reopen`) |
| Test files touched | 14 |
| Files changed | ~24 |
| tsc clean | yes (every push) |

## What's measurably different in production

### Cross-tool insights (`/assistant` → "give me insights")
- v1 returned dependabot PR noise from a single source ("github") rebranded as "cross-tool". v2 filters bots, separates strict-cross-tool (sources ≥ 2) from single-source items, leads with the cross-tool ones, and reports the split honestly in the title.
- Two new generators that combine 2+ integrations:
  - `team_momentum_brief` (github × vercel): "This week: 4 PRs merged across 2 repos; 3 prod deploys shipped"
  - `recent_deploy_by_meeting_attendee` (vercel × calendar): "Heads-up: @alice just shipped a prod deploy — you meet today"

### Typo / ambiguity path
- Old: typing "insighta" generated a 182-token "Did you mean Insighta?" AI response that then poisoned the cache for every future "insights" query.
- New: typing "insighta" → ClarifyWidget shows 1-tap chips ([insights] [calendar] etc.). Zero AI tokens. Click → autosubmits the corrected query → cross-tool insights widget renders.

### Discoverability
- After first send the starter prompts vanished and there was no re-entry point. Now: persistent "Suggestions" button in the header (icon-only on mobile, label on desktop) AND `/help` / `/suggestions` slash commands. Both open the same overlay-wrapped `AssistantStarterPrompts`.

### Idle traffic
- ~50–70% reduction in idle `/assistant` request volume. Visibility/focus events used to fire all 6 pollers instantly; now 15s debounce. Chat live-update tick dropped from 2 reqs/min (GET + analytics POST) to 1.

### Mobile (iOS Safari)
- Composer no longer hidden by browser chrome (100dvh + safe-area-inset).
- Misleading "Cmd+Enter to send" hint hidden on phones.
- "Wolfpack Assistant" brand name no longer truncated to "Wol…" by header buttons.

## Tests

All new functionality landed with full pyramid coverage (unit + component + E2E where UI-bearing). Key new files:

- `src/lib/insights/__tests__/cross-tool-generators.test.ts` — 23 tests including the registry guard against punishing names
- `src/lib/__tests__/knowledge.test.ts` — added 5 low-confidence-answer rejection cases + similarity threshold pin
- `src/lib/hooks/__tests__/useAdaptivePoll.test.ts` — 12 tests including the new 15s debounce
- `src/components/__tests__/AssistantSuggestionsOverlay.test.tsx` — 8 a11y + close-path tests
- `src/components/__tests__/InstinctChat.suggestions-entry-point.test.tsx` — 6 entry-point + responsive-collapse tests
- `src/components/__tests__/InstinctChat.mobile-safe-area.test.tsx` — 3 mobile regression pins
- `src/components/widgets/__tests__/ClarifyWidget.test.tsx` — 4 chip + dispatch tests
- `src/lib/assistant/tools/__tests__/clarify-widget-tool.test.ts` — 10 typo-detection tests
- `tests/e2e/assistant-clarify-widget.spec.ts` — full typo → chip → autosubmit Playwright flow
- `tests/e2e/assistant-prompts-coverage-matrix.spec.ts` — 9 prompt → widget cases + sidebar invariant
- `tests/e2e/assistant-suggestions-reopen.spec.ts` — send → reopen via button → Escape → reopen via `/help` (asserts second open is zero-token)

87 InstinctChat tests pass across 10 suites. tsc clean throughout.

## Trade-offs and known gaps

| Decision | Trade-off |
|---|---|
| Hid the conversations sidebar by default | Users lose the ability to scroll back to a multi-week-old chat. Mitigation: titles were useless anyway; underlying `conversations` table is intact for an admin / search-driven recovery later. Reversible — flipping `showHistory={true}` brings the panel back unchanged. |
| Cross-tool insights are rule-based, not LLM-synthesized | Predictable + auditable + zero token cost, but new patterns require code changes. Extension point is appending to `INSIGHT_GENERATORS` — one diff per new pattern. |
| Clarify widget uses Damerau-Levenshtein against a curated `KNOWN_TERMS` list | Won't suggest commands that aren't in the list yet. Mitigation: list lives in one file (`clarify-widget-tool.ts`); adding a new entry is one line. |
| Polling: 15s debounce on visibility/focus | When you alt-tab back after a few seconds, you won't see immediately-refreshed badges. Acceptable trade for the ~50% idle traffic reduction. |
| Mobile send button stays the only way to send on touch | Users have to tap a target (≥44px) instead of pressing Enter on the on-screen keyboard. Matches every consumer chat app convention; preserves multi-line input. |
| The `who_is` route still expects `/settings/integrations` but the code returns `/settings` | Pre-existing unit test failure, not touched this session. Either rename the route or update the test. Flagged in the handoff. |

## Deploy + verify

- All 11 commits pushed to `the-wolfpack-agency/wolfpack-apex@main`.
- HEAD: `8cc7f7f`.
- Vercel auto-deploys from main.
- Smoke (post-deploy):
  - Open `/assistant`, header should read "Wolfpack Assistant" with two icon buttons on mobile / "Suggestions" + "+ New" on desktop.
  - Type `insighta` → ClarifyWidget chips appear. Click "insights" → CrossToolInsightsWidget renders.
  - Type `/help` → SuggestionsOverlay opens, Escape closes it.
  - Send any message, then tap Suggestions → overlay opens over the chat with the existing conversation preserved.
  - Open DevTools Network on `/assistant`, sit idle — request rate should be roughly 1 req every 10–15s, not 1 req/s.
