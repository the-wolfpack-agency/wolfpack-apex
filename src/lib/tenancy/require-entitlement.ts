/**
 * requireEntitlement: the server-side gate that makes a per-workspace OGIAM
 * entitlement actually enforce. Call it right after requireCapability in a route
 * that belongs to a gateable product (Secure Agent, Forcefield):
 *
 *   const auth = await requireCapability(req, "settings.manage_team");
 *   if (!auth.ok) return auth.response;
 *   const gate = await requireEntitlement(auth.user.workspaceId, "forcefield");
 *   if (gate) return gate;
 *
 * Returns a 403 NextResponse when the product is disabled for the workspace, or
 * null when it is enabled (so the handler proceeds). resolveEntitlement fails
 * SAFE to the env default, so a DB hiccup never wrongly locks a customer out.
 */
import { NextResponse } from "next/server";
import { resolveEntitlement } from "./entitlements";

export async function requireEntitlement(
  workspaceId: string | null | undefined,
  feature: string,
): Promise<NextResponse | null> {
  const enabled = await resolveEntitlement(workspaceId, feature);
  if (enabled) return null;
  return NextResponse.json(
    { error: `The ${feature} product is not enabled for this workspace.`, feature, entitled: false },
    { status: 403 },
  );
}
