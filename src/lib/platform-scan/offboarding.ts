/**
 * Client offboarding: purge ALL platform-scan data for a workspace across the
 * triple-write substrate (Postgres + Qdrant + Neo4j), with a defensible,
 * auditable record of exactly what was erased.
 *
 * WHY: there is otherwise no clean way to remove a client. Leftover findings /
 * scans / targets / credentials after a client offboards is a contractual,
 * data-retention, and GDPR ("right to erasure") failure. This module is the one
 * canonical purge path.
 *
 * SAFETY: this is DESTRUCTIVE and irreversible. The route in front of it enforces
 * a high capability AND an explicit typed confirmation; this module always writes
 * the hash-chained audit entry + the offboarding_log row + the analytics event so
 * every purge leaves a permanent, queryable trace ("no data lost about WHAT was
 * purged", even though the scan data itself is gone).
 *
 * GRACEFUL DEGRADATION: Postgres is the source of truth and MUST be erased
 * completely (each DELETE filtered by workspace_id). Qdrant + Neo4j are derived
 * secondary views; if one is down we COMPLETE the Postgres purge and record the
 * leftover in `residue` for a follow-up retry. This mirrors the triple-write
 * degraded philosophy - but for a PURGE, leftover secondary-store data is itself
 * a retention risk, so residue is logged loudly, never silently swallowed.
 *
 * IDEMPOTENT: a second purge of an already-offboarded workspace deletes zero rows
 * and returns all-zero counts - it never errors.
 *
 * Injectable deps (db / qdrant / neo4j) so tests run entirely against mocks and
 * never touch real infra.
 */

import { writeQuery as defaultWriteQuery } from "@/lib/db";
import { recordAudit, type AuditActor } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { BRAIN_COLLECTION } from "@/lib/brain/qdrant";
import { executeCypher as defaultExecuteCypher } from "@/lib/neo4j";

/**
 * Every workspace-scoped platform-scan table that holds client data. Each is
 * deleted by `workspace_id = $1`. Order is not load-bearing (no FKs between
 * them), but findings-before-scans reads naturally as "leaf rows first".
 *
 * Kept as an exported const so the test asserting "purge touches every enumerated
 * table" and this purge stay in lockstep - adding a new platform-scan table means
 * adding it here, and the test will hold the purge to it.
 */
export const PLATFORM_SCAN_WORKSPACE_TABLES = [
  "instinct_platform_scan_findings", // per-finding rows
  "instinct_platform_scans", // scan run headers + coverage columns
  "instinct_scan_targets", // onboarded client target manifests
  "instinct_target_verifications", // domain-ownership verification state
  "instinct_system_profiles", // the agent's knowledge model of the target
  "instinct_automation_recommendations", // gate-governed automation proposals
  "instinct_pentest_authorizations", // pentest rules-of-engagement scope tokens
  "instinct_connector_credentials", // per-tenant connector credentials (encrypted)
] as const;

export type PlatformScanTable = (typeof PLATFORM_SCAN_WORKSPACE_TABLES)[number];

export type PurgeCounts = Record<PlatformScanTable, number>;

/** Per-secondary-store residue when a best-effort purge could not complete. The
 *  presence of a key means that store still holds (or may still hold) data for
 *  the workspace and a retry is owed. Absent key = that store purged cleanly. */
export interface PurgeResidue {
  qdrant?: string;
  neo4j?: string;
}

export interface OffboardResult {
  workspaceId: string;
  counts: PurgeCounts;
  residue: PurgeResidue;
  /** Total Postgres rows deleted across every table this run. */
  totalDeleted: number;
  /** True when both secondary stores purged cleanly (residue empty). */
  secondaryStoresClean: boolean;
}

/** Injectable boundaries. Defaults wire to the real db / qdrant / neo4j clients;
 *  tests pass mocks so no real infra is touched. */
export interface OffboardDeps {
  /** Strict write helper. Throws on DB failure (Postgres erasure must not be
   *  silently skipped) - matches src/lib/db.ts writeQuery semantics. */
  writeQuery?: <T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
  /** Delete-by-filter against Qdrant. Resolves true on success, false (or throws)
   *  when Qdrant is unreachable - either is recorded as residue. */
  purgeQdrant?: (workspaceId: string) => Promise<boolean>;
  /** Delete the workspace's Neo4j edges/nodes. Same success/residue contract. */
  purgeNeo4j?: (workspaceId: string) => Promise<boolean>;
}

/**
 * Default Qdrant purge: delete every point in the Brain collection tagged for
 * this workspace. Platform-scan findings are ingested into the Brain (see
 * brain-ingest.ts), so their vectors live in the Brain collection alongside a
 * workspace tag. We delete by a payload filter on workspace_id. Best-effort:
 * any non-OK response or thrown error is surfaced as `false` so the caller logs
 * residue instead of failing the Postgres purge.
 */
async function defaultPurgeQdrant(workspaceId: string): Promise<boolean> {
  const url = process.env.QDRANT_URL;
  if (!url) {
    // No Qdrant configured: nothing to purge there, treat as clean (not residue).
    return true;
  }
  try {
    const res = await fetch(
      `${url}/collections/${BRAIN_COLLECTION}/points/delete?wait=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.QDRANT_API_KEY ? { "api-key": process.env.QDRANT_API_KEY } : {}),
        },
        body: JSON.stringify({
          filter: {
            must: [{ key: "workspace_id", match: { value: workspaceId } }],
          },
        }),
        signal: AbortSignal.timeout(5000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Default Neo4j purge: detach-delete every node tagged with this workspace_id.
 * The graph store is best-effort; a down store returns no rows and we surface a
 * false so residue is recorded. executeCypher itself never throws (it returns []
 * on failure), so we run a marker query and treat its result as the signal.
 */
async function defaultPurgeNeo4j(workspaceId: string): Promise<boolean> {
  if (!process.env.NEO4J_URI && !process.env.NEO4J_URL) {
    // No Neo4j configured: nothing to purge, treat as clean.
    return true;
  }
  try {
    // DETACH DELETE every node carrying this workspace_id property. The marker
    // RETURN lets us distinguish "ran" from "store unreachable" (executeCypher
    // returns [] on any transport failure).
    const rows = await defaultExecuteCypher(
      `MATCH (n { workspace_id: $workspaceId })
       DETACH DELETE n
       RETURN 1 AS ok`,
      { workspaceId },
    );
    // A successful delete of zero matching nodes still returns a row for the
    // RETURN clause in most drivers; but the HTTP API returns rows only when the
    // RETURN produced data. To avoid a false "residue" on an empty graph, run a
    // cheap health probe: if the delete returned nothing, confirm connectivity.
    if (rows.length > 0) return true;
    const probe = await defaultExecuteCypher("RETURN 1 AS ok");
    return probe.length > 0;
  } catch {
    return false;
  }
}

/**
 * Purge every platform-scan trace of a workspace and record the erasure.
 *
 * 1. DELETE all platform-scan rows for the workspace from every enumerated table
 *    (Postgres, source of truth). Per-table counts captured.
 * 2. Best-effort purge of Qdrant vectors + Neo4j edges scoped to the workspace.
 *    Any store that is down is recorded in `residue` for retry, never blocking.
 * 3. Write the offboarding_log row + recordAudit + fire the analytics event.
 *
 * Idempotent: re-running deletes zero rows (returns zero counts), never throws.
 */
export async function offboardWorkspace(
  workspaceId: string,
  actor: AuditActor,
  deps: OffboardDeps = {},
): Promise<OffboardResult> {
  const writeQuery = deps.writeQuery ?? defaultWriteQuery;
  const purgeQdrant = deps.purgeQdrant ?? defaultPurgeQdrant;
  const purgeNeo4j = deps.purgeNeo4j ?? defaultPurgeNeo4j;

  // 1. Postgres erasure - the source of truth MUST be fully cleared. writeQuery
  //    throws on any DB failure, so a partial/failed erasure surfaces loudly
  //    rather than being recorded as a successful purge.
  const counts = {} as PurgeCounts;
  let totalDeleted = 0;
  for (const table of PLATFORM_SCAN_WORKSPACE_TABLES) {
    // Table name is from a fixed compile-time allowlist (not user input), so
    // interpolating it is safe; the workspace_id is parameterized.
    const { rows } = await writeQuery<{ id: unknown }>(
      `DELETE FROM ${table} WHERE workspace_id = $1 RETURNING 1 AS id`,
      [workspaceId],
    );
    const n = rows.length;
    counts[table] = n;
    totalDeleted += n;
  }

  // 2. Secondary stores - best effort. A failure (down store) is recorded as
  //    residue (a retention risk owed a retry), never thrown.
  const residue: PurgeResidue = {};
  try {
    const ok = await purgeQdrant(workspaceId);
    if (!ok) residue.qdrant = "unreachable";
  } catch {
    residue.qdrant = "unreachable";
  }
  try {
    const ok = await purgeNeo4j(workspaceId);
    if (!ok) residue.neo4j = "unreachable";
  } catch {
    residue.neo4j = "unreachable";
  }

  const secondaryStoresClean = Object.keys(residue).length === 0;

  // 3a. The defensible ledger row: counts + residue, queryable for compliance +
  //     the retry queue. Best effort - a ledger failure must not lose the purge
  //     we already performed; it is logged but does not throw.
  try {
    await writeQuery(
      `INSERT INTO instinct_workspace_offboarding_log
         (workspace_id, requested_by, counts, residue)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [workspaceId, actor.user_id, JSON.stringify(counts), JSON.stringify(residue)],
    );
  } catch (e) {
    console.warn("[offboarding] log row write failed:", (e as Error)?.message ?? "unknown");
  }

  // 3b. Hash-chained audit entry - this is a security-relevant, irreversible
  //     destructive action. Best effort (the purge already stands).
  await recordAudit({
    actor,
    action: "platform.workspace_offboarded",
    resourceType: "workspace",
    resourceId: workspaceId,
    afterState: {
      counts,
      residue,
      total_deleted: totalDeleted,
      secondary_stores_clean: secondaryStoresClean,
    },
  }).catch((e) => console.warn("[offboarding] audit failed:", (e as Error).message));

  // 3c. Analytics / learning signal. Scalar metadata only.
  trackEvent("platform.workspace_offboarded", actor.user_id, actor.role, {
    workspace_id: workspaceId,
    purged_findings: counts.instinct_platform_scan_findings,
    purged_scans: counts.instinct_platform_scans,
    purged_targets: counts.instinct_scan_targets,
    purged_credentials: counts.instinct_connector_credentials,
  });

  return { workspaceId, counts, residue, totalDeleted, secondaryStoresClean };
}
