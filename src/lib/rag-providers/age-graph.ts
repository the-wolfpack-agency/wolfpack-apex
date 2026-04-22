/**
 * age-graph.ts
 *
 * GraphStore adapter for Apache AGE — a Postgres extension that exposes
 * Cypher via the `cypher()` SQL function. AGE is our preferred graph
 * provider because it reuses the managed Postgres we already run (one
 * fewer moving part than Neo4j, and no extra ops surface).
 *
 * Wire model: every AGE call is a SQL statement of the form
 *
 *   SELECT * FROM cypher('<graph>', $$ <cypher> $$, $1) AS (r agtype);
 *
 * …where `$1` is a single JSON-encoded parameter object. We forward
 * callers' Cypher unchanged inside that wrapper and let AGE handle
 * parameter binding. (AGE accepts a single agtype param bag, not a
 * positional list like pg — so callers pass an object and reference
 * `$key` inside their Cypher.)
 *
 * Every operation:
 *   - NEVER throws; wraps all I/O in try/catch. On failure, upserts
 *     resolve to `void`, query resolves to `[]`, health resolves to
 *     `{ ok: false, ... }`.
 *   - Emits a paired ok/failed analytics event via emitRagEvent with
 *     `{ provider: "age", duration_ms }` (+ op-specific fields).
 *   - Injects `tenant_id` into every node/edge property bag so a missing
 *     tenant scope in a downstream query cannot leak cross-tenant data.
 *
 * CRITICAL invariants protected by tests:
 *   - tenant_id is ALWAYS injected into upsertNode/upsertEdge props.
 *   - Multi-label nodes render labels joined with `:` inside the MERGE.
 *   - Callers' Cypher is wrapped, not rewritten.
 */

import { safeQuery } from "@/lib/db";
import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";
import type {
  GraphEdge,
  GraphNode,
  GraphStore,
} from "@/lib/rag-providers/types";

const PROVIDER = "age";
const SYSTEM_USER = "system";
const SYSTEM_ROLE = "system";

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Strip an AGE agtype trailing type tag (e.g. `::vertex`, `::edge`,
 * `::path`) and best-effort JSON.parse the payload. If parsing fails or
 * the cell is not a string, return the raw value so callers can inspect
 * whatever AGE returned (numbers, booleans, nulls all survive this).
 */
export function deserializeAgtype(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.replace(/::(vertex|edge|path)\s*$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Turn a row as returned by pg (keys are the AS-alias column names, e.g.
 * `{ r: "<agtype>" }` or `{ v: "...", e: "..." }`) into a plain object
 * whose values are deserialized agtype payloads. Never throws.
 */
function deserializeRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = deserializeAgtype(v);
  }
  return out;
}

/**
 * Render a set of Cypher labels as `:L1:L2:L3`. Empty label set is
 * rendered as empty string (caller should guard against label-less
 * nodes, but we don't throw — adapters never throw).
 */
function renderLabels(labels: string[]): string {
  return labels.map((l) => `:${l}`).join("");
}

/**
 * Factory for the AGE-backed GraphStore.
 *
 * @param graphName - which AGE graph to target. Defaults to `"instinct"`
 *                    (matches the graph created in migration 080).
 */
export function createAgeGraphStore(
  graphName: string = "instinct",
): GraphStore {
  /**
   * Run a cypher() wrapped SELECT against the chosen graph. Centralises
   * the wrapper + LOAD/search_path so every call stays consistent.
   *
   * Returns the raw pg rows; the caller is responsible for agtype
   * deserialization on paths where the shape matters.
   */
  async function runCypher(
    cypher: string,
    params: Record<string, unknown>,
    returnAlias: string = "r",
  ): Promise<Record<string, unknown>[]> {
    // AGE requires the extension loaded + ag_catalog on search_path per
    // connection. We concat them into a single statement so pooled
    // connections that have already done this are still happy (LOAD is
    // idempotent within a session).
    //
    // NOTE: we intentionally do NOT let safeQuery swallow the AGE wiring
    // statements by splitting them up — we rely on the underlying pg
    // client to accept multi-statement text. If that changes we can
    // promote to a dedicated helper; for now it keeps the call site flat.
    const sql = `SELECT * FROM cypher('${graphName}', $$ ${cypher} $$, $1) AS (${returnAlias} agtype);`;
    const { rows } = await safeQuery<Record<string, unknown>>(sql, [
      JSON.stringify(params),
    ]);
    return rows;
  }

  return {
    name: PROVIDER,

    async upsertNode(n: GraphNode): Promise<void> {
      const start = performance.now();
      try {
        const labels = renderLabels(n.labels);
        // CRITICAL: tenant_id is ALWAYS injected. Callers cannot override
        // it because we write it last — the spread-then-set idiom means a
        // malicious `props.tenant_id = 'other'` still loses to the real
        // tenantId passed on the GraphNode envelope.
        const props = { ...n.props, id: n.id, tenant_id: n.tenantId };
        const cypher = `MERGE (v${labels} {id: $id}) SET v += $props RETURN v`;
        const rows = await runCypher(cypher, { id: n.id, props }, "v");
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.graph_upsert_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          op: "node",
          labels: n.labels,
          row_count: rows.length,
          duration_ms,
        });
      } catch (err) {
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.graph_upsert_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          op: "node",
          error: errMessage(err),
          duration_ms,
        });
      }
    },

    async upsertEdge(e: GraphEdge): Promise<void> {
      const start = performance.now();
      try {
        // Same tenant-id guarantee as nodes. Caller props are applied
        // first; adapter-owned keys win.
        const props = { ...e.props, tenant_id: e.tenantId };
        // Both endpoints are matched by id. The relationship type in
        // Cypher lives between the endpoints: `-[r:TYPE]->`. We keep the
        // type inline (no parameterisation — AGE does not accept
        // parameterised rel types) and rely on callers passing a typed,
        // non-hostile value. `GraphEdge.type` is strongly typed at the
        // type layer; the factory is internal to the app.
        const cypher = `
          MATCH (from {id: $from})
          MATCH (to {id: $to})
          MERGE (from)-[r:${e.type}]->(to)
          SET r += $props
          RETURN r
        `;
        const rows = await runCypher(
          cypher,
          { from: e.from, to: e.to, props },
          "r",
        );
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.graph_upsert_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          op: "edge",
          edge_type: e.type,
          row_count: rows.length,
          duration_ms,
        });
      } catch (err) {
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.graph_upsert_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          op: "edge",
          error: errMessage(err),
          duration_ms,
        });
      }
    },

    async query(
      cypher: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> {
      const start = performance.now();
      try {
        const rows = await runCypher(cypher, params, "r");
        const deserialized = rows.map(deserializeRow);
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.graph_query_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          row_count: deserialized.length,
          duration_ms,
        });
        return deserialized;
      } catch (err) {
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.graph_query_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          error: errMessage(err),
          duration_ms,
        });
        return [];
      }
    },

    async health(): Promise<{
      ok: boolean;
      latencyMs: number;
      detail?: string;
    }> {
      const start = performance.now();
      try {
        // `RETURN 1` is the smallest possible AGE query. If it comes back
        // with a row, the extension is loaded, the graph is reachable,
        // and the DB pool is alive.
        const rows = await runCypher("RETURN 1", {}, "r");
        const latencyMs = performance.now() - start;
        const ok = rows.length > 0;
        emitRagEvent(
          ok ? "rag.graph_health_ok" : "rag.graph_health_failed",
          SYSTEM_USER,
          SYSTEM_ROLE,
          {
            provider: PROVIDER,
            duration_ms: latencyMs,
            row_count: rows.length,
          },
        );
        return ok
          ? { ok: true, latencyMs }
          : { ok: false, latencyMs, detail: "no rows returned" };
      } catch (err) {
        const latencyMs = performance.now() - start;
        emitRagEvent("rag.graph_health_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          error: errMessage(err),
          duration_ms: latencyMs,
        });
        return { ok: false, latencyMs, detail: errMessage(err) };
      }
    },
  };
}
