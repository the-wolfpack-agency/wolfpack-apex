/**
 * rag-providers/analytics-shim.ts
 *
 * Thin wrapper around `trackEvent` from `@/lib/analytics` so the RAG
 * provider adapters can emit telemetry without depending on the central
 * `InstinctEventType` union. Agent 5 is registering the new
 * `rag.provider.*` event names in parallel; we decouple with a single
 * `as never` cast here rather than making every adapter do it.
 *
 * Rules:
 *   - Never throw. Telemetry failure must never break a RAG write.
 *   - Fire-and-forget. Do not await; `trackEvent` is itself fire-and-forget.
 *   - Metadata is passed through as-is; the underlying `trackEvent`
 *     narrows to `string | number | boolean` values, so callers should
 *     stringify any nested objects before calling.
 */

import { trackEvent } from "@/lib/analytics";

/** Shape the rest of our codebase uses; matches analytics.trackEvent. */
type ScalarMeta = Record<string, string | number | boolean>;

/**
 * Emit a RAG telemetry event. Swallows all errors so a misconfigured
 * analytics pipeline cannot cascade into a RAG write failure.
 */
export function emitRagEvent(
  name: string,
  userId: string,
  role: string,
  metadata: Record<string, unknown>,
): void {
  try {
    // Coerce metadata to scalar-only. Non-scalars get JSON-stringified
    // so we don't drop signal just because a caller passed a nested object.
    const scalar: ScalarMeta = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        scalar[k] = v;
      } else {
        try {
          scalar[k] = JSON.stringify(v);
        } catch {
          scalar[k] = String(v);
        }
      }
    }

    // `as never` decouples us from the central InstinctEventType union —
    // Agent 5 is registering the rag.provider.* names in parallel.
    trackEvent(name as never, userId, role, scalar);
  } catch {
    // Intentionally swallowed: telemetry must never crash a write.
  }
}
