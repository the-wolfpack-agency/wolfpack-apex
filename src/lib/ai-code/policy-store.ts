/**
 * Loader for the per-org code-gate policy (migration 275). Never throws and
 * degrades to the DEFAULT (empty) policy - a policy read failure must NEVER open
 * the gate, and an unconfigured workspace behaves exactly like today.
 */
import { safeQuery } from "@/lib/db";
import { query } from "@/lib/db";
import { DEFAULT_CODE_GATE_POLICY, type CodeGatePolicy, type CodeGateDenyRule } from "./policy";

export async function loadCodeGatePolicy(workspaceId: string): Promise<CodeGatePolicy> {
  if (!process.env.DATABASE_URL) return DEFAULT_CODE_GATE_POLICY;
  try {
    const { rows } = await safeQuery<{ protected_paths: unknown; deny_rules: unknown }>(
      `SELECT protected_paths, deny_rules FROM instinct_code_gate_policy WHERE workspace_id = $1`,
      [workspaceId],
    );
    const r = rows[0];
    if (!r) return DEFAULT_CODE_GATE_POLICY;
    const protectedPaths = Array.isArray(r.protected_paths)
      ? (r.protected_paths as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const denyRules = Array.isArray(r.deny_rules)
      ? (r.deny_rules as unknown[]).filter(
          (x): x is CodeGateDenyRule =>
            !!x && typeof (x as CodeGateDenyRule).pattern === "string" && typeof (x as CodeGateDenyRule).title === "string",
        )
      : [];
    return { protectedPaths, denyRules };
  } catch {
    return DEFAULT_CODE_GATE_POLICY;
  }
}

/**
 * Upsert a workspace's code-gate policy. Unlike the loader this uses `query` (not
 * safeQuery): a SET that silently failed would leave the operator believing a
 * control is in force when it is not, so a write failure MUST surface to the
 * caller (the route maps it to a 500). Caller sanitizes first (sanitizePolicyInput).
 */
export async function saveCodeGatePolicy(
  workspaceId: string,
  policy: CodeGatePolicy,
  updatedBy: string,
): Promise<void> {
  await query(
    `INSERT INTO instinct_code_gate_policy (workspace_id, protected_paths, deny_rules, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, now())
     ON CONFLICT (workspace_id) DO UPDATE
       SET protected_paths = EXCLUDED.protected_paths,
           deny_rules      = EXCLUDED.deny_rules,
           updated_by      = EXCLUDED.updated_by,
           updated_at      = now()`,
    [workspaceId, JSON.stringify(policy.protectedPaths), JSON.stringify(policy.denyRules), updatedBy],
  );
}
