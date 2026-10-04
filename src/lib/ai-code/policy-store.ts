/**
 * Loader for the per-org code-gate policy (migration 275). Never throws and
 * degrades to the DEFAULT (empty) policy - a policy read failure must NEVER open
 * the gate, and an unconfigured workspace behaves exactly like today.
 */
import { safeQuery } from "@/lib/db";
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
