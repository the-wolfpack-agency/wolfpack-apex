/**
 * rag-providers/dual-write.ts
 *
 * Orchestrator for running RAG writes and reads against a *primary* and
 * optional *secondary* store at the same time. This is the spine of the
 * Qdrant -> Azure AI Search (and Neo4j -> AGE) migration: the migration
 * playbook stands up the new target as the `secondary` store, runs in
 * `shadow`/`compare` mode until divergence is near-zero, then flips to
 * `primary_only` on the new target and retires the old one.
 *
 * Hard rules — see `docs/azure-migration.md` and the global engineering
 * directive:
 *   - NEVER throws. Any adapter failure is caught, emitted as
 *     `rag.dual_write_failed`, and the other side still runs.
 *   - Every op emits per-side analytics so the learning loop can compute
 *     divergence trends over time.
 *   - `both` and `compare` are the "both sides live" modes. `shadow` runs
 *     both but returns only primary (so prod behavior is unchanged while
 *     we grade the secondary). `primary_only` is the default once the
 *     flip is complete.
 *
 * Mode semantics summary:
 *
 *   primary_only  writes: primary only. reads: primary only.
 *   shadow        writes: both sides. reads: both sides, returns primary.
 *                 Emits `rag.dual_read_divergence` ONLY when set-diff is
 *                 non-empty (signal conservation — baseline is quiet).
 *   compare       same as shadow, but ALWAYS emits the read-divergence
 *                 event (baseline measurement / regression tracking).
 *   both          writes: both sides, compare counts, emit divergence if
 *                 they differ. reads: NOT a read mode — dualReadVector
 *                 treats it the same as `shadow` (returns primary; logs
 *                 secondary). Callers who want "double-pull" should
 *                 layer fan-out on top; this module keeps one source of
 *                 truth for the user.
 */

import type {
  GraphNode,
  GraphStore,
  VectorDoc,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStore,
} from "@/lib/rag-providers/types";
import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";

/**
 * Operating mode for a single dual-target operation. See file header for
 * the full semantics matrix.
 */
export type DualMode = "primary_only" | "shadow" | "compare" | "both";

/**
 * Shape returned by {@link dualWriteVector}. `secondary` is `null` when
 * the caller passed `secondary=null` or `mode="primary_only"`.
 * `divergence=true` whenever `primary.written !== secondary.written` in a
 * mode that actually wrote to both sides.
 */
export interface DualWriteVectorResult {
  primary: { written: number };
  secondary: { written: number } | null;
  divergence: boolean;
}

/** Result shape for graph-node dual-writes. */
export interface DualWriteGraphResult {
  divergence: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** True when the mode should also touch the secondary store. */
function writesBothSides(mode: DualMode): boolean {
  return mode === "both" || mode === "shadow" || mode === "compare";
}

/**
 * Synthetic user identity for system-emitted RAG telemetry. These events
 * aren't triggered by a user action — they're infrastructure signals for
 * the learning loop. We use fixed values so dashboards can filter them
 * out of user-activity queries cleanly.
 */
const SYSTEM_USER_ID = "system:rag-providers";
const SYSTEM_ROLE = "system";

/**
 * Safely emit an analytics event. The shim is already fire-and-forget,
 * but we wrap here so a bad payload / throw can NEVER crash the
 * orchestrator (hard rule: no throws out of this module).
 */
function safeEmit(event: string, payload: Record<string, unknown>): void {
  try {
    emitRagEvent(event, SYSTEM_USER_ID, SYSTEM_ROLE, payload);
  } catch {
    // swallowed — analytics must never break the hot path
  }
}

/** Extract an Error-like message without re-throwing on weird inputs. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown_error";
  }
}

// ---------------------------------------------------------------------------
// Vector: write
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of docs into the primary store and (optionally) the
 * secondary store in parallel. Never throws.
 *
 * Emits (always):
 *   - `rag.dual_write_started`      { primary, secondary, mode, docs }
 *   - `rag.dual_write_completed`    { primary, secondary, mode,
 *                                     primary_written, secondary_written,
 *                                     divergence }
 *
 * Emits (conditional):
 *   - `rag.vector_upsert_ok`        per successful side
 *   - `rag.vector_upsert_failed`    per failed side (with error message)
 *   - `rag.dual_write_failed`       once per failed side (target name +
 *                                    error); primary still runs if
 *                                    secondary fails and vice versa.
 *   - `rag.dual_write_divergence`   when primary.written !==
 *                                    secondary.written (only in modes
 *                                    that wrote both sides).
 */
export async function dualWriteVector(
  primary: VectorStore,
  secondary: VectorStore | null,
  docs: VectorDoc[],
  mode: DualMode = "both",
): Promise<DualWriteVectorResult> {
  const bothSides = writesBothSides(mode) && secondary !== null;

  safeEmit("rag.dual_write_started", {
    primary: primary.name,
    secondary: secondary?.name ?? null,
    mode,
    docs: docs.length,
  });

  // Always fire both in parallel when applicable — allSettled so one
  // side's failure can't cancel the other.
  const [primaryOutcome, secondaryOutcome] = await Promise.allSettled([
    primary.upsert(docs),
    bothSides
      ? (secondary as VectorStore).upsert(docs)
      : Promise.resolve(null as { written: number } | null),
  ]);

  let primaryResult: { written: number } = { written: 0 };
  if (primaryOutcome.status === "fulfilled") {
    primaryResult = primaryOutcome.value ?? { written: 0 };
    safeEmit("rag.vector_upsert_ok", {
      target: primary.name,
      side: "primary",
      written: primaryResult.written,
      docs: docs.length,
    });
  } else {
    const msg = errMsg(primaryOutcome.reason);
    safeEmit("rag.vector_upsert_failed", {
      target: primary.name,
      side: "primary",
      error: msg,
      docs: docs.length,
    });
    safeEmit("rag.dual_write_failed", {
      target: primary.name,
      side: "primary",
      error: msg,
      mode,
    });
  }

  let secondaryResult: { written: number } | null = null;
  if (bothSides) {
    if (secondaryOutcome.status === "fulfilled") {
      // `null` is only possible when bothSides was false, so the cast is safe.
      secondaryResult = (secondaryOutcome.value as { written: number } | null) ?? {
        written: 0,
      };
      safeEmit("rag.vector_upsert_ok", {
        target: (secondary as VectorStore).name,
        side: "secondary",
        written: secondaryResult.written,
        docs: docs.length,
      });
    } else {
      const msg = errMsg(secondaryOutcome.reason);
      safeEmit("rag.vector_upsert_failed", {
        target: (secondary as VectorStore).name,
        side: "secondary",
        error: msg,
        docs: docs.length,
      });
      safeEmit("rag.dual_write_failed", {
        target: (secondary as VectorStore).name,
        side: "secondary",
        error: msg,
        mode,
      });
      // Leave secondaryResult null so divergence is computed against the
      // real "we don't know" state, not a fake zero.
    }
  }

  // Divergence only makes sense when both sides actually produced a
  // count. If the secondary threw, we surface that via
  // dual_write_failed — not as a silent divergence.
  let divergence = false;
  if (bothSides && secondaryResult !== null) {
    divergence = primaryResult.written !== secondaryResult.written;
    if (divergence) {
      safeEmit("rag.dual_write_divergence", {
        primary: primary.name,
        secondary: (secondary as VectorStore).name,
        primary_written: primaryResult.written,
        secondary_written: secondaryResult.written,
        docs: docs.length,
        mode,
      });
    }
  }

  safeEmit("rag.dual_write_completed", {
    primary: primary.name,
    secondary: secondary?.name ?? null,
    mode,
    primary_written: primaryResult.written,
    secondary_written: secondaryResult?.written ?? null,
    divergence,
  });

  return {
    primary: primaryResult,
    secondary: secondaryResult,
    divergence,
  };
}

// ---------------------------------------------------------------------------
// Vector: read
// ---------------------------------------------------------------------------

/**
 * Query primary (and optionally secondary) for a search. Callers always
 * receive *primary's* hits — the secondary only contributes a learning
 * signal in `shadow`/`compare`/`both` modes.
 *
 * Mode behavior:
 *   - `primary_only`: calls only primary, returns primary hits.
 *   - `shadow`/`both`: calls both, returns primary, emits
 *     `rag.dual_read_divergence` only when the id-set diff is non-empty.
 *   - `compare`: same as shadow, but ALWAYS emits the divergence event
 *     (so dashboards can graph "baseline noise" vs. real divergence).
 *
 * Never throws. If the primary query fails we emit
 * `rag.vector_query_failed` and return `[]` — the caller is responsible
 * for deciding whether to fall back (and should emit
 * `rag.provider_fallback_triggered` when it does).
 */
export async function dualReadVector(
  primary: VectorStore,
  secondary: VectorStore | null,
  opts: VectorSearchOptions,
  mode: DualMode = "primary_only",
): Promise<VectorSearchHit[]> {
  const shouldCompare =
    secondary !== null && (mode === "shadow" || mode === "compare" || mode === "both");

  const [primaryOutcome, secondaryOutcome] = await Promise.allSettled([
    primary.search(opts),
    shouldCompare ? (secondary as VectorStore).search(opts) : Promise.resolve(null),
  ]);

  let primaryHits: VectorSearchHit[] = [];
  if (primaryOutcome.status === "fulfilled") {
    primaryHits = primaryOutcome.value ?? [];
    safeEmit("rag.vector_query_ok", {
      target: primary.name,
      side: "primary",
      mode,
      top_k: opts.topK ?? null,
      hits: primaryHits.length,
    });
  } else {
    safeEmit("rag.vector_query_failed", {
      target: primary.name,
      side: "primary",
      mode,
      error: errMsg(primaryOutcome.reason),
    });
    // Deliberately return [] — caller decides fallback behavior.
  }

  if (shouldCompare) {
    if (secondaryOutcome.status === "fulfilled") {
      const secondaryHits = (secondaryOutcome.value as VectorSearchHit[] | null) ?? [];
      safeEmit("rag.vector_query_ok", {
        target: (secondary as VectorStore).name,
        side: "secondary",
        mode,
        top_k: opts.topK ?? null,
        hits: secondaryHits.length,
      });

      const primaryIds = primaryHits.map((h) => h.id);
      const secondaryIds = secondaryHits.map((h) => h.id);
      const primarySet = new Set(primaryIds);
      const secondarySet = new Set(secondaryIds);
      let intersection = 0;
      for (const id of primarySet) {
        if (secondarySet.has(id)) intersection++;
      }
      const primaryOnly = primarySet.size - intersection;
      const secondaryOnly = secondarySet.size - intersection;

      const diverged = primaryOnly !== 0 || secondaryOnly !== 0;
      const shouldEmit = mode === "compare" || diverged;

      if (shouldEmit) {
        safeEmit("rag.dual_read_divergence", {
          primary: primary.name,
          secondary: (secondary as VectorStore).name,
          mode,
          top_k: opts.topK ?? null,
          primary_ids: primaryIds,
          secondary_ids: secondaryIds,
          intersection,
          primary_only: primaryOnly,
          secondary_only: secondaryOnly,
        });
      }
    } else {
      safeEmit("rag.vector_query_failed", {
        target: (secondary as VectorStore).name,
        side: "secondary",
        mode,
        error: errMsg(secondaryOutcome.reason),
      });
      // Secondary failure in a read mode is NOT a user-visible error;
      // we just lose the learning signal for this call. No divergence
      // event because we can't compute one.
    }
  }

  return primaryHits;
}

// ---------------------------------------------------------------------------
// Graph: write
// ---------------------------------------------------------------------------

/**
 * Dual-write a single graph node. Edges are handled the same way via a
 * future `dualWriteGraphEdge` — keeping the surface small for now while
 * the migration focuses on node-level divergence.
 *
 * Divergence here is binary: primary succeeded and secondary did not, or
 * vice versa. Both-succeed and both-fail count as "no divergence" — a
 * two-sided failure is surfaced via `rag.dual_write_failed` twice and
 * should never be silently turned into a "match".
 */
export async function dualWriteGraphNode(
  primary: GraphStore,
  secondary: GraphStore | null,
  node: GraphNode,
  mode: DualMode = "both",
): Promise<DualWriteGraphResult> {
  const bothSides = writesBothSides(mode) && secondary !== null;

  safeEmit("rag.dual_write_started", {
    primary: primary.name,
    secondary: secondary?.name ?? null,
    mode,
    kind: "graph_node",
    node_id: node.id,
  });

  const [primaryOutcome, secondaryOutcome] = await Promise.allSettled([
    primary.upsertNode(node),
    bothSides
      ? (secondary as GraphStore).upsertNode(node)
      : Promise.resolve(undefined as void | undefined),
  ]);

  const primaryOk = primaryOutcome.status === "fulfilled";
  if (primaryOk) {
    safeEmit("rag.graph_upsert_ok", {
      target: primary.name,
      side: "primary",
      node_id: node.id,
    });
  } else {
    const msg = errMsg(primaryOutcome.reason);
    safeEmit("rag.graph_upsert_failed", {
      target: primary.name,
      side: "primary",
      node_id: node.id,
      error: msg,
    });
    safeEmit("rag.dual_write_failed", {
      target: primary.name,
      side: "primary",
      kind: "graph_node",
      node_id: node.id,
      error: msg,
      mode,
    });
  }

  let secondaryOk: boolean | null = null;
  if (bothSides) {
    secondaryOk = secondaryOutcome.status === "fulfilled";
    if (secondaryOk) {
      safeEmit("rag.graph_upsert_ok", {
        target: (secondary as GraphStore).name,
        side: "secondary",
        node_id: node.id,
      });
    } else {
      const msg = errMsg(
        secondaryOutcome.status === "rejected" ? secondaryOutcome.reason : undefined,
      );
      safeEmit("rag.graph_upsert_failed", {
        target: (secondary as GraphStore).name,
        side: "secondary",
        node_id: node.id,
        error: msg,
      });
      safeEmit("rag.dual_write_failed", {
        target: (secondary as GraphStore).name,
        side: "secondary",
        kind: "graph_node",
        node_id: node.id,
        error: msg,
        mode,
      });
    }
  }

  // Divergence: exactly one side succeeded. If both failed or both
  // succeeded, there's no divergence signal to emit.
  let divergence = false;
  if (bothSides && secondaryOk !== null && primaryOk !== secondaryOk) {
    divergence = true;
    safeEmit("rag.dual_write_divergence", {
      primary: primary.name,
      secondary: (secondary as GraphStore).name,
      kind: "graph_node",
      node_id: node.id,
      primary_ok: primaryOk,
      secondary_ok: secondaryOk,
      mode,
    });
  }

  safeEmit("rag.dual_write_completed", {
    primary: primary.name,
    secondary: secondary?.name ?? null,
    mode,
    kind: "graph_node",
    node_id: node.id,
    primary_ok: primaryOk,
    secondary_ok: secondaryOk,
    divergence,
  });

  return { divergence };
}
