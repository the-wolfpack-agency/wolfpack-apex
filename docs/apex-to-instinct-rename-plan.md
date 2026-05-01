# Apex → Instinct Rename Plan

**Status:** drafted 2026-05-01, not yet executed
**Audit tool:** `scripts/audit-apex-refs.sh`

## Headline answer

**Yes — easy enough to ship in one session.** The hard work was already done on **2026-04-20** (Tier 4 DB rename: 36 `apex_*` tables → `instinct_*`, with backward-compat views still in place). What's left is mostly cosmetic + a one-button GitHub rename.

## Current audit results

| Bucket | File count | Action |
|---|---:|---|
| **IMMUTABLE** — SQL migrations + dated handoffs | 130 | Never touch — historical record |
| **ACTIVE-SCHEMA** — `apex_*` table refs in `src/` | 14 | Find/replace via codemod (compat views absorb mistakes) |
| **ACTIVE-TYPE** — top-level configs + docs | 6 | Edit by hand (small, careful) |
| **COSMETIC** — old handoff docs, etc. | 120 | Skip — historical, low priority |

The 14 active-schema files all hit tables that already have `instinct_*` as the canonical name and `apex_*` as a view. Renaming code that uses `apex_*` is purely a hygiene step; nothing functionally breaks if any is missed.

## Phase plan

### Phase A — Rename the repo + identity (~30 min, fully reversible)

1. **GitHub:** Settings → Rename `the-wolfpack-agency/wolfpack-apex` → `the-wolfpack-agency/wolfpack-instinct`. GitHub auto-redirects every old URL forever.
2. **Local checkout:** `mv /Users/nicholashomyk/mono/wolfpack-apex /Users/nicholashomyk/mono/wolfpack-instinct`.
3. **Remote URL:** `git remote set-url origin https://github.com/the-wolfpack-agency/wolfpack-instinct.git`.
4. **Vercel project:** rename in Vercel dashboard (cosmetic — production URL `wolfpack-instinct.vercel.app` is already correct from the earlier project rename).
5. **`package.json` `"name"`** field: `"wolfpack-apex"` → `"wolfpack-instinct"`.
6. **CLAUDE.md, README.md, SECURITY.md, next.config.ts, playwright.config.ts:** sweep for `wolfpack-apex` / `Apex` / `APEX` strings, replace.
7. **Memory files** under `~/.claude/projects/-Users-nicholashomyk-mono-AgenticQA/memory/` (14 files reference the old name): regex replace `wolfpack-apex` → `wolfpack-instinct`. Memory file *names* don't need to change (they're keyed by topic, not repo).

**Rollback:** GitHub repo rename is reversible (rename back). `mv` is reversible. `git remote set-url` is reversible. The 6 file edits revert via `git revert <commit>`. Memory edits via shell history. Total rollback time: ~5 min.

### Phase B — Sweep `apex_*` table refs in active source (~1 hour)

The 14 active-schema files:

```
src/app/(dashboard)/layout.tsx
src/app/(dashboard)/page.tsx
src/app/(dashboard)/settings/page.tsx
src/app/api/analytics/route.ts
src/app/api/people/documents/route.ts
src/db/seed-knowledge.ts
src/lib/brain/qdrant.ts
src/lib/brief-edit-learning.ts
src/lib/client-auth.ts
src/lib/insights/emit.ts
src/lib/onboarding.ts
src/lib/people.ts
src/lib/qr/scans.ts
src/lib/report-templates.ts
```

For each: replace `apex_<table>` → `instinct_<table>` for every table that has a corresponding rename migration in `src/db/migrations/0??_rename_*.sql`. Run the test suite after.

**Rollback:** compat views stay in place during this phase, so even reverting only the code (without touching DB) is safe. Single revert commit.

### Phase C — Drop the compat views (1 migration, run last)

Once Phase B is green in CI + production for 1 week, write migration `121_drop_apex_compat_views.sql` that `DROP VIEW IF EXISTS apex_<table>;` for each. Pair with a `.down.sql` that recreates them.

**Rollback:** `.down.sql` recreates every view. The Tier-4 rename migrations have already proven this pattern works.

## What stays "Apex" forever

- **SQL migrations 001 – 072** that contain `apex_*` table names. These are historical records of the schema's evolution; rewriting them would corrupt the migration ledger.
- **Dated handoff/release docs** in `demo/handoff-2026-MM-DD.md` and `demo/release-report-2026-MM-DD.md`. These are sealed time-capsules of past sessions.
- **Down-migrations of the Tier-4 renames** — they intentionally reference `apex_*` as the rollback target.

## Per-bucket rollback summary

| Bucket | Rollback mechanism | Time |
|---|---|---|
| GitHub rename | Rename back (auto-redirects keep working) | 30s |
| Local `mv` | `mv` back | 5s |
| `git remote set-url` | Set back to old URL | 5s |
| Phase A file edits | `git revert <commit>` | 1m |
| Phase B code sweep | `git revert <commit>` | 1m |
| Phase C view drops | `migrations/121_*.down.sql` | 30s |
| Memory file edits | Manual restore from shell history | 5m |

**Critical safety property:** at every phase transition, the system is fully functional with both names. Compat views ensure DB code works whether it uses `apex_*` or `instinct_*`. GitHub redirects ensure URLs work whether they use `wolfpack-apex` or `wolfpack-instinct`. There is no point in the plan where rolling back loses data or breaks production.

## Recommendation

Ship Phase A as one PR (1 hour). Defer Phase B until next week (low-priority hygiene). Schedule Phase C 1 week after Phase B is green. This is the same rhythm as the Tier 1–4 platform rename in `feedback_platform_rename.md`.
