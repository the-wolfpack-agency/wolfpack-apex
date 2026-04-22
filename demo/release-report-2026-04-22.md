# Wolfpack Instinct — Release Report 2026-04-22

**HEAD:** `5579903` | **Deployed:** https://wolfpack-instinct.vercel.app | **Repo:** the-wolfpack-agency/wolfpack-apex

## Summary
14 commits. CEO dashboard bug-bash (welcome banner / activity feed / assistant accuracy) + Knowledge Base end-to-end (save, retrieve, edit, delete, paginate) + Azure provider scaffolding (19 files, 4012 LOC, 97 tests) so the Entra-aligned migration is an env-flag flip.

## By surface
| Surface | Fixes |
|---|---|
| Pre-brief / mail | `48e81a6` scrub MS Graph noise |
| Dashboard | `9b307ed` welcome banner, `4536c07` Recent Activity filter |
| Assistant | `a209746` ctx user id, `a4ea0a2` timezone, `973c8e3` intent router, `6874bc3` scroll jump, `2ce89ab` knowledge retrieval |
| Knowledge | `285ee1d` save, `b68a464` edit/delete + re-triple-write, `b578106` recent-first default, `fea15e0` pagination + Load more |
| Integrations / Auth | `0d408dd` MS disconnect, `5579903` login rate limit |
| Infra | `81c7a25` Azure RAG scaffolding (AI Search + AGE + dual-write) |

## Test counts
- `rag-providers`: 7 suites / 97 tests green
- Knowledge: 6 suites / 59 tests green
- Assistant: 7 suites / 64 tests green

## Data + learning
- 23 new `rag.*` analytics events registered (`vector_*`, `graph_*`, `embedding_*`, `dual_write_*`, `dual_read_divergence`, `provider_fallback_triggered`).
- 5 new `knowledge.*` events (`entry_created`, `entry_updated`, `entry_deleted`, `entry_updated_offline`, `entry_deleted_offline`, `entry_edit_clicked`, `entry_delete_clicked`).
- Triple-write fires on create AND update — vector + graph indexes stay in sync with corrections.

## Out-of-band operational
- CTO + CEO prod password rotated (direct DB UPDATE). Team no longer has passive access via the old `apex` demo password.

## Next
Handoff: `demo/handoff-2026-04-22.md` — see "Open threads" section. Top three: Entra SSO migration, team-size banner gate, Azure provider flip.
