# Badge polling efficiency pass — 2026-05-01

## Why

Idle dashboard sessions were issuing **~52 requests/min** (3,120/hr per open tab) just from the four sidebar/topbar badges:

| Source | Old interval | Reqs/min |
|---|---|---:|
| `EmailNavBadge` | 5s visible | 12 |
| `MessagesNavBadge` | 5s visible | 12 |
| `TeamsUnreadBadge` | 5s visible | 12 |
| `NewMessageToast` | 5s visible | 12 |
| `NotificationBell` | 30s | 2 |
| `PresenceIndicator` | 30s | 2 |

Three of those badges all polled the **same endpoint** (`/api/ms/chats/unread-count`) independently — paying for the same Microsoft Graph round-trip three times.

## What changed

1. **`useAdaptivePoll` defaults** raised from 5s/45s → 30s/120s, plus a new `idleMs: 180s` that engages once `isStable()` returns true for 5 consecutive polls. Components opt in by passing an `isStable` callback.
2. **`coalescedFetchWithRefresh` wrapper** — concurrent identical GETs within a 1.5s window collapse to one HTTP request. The cached Response is `clone()`'d so each caller can read the body independently.
3. **Component swap** — the four badges now go through `coalescedFetchWithRefresh` instead of `fetchWithRefresh`. Source endpoints are untouched.
4. **Analytics integration** — periodic `system.badge_poll_optimized` events feed the learning loop with `{ requests_served, network_calls, requests_saved }` so we can measure real-world wins.

## Resulting traffic profile (visible idle tab)

- Two unique URLs × ~2 polls/min = **~4 reqs/min** from the four badges (was 48).
- Plus NotificationBell (2/min) + PresenceIndicator (2/min) = **~8 reqs/min total**.
- After 5 stable polls → idle backoff drops the badges to ~1.3 reqs/min → **~5 reqs/min total**.

**~85% reduction** in idle traffic with no UX regression beyond a 30-second worst-case latency on a notification dot.

## Microsoft Graph / Outlook safety

The Microsoft Graph endpoints (`/api/microsoft/messages/unread-count` and `/api/ms/chats/unread-count`) are **not modified**. Same scopes, same auth, same Graph queries, same response shapes. The only change is on the client side: fewer fetches that produce identical results are collapsed.

## Feature flag (rollback)

Set `NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE=false` to disable both coalescing and the new defaults' opt-in stability hint. The badges revert to the per-component direct-fetch behavior. Adaptive-poll defaults are still 30s/120s — to fully revert those, callers need to pass explicit `visibleMs: 5_000` overrides.

| Layer | Rollback |
|---|---|
| Coalesce wrapper | `NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE=false` (Vercel env, instant) |
| `useAdaptivePoll` defaults | `git revert <commit>` — single hook file |
| Component fetch swap | `git revert <commit>` — 4 1-line import swaps |
| Analytics event | New union member only; reverting is purely additive removal |

The full PR is one `git revert` away from baseline. No DB changes, no migrations — there's nothing irreversible.

## Tests

- `src/lib/__tests__/coalesced-fetch.test.ts` — 7 cases: collapse, distinct URLs, non-GET bypass, window expiry, flag disable, error retry, clone independence.
- `src/lib/hooks/__tests__/useAdaptivePoll.test.ts` — 4 new cases on top of the existing 7: idle-backoff engagement, idle-reset on instability, idle-disabled when no `isStable`, new default visibleMs.
- All 4 badge component test suites updated for the new 30s cadence (was 5s) and continue to validate end-to-end behavior with mocked `fetchWithRefresh`.
- Zero regressions in the broader 4,093 baseline test suite.

## Future work (not in this PR)

The right long-term answer is **server-side push**: Microsoft Graph subscriptions → SSE/WebSocket fanout → client receives unread-count deltas instead of polling. That eliminates the polling category entirely (idle traffic → ~0). It's 1–2 days of work and a separate session.

Until then, this PR delivers the biggest win available without architectural change.
