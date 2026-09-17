/**
 * Per-workspace OGIAM entitlements: a config override on top of the
 * deployment-wide env defaults. Turning a product on/off for one client is a row
 * in instinct_org_entitlements, not a redeploy.
 *
 * The OGIAM product features (Secure Agent, Forcefield) are ON by default; an
 * env var OGIAM_FEATURE_<KEY>=off flips the default, and a per-workspace row
 * overrides even that. resolveEntitlement() is the single gate every OGIAM
 * surface should ask, and it FAILS SAFE to the env default so a DB hiccup never
 * hard-blocks a paying customer.
 *
 * Ported from the proven wolfpack-ford entitlements layer, keyed on apex's live
 * tenant unit (workspace_id) and using apex's query() + analytics.
 */
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface OgiamFeature {
  key: string;
  label: string;
  description: string;
}

/** The gateable OGIAM products. Deliberately small: this is the OGIAM catalog,
 *  not a general platform flag system. */
export const OGIAM_FEATURES: readonly OgiamFeature[] = [
  { key: "secure_agent", label: "Secure Agent", description: "Govern the code AI writes before it can merge." },
  { key: "forcefield", label: "Forcefield", description: "Protect the running system from an agent that turns hostile." },
];

export function isKnownFeature(key: string): boolean {
  return OGIAM_FEATURES.some((f) => f.key === key);
}

/** The deployment-wide default for a feature: ON unless OGIAM_FEATURE_<KEY>=off. */
export function envDefault(feature: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[`OGIAM_FEATURE_${feature.toUpperCase()}`];
  return raw !== "off" && raw !== "false" && raw !== "0";
}

/**
 * Is a feature enabled for this workspace right now? A per-workspace override
 * wins; otherwise the env default. Fails SAFE to the env default (never crashes
 * a gate on a DB error).
 */
export async function resolveEntitlement(
  workspaceId: string | null | undefined,
  feature: string,
): Promise<boolean> {
  const fallback = envDefault(feature);
  if (!workspaceId || !isKnownFeature(feature)) return fallback;
  try {
    const { rows } = await query<{ enabled: boolean }>(
      "SELECT enabled FROM instinct_org_entitlements WHERE workspace_id = $1 AND feature = $2",
      [workspaceId, feature],
    );
    return rows.length ? rows[0].enabled : fallback;
  } catch {
    return fallback;
  }
}

export interface EntitlementView {
  key: string;
  label: string;
  description: string;
  envDefault: boolean;
  override: boolean | null;
  effective: boolean;
}

/** Every OGIAM feature with its env default, the workspace's override (if any),
 *  and the effective state. Powers the admin toggle UI. */
export async function listEntitlements(workspaceId: string | null | undefined): Promise<EntitlementView[]> {
  const overrides = new Map<string, boolean>();
  if (workspaceId) {
    try {
      const { rows } = await query<{ feature: string; enabled: boolean }>(
        "SELECT feature, enabled FROM instinct_org_entitlements WHERE workspace_id = $1",
        [workspaceId],
      );
      for (const r of rows) overrides.set(r.feature, r.enabled);
    } catch {
      /* show env defaults if the table read fails */
    }
  }
  return OGIAM_FEATURES.map((f) => {
    const def = envDefault(f.key);
    const override = overrides.has(f.key) ? overrides.get(f.key)! : null;
    return { key: f.key, label: f.label, description: f.description, envDefault: def, override, effective: override ?? def };
  });
}

/**
 * Set (or clear) a workspace's override for a feature. enabled=null CLEARS it
 * (revert to the env default). The caller's route MUST enforce the admin
 * capability; this validates the feature + workspace and audits every change.
 */
export async function setEntitlement(
  actor: { workspaceId: string; userId: string; role: string },
  feature: string,
  enabled: boolean | null,
): Promise<boolean> {
  if (!actor.workspaceId || !isKnownFeature(feature)) return false;
  try {
    if (enabled === null) {
      await query("DELETE FROM instinct_org_entitlements WHERE workspace_id = $1 AND feature = $2", [
        actor.workspaceId,
        feature,
      ]);
    } else {
      await query(
        `INSERT INTO instinct_org_entitlements(workspace_id, feature, enabled, updated_by, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (workspace_id, feature)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [actor.workspaceId, feature, enabled, actor.userId],
      );
    }
    trackEvent("tenancy.entitlement_changed", actor.userId, actor.role, {
      workspace_id: actor.workspaceId,
      feature,
      enabled: enabled === null ? "cleared" : String(enabled),
    });
    return true;
  } catch {
    return false;
  }
}
