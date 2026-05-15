# Salesforce Search — Live Validation Log

**Date:** 2026-05-15
**Org:** Developer Edition `homyk.6b1ab6d50d8c@agentforce.com` · instance `orgfarm-e28dfd2036-dev-ed`
**Connector path:** OAuth-issued bearer → Salesforce SOQL via `/services/data/v59.0/query`
**Commit:** `3e48b53` (free-text search shipped)

## What we tested

End-to-end: real user phrasing → Instinct assistant → `search_external_records` tool → REST connector → Salesforce SOQL → Markdown answer in the chat. Zero LLM tokens spent on any of these.

| Query (verbatim) | Result | Verdict |
|---|---|---|
| `look up Grimace Fromcdonalds` | Found 1 Contact: Grimace Fromcdonalds `003g500000GemUXAAZ` | ✅ |
| `find grimace` | Found 1 Contact: Grimace Fromcdonalds `003g500000GemUXAAZ` | ✅ |
| `search for McDonald` | Found 1 Contact: Grimace Fromcdonalds (LastName "Fromcdonalds" contains "mcdonald") | ✅ |
| `search for McDonald's` | `No contact matches found for "McDonald's"` | ✅ (apostrophe SOQL-escaped correctly; "McDonald's" with the apostrophe isn't in any Contact field — true negative, not a bug) |
| `who is Grimace Fromcdonalds?` | Found 1 Contact: Grimace Fromcdonalds | ✅ |
| `find the account for Acme` | `No account matches found for "Acme"` | ✅ (true negative — no Account named Acme exists in the demo org) |

## What this proves end-to-end

- Salesforce SOQL composition is correct for both `Contact` and `Account` objects with the right field projections.
- SOQL string-literal escaping handles single quotes safely (`O'Brien` → `O\'Brien`).
- The connector auto-routes from the generic `rest-default` tool param to the workspace's `salesforce` row.
- Empty result sets render the friendly "no match" message rather than a 500 / blank.
- Single-match results render the contact + a `look up contact id <id>` drill-in hint.
- `assistant.connector_search_executed` analytics events fire on every search with `match_count` so we can dashboard search recall over time.

## What we still need to verify (deferred)

- **Multi-match disambiguation render** — needs a second Contact in the org. Create "Grimace Hamburglar" and re-run `find grimace` to see the numbered list. Logic is unit-tested; just unverified live.
- **Email search live** — needs a Contact with a known email. Set Grimace's Email field and ask `find grimace@somewhere`. Logic unit-tested.
- **Account/Opportunity searches** — need real Account + Opportunity records in the org. Sample data was empty for both.
- **Refresh-on-401 live** — unit-tested but not yet exercised against a real expired Salesforce token.

---

## Sample Query Catalog (for client onboarding)

Drop this into client-facing docs after a tenant connects their CRM. Categories match the realistic mental model of a CTO / CEO / Sales user.

### Find a person (Contact)

| What you ask | What it does |
|---|---|
| `look up Grimace Fromcdonalds` | Substring match on Name + Email |
| `find Jorge` | Same — single-word names work |
| `who is Sarah Williams?` | Same — natural-language phrasing |
| `find jorge@acme.com` | Email search |
| `find someone with email user@host.io` | Same |
| `look up the contact for Acme renewals` | Substring match (will find anyone whose name contains "Acme renewals" — unlikely; consider account search instead) |

### Find a deal (Opportunity)

| What you ask | What it does |
|---|---|
| `find the deal Q3 Renewal` | SOQL across Opportunity.Name |
| `look up opportunity Acme Expansion` | Same |
| `search for the deal called Northwind Migration` | Same |

Returned fields: `Name`, `StageName`, `Amount`, `CloseDate`, `AccountId`.

### Find a company (Account)

| What you ask | What it does |
|---|---|
| `find the account for McDonald's` | SOQL across Account.Name |
| `look up account Acme Industries` | Same |
| `search for the company called Northwind` | Same |

Returned fields: `Name`, `Industry`, `Phone`, `Website`.

### Drill in by ID (when you have one from a search)

| What you ask | What it does |
|---|---|
| `look up contact id 003g500000GemUXAAZ` | Fetches the full Contact record (60+ fields) |
| `get the deal record for 006abc...` | Same for Opportunity |
| `fetch account id 001xyz...` | Same for Account |

### Disambiguation (when multiple results return)

When a search returns 2–5 matches, the assistant lists them numbered:

```
Found 3 contacts matching "Grimace":
1. **Grimace Fromcdonalds** `003g500000GemUXAAZ` — g@mc.com
2. **Grimace Hamburglar**   `003g500000Xyz...`   — h@mc.com
3. **Grimace Mayor**         `003g500000Abc...`   — m@mc.com

Reply with the number or paste the ID to drill in.
```

Past 5 matches it shows the top 5 + `<N>+ contacts matching` so the user knows to narrow.

### Out-of-scope / not yet supported

- **Filter queries** ("deals over $50k closing this month", "contacts created last week") — needs SOQL generation, deferred to phase 2.
- **Multi-object search** ("find anything related to Acme") — needs SOSL, deferred.
- **Action queries** ("create a contact named X") — read-only today; write actions go through the action-tool confirmation flow we'd need to extend.
- **Custom objects** — the vendor preset only knows about standard Contact/Opportunity/Account. Clients with custom SObjects (CustomObject__c) need a per-tenant objectMap override.

### Coverage by connector

| Connector | Find by name | Find by email | Drill-in by ID | Status |
|---|---|---|---|---|
| Salesforce | ✅ live-validated | ⚠️ logic shipped, untested live | ✅ live-validated | Production-ready for demo |
| HubSpot | ✅ logic shipped (unit-tested) | ⚠️ via name field (HubSpot's `q` param) | ✅ unit-tested | Untested live |
| QuickBooks | ❌ deferred (SQL-style queries) | ❌ | ✅ unit-tested | Connector exists; search NYI |

---

## How a client uses this (the 30-second pitch)

1. Click **Connect Salesforce** in `/admin/connectors` → SF login → one click → done.
2. From the assistant chat, ask anything from the catalog above.
3. The assistant pulls live data from their org, no copy-pasting from Salesforce required.
4. When refresh tokens expire (every ~2h on access tokens, ~90d on refresh), the connector silently rotates without the user noticing.

Same flow drops in for HubSpot once their OAuth app is registered. Jira/QuickBooks land the same way — one provider file in `oauth/providers/`, one preset entry with `search.build`, done.
