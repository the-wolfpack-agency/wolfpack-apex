/**
 * OGIAM decision ledger: append-only, tamper-evident record of every
 * authorization decision.
 *
 * Each row chains to the previous one for its workspace:
 *   entry_hash = sha256(prev_hash || "|" || canonical_json(decision fields))
 * so any after-the-fact edit or deletion breaks the chain and is detectable.
 * This is the same primitive the compliance audit log uses; OGIAM keeps its own
 * chain so the decision stream is independently queryable for the explorer.
 *
 * Writes are serialized per workspace with a transaction-scoped advisory lock,
 * so concurrent tool calls cannot fork the chain. The whole write is best
 * effort: a ledger failure is logged and swallowed, never propagated, so the
 * gate can never break or slow the assistant in shadow mode.
 *
 * The signature column is reserved for the enforce phase, where each entry_hash
 * is signed with a key custodied in Azure Key Vault (through the crypto-agility
 * registry, so the post-quantum migration is a single registry edit). Phase 0
 * relies on the hash chain alone for tamper evidence.
 */

import { createHash } from "crypto";
import { pool } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { OgiamAction, OgiamDecision, OgiamPrincipal } from "./types";

/** Genesis prev_hash for the first entry in a workspace chain. */
export const OGIAM_GENESIS_HASH = "ogiam:ledger:genesis";

/** Stable JSON with sorted keys so the hash is reproducible. */
function canonicalJSON(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** The canonical, stable serialization of the fields the chain commits to.
 *  Stored verbatim as hash_payload so verification recomputes the exact bytes
 *  rather than reconstructing them from typed columns (a timestamptz column, for
 *  example, would not round-trip to the identical string). */
export function ogiamCanonicalPayload(fields: Record<string, unknown>): string {
  return canonicalJSON(fields);
}

/** entry_hash = sha256(prev_hash || "|" || canonical payload). */
export function computeOgiamEntryHash(
  prevHash: string,
  fields: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(prevHash)
    .update("|")
    .update(ogiamCanonicalPayload(fields))
    .digest("hex");
}

export interface RecordDecisionInput {
  principal: OgiamPrincipal;
  action: OgiamAction;
  decision: OgiamDecision;
  /** Redacted parameter snapshot (safe to store, no raw PII). */
  redactedParams: string;
}

export interface RecordedDecision {
  id: string;
  seq: number;
  entryHash: string;
}

/**
 * Append a decision to the ledger. Returns the recorded row, or null on any
 * failure (best effort; never throws).
 */
export async function recordDecision(
  input: RecordDecisionInput,
): Promise<RecordedDecision | null> {
  const { principal, action, decision } = input;

  // No database (shadow-mode local dev, tests): skip cleanly and fast rather
  // than waiting on a connection that cannot be made. The decision still
  // happened; only its persistence is skipped.
  if (!process.env.DATABASE_URL) return null;

  const ts = new Date().toISOString();

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.warn("[ogiam] ledger connect failed:", (err as Error).message);
    return null;
  }

  try {
    await client.query("BEGIN");
    // Serialize chain writes for this workspace. Transaction-scoped, so it is
    // released automatically on COMMIT or ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `ogiam:${principal.workspaceId}`,
    ]);

    const prev = await client.query<{ seq: string; entry_hash: string }>(
      `SELECT seq, entry_hash FROM ogiam_decisions
        WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1`,
      [principal.workspaceId],
    );
    const lastSeq = prev.rows[0] ? Number(prev.rows[0].seq) : 0;
    const prevHash = prev.rows[0] ? prev.rows[0].entry_hash : OGIAM_GENESIS_HASH;
    const seq = lastSeq + 1;

    const hashFields = {
      seq,
      ts,
      workspace_id: principal.workspaceId,
      principal_agent: principal.agent,
      on_behalf_user_id: principal.onBehalfOfUserId,
      on_behalf_role: principal.onBehalfOfRole,
      tool: action.tool,
      capability: action.capability,
      is_mutation: action.isMutation,
      surface: action.surface,
      workflow_id: action.workflowId ?? null,
      risk_tier: decision.riskTier,
      intended_outcome: decision.intendedOutcome,
      effective_outcome: decision.effectiveOutcome,
      enforced: decision.enforced,
      mode: decision.mode,
      policy_version: decision.policyVersion,
      rule_id: decision.ruleId,
      would_block: decision.wouldBlock,
      params_hash: action.paramsHash,
      signals: action.signals,
    };
    const hashPayload = ogiamCanonicalPayload(hashFields);
    const entryHash = createHash("sha256")
      .update(prevHash)
      .update("|")
      .update(hashPayload)
      .digest("hex");

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ogiam_decisions (
         workspace_id, seq, created_at, principal_agent, on_behalf_user_id,
         on_behalf_role, tool, capability, is_mutation, surface, workflow_id,
         risk_tier, intended_outcome, effective_outcome, enforced, mode,
         policy_version, rule_id, reason, would_block, params_hash,
         redacted_params, signals, prev_hash, entry_hash, hash_payload
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20,$21,$22,$23::jsonb,$24,$25,$26
       ) RETURNING id`,
      [
        principal.workspaceId,
        seq,
        ts,
        principal.agent,
        principal.onBehalfOfUserId,
        principal.onBehalfOfRole,
        action.tool,
        action.capability,
        action.isMutation,
        action.surface,
        action.workflowId ?? null,
        decision.riskTier,
        decision.intendedOutcome,
        decision.effectiveOutcome,
        decision.enforced,
        decision.mode,
        decision.policyVersion,
        decision.ruleId,
        decision.reason,
        decision.wouldBlock,
        action.paramsHash,
        input.redactedParams,
        JSON.stringify(action.signals),
        prevHash,
        entryHash,
        hashPayload,
      ],
    );
    await client.query("COMMIT");

    const id = inserted.rows[0]?.id ?? "";

    trackEvent(
      decision.wouldBlock ? "ogiam.action_flagged" : "ogiam.action_authorized",
      principal.onBehalfOfUserId,
      principal.onBehalfOfRole,
      {
        decision_id: id,
        tool: action.tool,
        capability: action.capability,
        risk_tier: decision.riskTier,
        intended_outcome: decision.intendedOutcome,
        enforced: decision.enforced,
        rule_id: decision.ruleId,
        policy_version: decision.policyVersion,
        ...(action.workflowId ? { workflow_id: action.workflowId } : {}),
      },
    );

    return { id, seq, entryHash };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error */
    }
    console.warn("[ogiam] ledger write failed:", (err as Error).message);
    return null;
  } finally {
    client.release();
  }
}
