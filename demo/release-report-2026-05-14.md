# Wolfpack Instinct — Release Report 2026-05-14

## TL;DR

Multi-workspace switch shipped (Instinct is now ready to host multiple client tenants without cross-tenant leakage), calendar timeframe parser fixed (weekday names + "Monday of next week" compound phrases), and a same-day production regression that silently killed every general-knowledge AI answer was caught, diagnosed, fixed, and deployed. Today's HEAD is `a8b8def`; Vercel production build live since 22:02:50Z.

## Commits (chronological, this session)

### Features
| SHA | What |
|---|---|
| `db26c93` | Calendar timeframe resolver understands `"Monday"`, `"next Monday"`, `"Monday of next week"`, etc. (also bumps deprecated `actions/cache@v4.0.2` SHA pin). 16 new pinned-date tests. |
| `965f40f` | **Multi-workspace switch.** Migration 137 adds `workspace_id` to `instinct_team_members` and `instinct_invites` (backfilled `default`, FK + index). JWT carries `workspaceId`. Every workspace-scoped route reads `auth.user.workspaceId` from the session — never the request body. Invites grant membership to the *inviter's* workspace at creation; acceptance joins that workspace. 3 isolation tests prove a Blitz admin can't write into Acme's workspace via a spoofed body field. |

### Fixes
| SHA | What |
|---|---|
| `5b3aa6a` | Red Team Governance workflow caller — pass `apply: false` (boolean) not `apply: 'false'` (string) to the reusable workflow at AgenticQA-core. Was causing `startup_failure` on every push touching `src/lib/auth*`. |
| `a8b8def` | **Production regression fix.** Two compounding bugs killed every AI answer for general-knowledge questions: (1) `tryKnowledgeBase` returned top trigram hit with no quality gate — "what is Nurburgring?" loose-matched "what is Morning Briefing?" on ~0.25 sim and served Dashboard content. (2) A1 confidence gate fired `block` for zero-hit answers because `tryBrain` returned `topScore: 0` (number, passed the typeof check). Both fixed; the previously-failing `AI fallback returns source=ai` test is green again. |

## Numbers

| | |
|---|---|
| Tests added | **22** (16 timeframe, 3 isolation, 3 KB-regression) |
| Tests now passing | 8029 (baseline was 8025) |
| Tests now failing | 121 (baseline was 122 — `AI fallback returns source=ai` was sitting red for several commits before today) |
| TS errors | 0 (clean) |
| Migrations | 1 — `137_team_member_workspace_id` |
| Vercel deploys | 1 production deploy at 22:02:50Z on `a8b8def` (deploy id `4694513001`, success) |
| AgenticQA pipeline runs | `25887664714` ✓ on `5b3aa6a`; `25888244275` in-flight on `a8b8def` |

## Codified tooling shipped

- **`KB_MIN_SIMILARITY = 0.45`** quality gate in `src/lib/assistant.ts` — propagates Postgres trigram `sim` through `KnowledgeEntry` and drops any KB hit that's below the threshold. Demo entries (no `sim`) bypass for back-compat.
- **`gateConfidence` no-op on zero hits** in `src/lib/assistant/answer-quality.ts` — fixes the semantic confusion between "no grounding retrieved" (let the LLM answer) and "weak grounding retrieved" (block).
- **`parseWeekdayPhrase` parser** in `src/lib/assistant/timeframe.ts` — single regex covers `<weekday>`, `<this|next|last> <weekday>`, `<weekday> of <this|next|last> week`. Returns `resolved: false` only for genuinely unparseable input.
- **`DEFAULT_WORKSPACE_ID = "default"`** exported from `src/lib/auth.ts` — singleton-tenant fallback for shadow mode + legacy JWTs. Every site that used to hardcode the literal `"default"` now reads from `auth.user.workspaceId` and falls back to this constant only when the session predates migration 137.

## Migrations

- **137** — `workspace_id` column on `instinct_team_members` + `instinct_invites` (backfilled `default`, FK to `instinct_workspace(id)` ON DELETE RESTRICT, hot-path index on `(workspace_id)`). Down migration drops cleanly.

## Outstanding

| Item | Notes |
|---|---|
| AgenticQA full pipeline on `a8b8def` | Run `25888244275` in flight — verify green when finished. |
| 27 pre-existing flaky test suites | Same count as baseline pre-session. Pass in isolation, fail in the chained run — looks like jest-mock state leak. Not blocking today's deploy; blocking the day we promise green-on-every-PR to a client. |
| AgenticQA-core consumer fragility | Today's `startup_failure` on `apply: 'false'` is a class of bug that hits every consumer of the reusable workflow simultaneously. Worth a contract-lint CI check on the AgenticQA-core side, or pinning consumers to release tags rather than SHAs. |
| Eval harness for answer relevance | Stated as the strategic next move in the handoff. Today's regression would have been caught by 5–10 cases of `(question, must-not-cite-X, expected-source=ai)`. |

## Deploy status

- `main` HEAD: `a8b8def`
- Vercel production build: live at https://wolfpack-instinct.vercel.app (auto-deployed)
- Full handoff: [demo/handoff-2026-05-14.md](handoff-2026-05-14.md)
