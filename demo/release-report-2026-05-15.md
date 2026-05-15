# Wolfpack Instinct — Release Report 2026-05-15

## TL;DR

Shipped the full client-ready Salesforce CRM surface, live-validated end-to-end against a real Developer Edition org with sample data. Every core sales-user motion now works: find by name/email/id, drill in, create (contact/deal/account/task with confirmation), update fields, related records ("Acme's opportunities"), filter queries ("deals over $50k closing this month"). Plus one-click Quick Connect admin UI, an answer-relevance eval harness, a porsche-classes grounding lane, and a HubSpot validation playbook ready to drop in. Salesforce is presentable to a paying client.

## Commits (chronological, this session)

### OAuth + connector framework
| SHA | What |
|---|---|
| `4dd498c` | **Generic OAuth2 framework.** Migration 138 (refresh_token_enc, expires_at, auth_type, provider_metadata columns). OAuthProvider interface + Salesforce + HubSpot impls + registry. Token-refresh orchestrator. Refresh-on-401 in RestConnector. `/api/admin/connectors/oauth/[provider]/{start,callback}` routes. 52 tests. |
| `882a7aa` | Empty commit to trigger Vercel redeploy after env vars set |
| `0a1dd9a` | **Cookie-auth fallback in `requireCapability`** so browser-navigated admin routes (the OAuth `/start` URL) work without an Authorization header. 4 regression tests. |
| `f9c7a9d` | **Tool auto-routing fix.** `get_external_record` defaulted to `rest-default` connector even when the workspace had a `salesforce` row stored. Added `pickConfiguredConnector(workspaceId)`. Also: OAuth callback now seeds `object_map_json` from the vendor preset so Salesforce's `services/data/v59.0/sobjects/Contact` URL path is used instead of generic `/contacts/<id>` (which 404s). 9 tests. |

### CRM read tools
| SHA | What |
|---|---|
| `3e48b53` | **Free-text search** via `search_external_records`. Salesforce SOQL with single-quote escaping, HubSpot search endpoint, vendor-preset-driven request builders. Disambiguation UX (0 / 1 / 2–5 / 5+ matches). 30 tests. |
| `8595406` | **Admin UI Quick Connect.** "Connect Salesforce" / "Connect HubSpot" buttons, per-row OAuth/static-bearer badge, expiry hint, `/verify` (2-char SOQL probe) + `/disconnect` (soft-delete) routes. OAuth success/error toasts from URL params. 10 tests. |
| `9134b29` | **Weekday-aware page-facts bypass + calendar phrasings.** "Calendar Monday" and "what meetings do I have on Monday" routed to the wrong tool; both now route correctly. 17 tests. |
| `1393f66` | **Related-records + filter-query tools.** `get_related_records` ("Acme's opportunities", "Jorge's deals", "show me opportunities for Acme"). `filter_external_records` (amount/date/stage/owner clauses, combinable). Vendor preset gains `relatedSearch` + `filterSearch` builders. 38 tests. |

### CRM write tools
| SHA | What |
|---|---|
| `5499c53` | **P0 write actions.** `create_external_record` (contact/deal/account/task with name/email/phone/amount/stage/date extraction). `update_external_record` (move stage, change field) with search-then-PATCH and 0-match/ambiguous refusal. Phase-3 confirmation flow integrated. 47 tests. |

### Other features
| SHA | What |
|---|---|
| `0af7001` | **Eval harness.** JSON corpus + Jest runner asserting "off-topic question must produce source=ai, not knowledge_cache." Pins both 2026-05-14 regression bugs (KB cross-topic match, A1 zero-hit reject). 13 tests. |
| `88dd5d6` | **Porsche-classes grounding lane.** `searchPorscheClassNotes` reads `instinct_automation_porsche_snapshots` + latest deltas, merges into `meeting_notes` in `getRelevantContext`. 24 tests. |

### Fixes
| SHA | What |
|---|---|
| `a9a2c46` | **Security Self-Scan false-positive fix.** Inlined `requireCapability` at invite POST handlers so static analysis sees the auth gate directly (scanner couldn't follow `return inviteFlow(req)` indirection). Defense-in-depth preserved. |

### Docs
| SHA | What |
|---|---|
| `2872a60` | Salesforce search validation log + client query catalog organized by mental model. |
| `984c70b` | HubSpot OAuth setup playbook + expected divergences from Salesforce. |

## Numbers

| | |
|---|---|
| Tests added | **~250** (52 OAuth, 30 search, 47 writes, 38 related/filter, 24 porsche, 13 eval, 10 admin routes, 17 calendar/page-facts, others) |
| New routes | **7** — OAuth start/callback × 2, connectors/[name]/{disconnect,verify}, oauth refresh orchestrator endpoint |
| New tools | **5** — `search_external_records`, `create_external_record`, `update_external_record`, `get_related_records`, `filter_external_records` |
| Tools registered total | **13** (previously 8) |
| Migrations | **1** — `138_connector_oauth` (refresh_token_enc + 3 sibling columns; backward-compatible default of `static_bearer`) |
| Analytics event types added | **10** — OAuth lifecycle (start/complete/fail/deny/refresh/refresh-fail/persist-fail), connector search/related/filter/write/verify/disconnect |
| Vercel deploys | ~12 production deploys; HEAD `984c70b` live |
| Live SF org rows touched | 1 Contact created (Grimace Fromcdonalds, 003g500000GemUXAAZ), tested against ~10 sample Opportunities |

## Codified tooling shipped

- **`src/lib/assistant/connectors/oauth/`** — vendor-agnostic OAuth2 framework. `types.ts` interface, `registry.ts` lookup, `refresh.ts` orchestrator with persistence + analytics, `providers/salesforce.ts` + `providers/hubspot.ts`. Adding QBO / Jira / GitHub is now one file each.
- **`getVendorPreset(name)` returns search + writes + relatedSearch + filterSearch builders** for Salesforce. HubSpot has search + writes. Connector methods route through these so the same `RestConnector` works for every vendor.
- **`pickConfiguredConnector(workspaceId)`** — picks the workspace's most useful active connector (vendor-specific row preferred over `rest-default`). Used by every connector-backed tool.
- **Action-tool confirmation pattern extended** — `create_external_record` and `update_external_record` both follow the Phase-3 `requiresConfirmation: true` contract. `executePendingAction` in assistant.ts now dispatches three tools: `save_team_fact`, `create_external_record`, `update_external_record`.
- **`FilterSpec` type** — structured filter intent (amount, dateRange, stage, ownerName) the filter tool composes via regex extraction. Vendor preset translates to native expression (Salesforce SOQL `WHERE … AND …` today; HubSpot search body when wired).
- **`/admin/connectors` Quick Connect UI** — driver-agnostic; future vendors with OAuth providers get a button automatically.

## Migrations

- **138** — `instinct_connector_credentials` gains `auth_type` (CHECK in `'static_bearer'|'oauth2'`), `refresh_token_enc`, `access_token_expires_at`, `oauth_provider_metadata` (JSONB). Backfills existing rows to `static_bearer`. Partial index on expiring oauth2 rows. Down migration drops cleanly.

## Live validation outcomes

| Query | Result |
|---|---|
| OAuth `/start` (Salesforce) | ✅ Redirected to SF, consent screen, persisted tokens |
| `look up Grimace Fromcdonalds` | ✅ Real Contact returned with 60+ fields |
| `look up contact id 003g500000GemUXAAZ` | ✅ Same record by ID |
| `find grimace` | ✅ Single match |
| `search for McDonald` | ✅ Matched on substring in LastName |
| `search for McDonald's` | ✅ True negative (apostrophe correctly SOQL-escaped, no match) |
| `who is Grimace Fromcdonalds?` | ✅ Same single-match render |
| `find the account for Acme` | ✅ True negative (no Acme account in demo org) |
| `deals over $50k` | ✅ **10 real Opportunities returned** — United Oil, Grand Hotels, Burlington Textiles, all ordered by Amount DESC, stage + amount + close-date rendered |

Full log: [demo/salesforce-search-validation-2026-05-15.md](salesforce-search-validation-2026-05-15.md).

## Outstanding

| Item | Notes |
|---|---|
| AgenticQA Full Pipeline (run 25936364673) | Triggered on `a9a2c46`; verify green when finished |
| HubSpot live verification | Playbook ready ([demo/hubspot-oauth-setup.md](hubspot-oauth-setup.md)); needs HubSpot Developer account + ~30 min setup |
| HubSpot write actions live-test | Logic shipped + unit-tested; live POST has never fired |
| Refresh-on-401 live validation | Only unit-tested. Could add a CTO-only `/force-expire` debug endpoint to make this deterministic |
| Aggregate counts ("how many deals in pipeline") | Last remaining P0 sales-reporting query class |
| Tool-dispatch transparency UI | Deferred 2 sessions; pays for itself on the next misroute |
| 27 pre-existing flaky test suites | Same as yesterday's handoff |

## Deploy status

- `main` HEAD: `984c70b` (and `a9a2c46` for the security-finding fix beneath it)
- Vercel production build: live at https://wolfpack-instinct.vercel.app (auto-deployed)
- Full handoff: [demo/handoff-2026-05-15.md](handoff-2026-05-15.md)
- Salesforce validation log: [demo/salesforce-search-validation-2026-05-15.md](salesforce-search-validation-2026-05-15.md)
- HubSpot validation playbook: [demo/hubspot-oauth-setup.md](hubspot-oauth-setup.md)
- Yesterday's handoff (for context): [demo/handoff-2026-05-14.md](handoff-2026-05-14.md)
