/**
 * The gate registry - the single place a gate is registered so it becomes
 * addressable at /api/gate/<name>. Adding a gate is one line here; the endpoint,
 * auth, policy enforcement, and audit come for free from the framework.
 */
import type { GateDefinition } from "./types";
import { safeReviewGate } from "./safe-review-gate";
import { ciAutofixGate } from "./ci-autofix-gate";
import { deployHealthGate } from "./deploy-health-gate";
import { previewVerifyGate } from "./preview-verify-gate";
import { prodPromoteGate } from "./prod-promote-gate";
import { dataEgressGate } from "./data-egress-gate";
import { dependencyReviewGate } from "./dependency-review-gate";

const REGISTRY = new Map<string, GateDefinition<unknown, unknown>>();

function register(def: GateDefinition<unknown, unknown>): void {
  REGISTRY.set(def.name, def);
}

register(safeReviewGate as GateDefinition<unknown, unknown>);
register(ciAutofixGate as GateDefinition<unknown, unknown>);
register(deployHealthGate as GateDefinition<unknown, unknown>);
register(previewVerifyGate as GateDefinition<unknown, unknown>);
register(prodPromoteGate as GateDefinition<unknown, unknown>);
register(dataEgressGate as GateDefinition<unknown, unknown>);
register(dependencyReviewGate as GateDefinition<unknown, unknown>);

/** Look up a gate by name, or undefined if not registered (the route 404s). */
export function getGate(name: string): GateDefinition<unknown, unknown> | undefined {
  return REGISTRY.get(name);
}

/** All registered gate names + purposes, for a discovery endpoint / the UI. */
export function listGates(): { name: string; purpose: string; entitlement?: string }[] {
  return [...REGISTRY.values()].map((g) => ({ name: g.name, purpose: g.purpose, entitlement: g.entitlement }));
}
