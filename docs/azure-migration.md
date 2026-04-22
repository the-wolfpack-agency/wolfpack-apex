# Azure RAG Migration Plan

Optional, opt-in migration path from the default Qdrant + Neo4j + OpenAI
RAG stack to an Azure-native stack (AI Search + Apache AGE or Cosmos
Gremlin + Azure OpenAI). This document is the operational runbook for
executing the migration safely via the dual-write orchestrator at
`src/lib/rag-providers/dual-write.ts`.

**This migration is optional per deployment.** The default
`INSTINCT_VECTOR_PROVIDER=qdrant` and `INSTINCT_GRAPH_PROVIDER=neo4j`
path stays the canonical self-host configuration. Azure is a target for
regulated deployments that require cloud-native, FedRAMP-aligned
infrastructure.

## Invariants

Anchored by the AgenticQA memory invariants — see `.agenticqa/memory/`
and the global engineering directive. The migration MUST preserve:

1. **Triple-write integrity.** Every analytics/audit event still lands
   in Postgres. The RAG swap affects only the vector + graph backends.
2. **Multi-tenant hard boundary.** `tenantId` is never optional. Adapters
   MUST refuse cross-tenant reads/writes and the dual-writer MUST NOT
   collapse tenants.
3. **No silent data loss.** `INSTINCT_VECTOR_PROVIDER=dual` without full
   Azure credentials throws at boot (see `config.ts`). There is no
   half-configured mode.
4. **Zero-tokens first.** The migration must not regress RAG hit rate
   below the 30-day Qdrant baseline captured pre-migration.
5. **`npm run verify` is the gate.** Every phase transition requires
   the full suite (lint + tsc + jest + E2E) green against the deployed
   URL — not just a local run.

## Provider map

| Current (default) | Target (Azure)            | Abstraction                   |
|-------------------|---------------------------|-------------------------------|
| Qdrant            | Azure AI Search           | `VectorStore` (types.ts)      |
| Neo4j             | Apache AGE on Postgres    | `GraphStore` (types.ts)       |
| (alt graph)       | Cosmos DB Gremlin API     | `GraphStore` (same interface) |
| OpenAI embeddings | Azure OpenAI embeddings   | `EmbeddingProvider`           |

AGE is preferred for the graph side because it lets us keep Postgres as
the single operational database. Cosmos Gremlin is the alternative for
deployments that need multi-region active-active graph replication.

## Env flag cheat sheet

Set by `src/lib/rag-providers/config.ts`:

| Variable                                | Values                                      | Default   |
|-----------------------------------------|---------------------------------------------|-----------|
| `INSTINCT_VECTOR_PROVIDER`              | `qdrant` \| `azure_ai_search` \| `dual`     | `qdrant`  |
| `INSTINCT_GRAPH_PROVIDER`               | `neo4j` \| `age` \| `dual`                  | `neo4j`   |
| `INSTINCT_EMBEDDING_PROVIDER`           | `openai` \| `azure_openai`                  | `openai`  |
| `AZURE_AI_SEARCH_ENDPOINT`              | URL                                         | —         |
| `AZURE_AI_SEARCH_API_KEY`               | string                                      | —         |
| `AZURE_AI_SEARCH_INDEX`                 | string                                      | —         |
| `AZURE_AI_SEARCH_API_VERSION`           | string                                      | `2024-07-01` |
| `AZURE_OPENAI_ENDPOINT`                 | URL                                         | —         |
| `AZURE_OPENAI_API_KEY`                  | string                                      | —         |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`     | string                                      | —         |
| `AZURE_OPENAI_API_VERSION`              | string                                      | `2024-02-01` |
| `DATABASE_URL`                          | Postgres URL (required for AGE)             | —         |
| `INSTINCT_DUAL_MODE`                    | `primary_only` \| `shadow` \| `compare` \| `both` | `primary_only` |

Selecting Azure or `dual` without the corresponding credentials is a
boot-fatal error (see `loadAzureAiSearchConfig` / `loadAzureOpenAIConfig`).
That is deliberate — a silently half-configured dual-write is how data
gets silently dropped.

## Dual-write modes (orchestrator)

Defined in `src/lib/rag-providers/dual-write.ts`:

| Mode           | Writes            | Reads                                | Divergence events                      | When to use                         |
|----------------|-------------------|--------------------------------------|----------------------------------------|-------------------------------------|
| `primary_only` | primary only      | primary only                         | none                                   | Steady-state (before + after migration) |
| `shadow`       | both (parallel)   | primary returned, secondary compared | only when id-set diff non-empty        | Phase 1: grade the new store quietly |
| `compare`      | both (parallel)   | primary returned, secondary compared | **every call** (baseline measurement)  | Phase 2: tight pre-flip observation  |
| `both`         | both (parallel)   | same as `shadow` on reads            | on count mismatch                      | Writes-only dual-ingest window       |

Modes map to the `INSTINCT_DUAL_MODE` env var; the factory wires it
through to every call site.

## Phases

### Phase 1 — Provision + dual-write shadow

1. Provision the Azure targets:
   - AI Search index with schema compatible with `VectorDoc.metadata`
     (include `tenantId` as a filterable keyword field — the multi-tenant
     invariant is enforced here).
   - AGE extension on the managed Postgres (or Cosmos Gremlin account)
     in the same region as the app.
   - Azure OpenAI resource with the embedding deployment matching the
     Qdrant index dimensions (validate via the `EmbeddingProvider.dimensions`
     handshake).
2. Set env:
   ```
   INSTINCT_VECTOR_PROVIDER=dual
   INSTINCT_GRAPH_PROVIDER=dual
   INSTINCT_EMBEDDING_PROVIDER=openai      # still the primary for now
   INSTINCT_DUAL_MODE=shadow
   AZURE_AI_SEARCH_* ...
   AZURE_OPENAI_* ...
   ```
3. Deploy. Every write lands in both stores. Reads stay served from
   Qdrant/Neo4j — Azure is graded via `rag.dual_read_divergence`.
4. **Gate to Phase 2.** `npm run verify` green, and the learning-loop
   dashboard (`instinct_events` filtered on `rag.dual_*`) shows:
   - `rag.dual_write_failed` on the Azure side at <0.1% of writes over
     24h.
   - `rag.dual_read_divergence` (shadow mode) at <5% of reads.
   - `rag.dual_write_divergence` (count mismatch) at <0.5% of batches.

### Phase 2 — Flip reads

1. Switch `INSTINCT_DUAL_MODE=compare` for 48h to capture a baseline
   divergence curve (compare always emits, even on identical results).
2. Flip:
   ```
   INSTINCT_VECTOR_PROVIDER=azure_ai_search
   INSTINCT_GRAPH_PROVIDER=age             # or cosmos_gremlin
   INSTINCT_EMBEDDING_PROVIDER=azure_openai
   INSTINCT_DUAL_MODE=shadow               # Qdrant/Neo4j now the
                                           # "secondary" for observation
   ```
3. Deploy. Reads now serve from Azure; writes still go to both sides so
   we can roll back instantly.
4. **Gate to Phase 3.** 7 days of Azure-primary reads with:
   - No increase in `knowledge.answer_not_found` vs. the pre-flip
     baseline (learning-loop SLO).
   - No increase in p95 query latency.
   - Zero tenant leakage incidents.

### Phase 3 — Decommission

1. Flip `INSTINCT_DUAL_MODE=primary_only`. Qdrant/Neo4j writes stop.
2. Confirm no residual references in code (grep for raw Qdrant/Neo4j
   client imports outside `rag-providers/`).
3. Tear down the Qdrant instance and Neo4j cluster. Snapshot both for
   90-day rollback insurance.
4. Remove `QDRANT_URL` / `NEO4J_URI` env vars.

### Phase 4 — MS Graph connectors

Azure-native RAG unlocks the MS Graph connector pipeline (SharePoint /
Teams / OneDrive as first-class RAG sources via AI Search's built-in
indexers — no custom extraction code).

1. Enable AI Search indexer for the target MS Graph connector(s). Each
   connector carries the tenant identity forward via the document's
   `siteId`/`driveId` — map those onto `VectorDoc.tenantId` in the
   indexer skillset.
2. Gate rollout per connector: shadow → compare → primary.
3. Keep custom extraction (PDF OCR, transcript normalization) upstream
   of the indexer so the Qdrant/Azure abstraction stays uniform.

## Rollback procedure

Rollback is always **flip env + redeploy**. No data surgery is required
because every phase keeps the previous store hot until the gate passes.

| From                 | Rollback step                                              |
|----------------------|------------------------------------------------------------|
| Phase 1 shadow       | Set `INSTINCT_VECTOR_PROVIDER=qdrant` + `INSTINCT_GRAPH_PROVIDER=neo4j`. Azure receives no more writes. |
| Phase 2 Azure-primary | Re-flip `INSTINCT_VECTOR_PROVIDER=qdrant` / `INSTINCT_GRAPH_PROVIDER=neo4j`. Qdrant/Neo4j were still receiving writes via shadow mode, so state is current. |
| Phase 3 decommission | Restore from the 90-day snapshot. This is the only phase that requires a data restore — which is why Phase 2's 7-day gate is mandatory. |
| Phase 4 MS Graph     | Disable the AI Search indexer. Indexed docs remain but no new ones land; app behavior unchanged because reads are still served from the same AI Search index. |

After any rollback: `npm run verify` must pass against the deployed
URL before declaring the rollback complete. Log the incident +
divergence metrics into the learning loop so the next attempt starts
from a better baseline.

## References

- Provider interfaces: `src/lib/rag-providers/types.ts`
- Config reader: `src/lib/rag-providers/config.ts`
- Dual-write orchestrator: `src/lib/rag-providers/dual-write.ts`
- Analytics events: search `src/lib/analytics.ts` for `rag.dual_*` /
  `rag.vector_*` / `rag.graph_*`.
- AgenticQA invariants: `.agenticqa/memory/`
- Verification gate: `npm run verify`
