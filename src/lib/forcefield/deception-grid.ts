/**
 * Ensure a DIVERSE deception grid: one active decoy of each kind (token, route,
 * row, tool), so coverage is never accidentally thin. Idempotent - only seeds
 * kinds that have no active decoy.
 *
 * HONEST LIMIT. Seeding stores the decoy VALUE + its intended placement label;
 * it does NOT by itself emit the value where an agent would encounter it (a
 * token in a JS bundle, a hidden route in robots.txt/sitemap, a decoy row in an
 * API response, a fake tool endpoint). That emission is a per-surface step at
 * the edge/site; this returns the placement each seeded kind still needs so the
 * gap is explicit, never implied-done. Dependency-injected so it is unit-
 * testable without a database.
 */
import { CANARY_KINDS, type CanaryKind } from "./tripwire";
import { createCanary, listCanariesForMatching } from "./canary-store";
import { randomBytes } from "node:crypto";

/** Where each kind must be EMITTED for an agent to encounter (and trip) it. */
export const KIND_PLACEMENT: Record<CanaryKind, string> = {
  token: "Embed in a JS bundle as a fake API key - only an exfiltrator that scrapes and uses it trips.",
  route: "Add to robots.txt Disallow + sitemap - only an agent that ignores the rules visits it.",
  row: "Return as a decoy record in a list/API response - only bulk-harvesting reaches it.",
  tool: "Advertise as a plausible endpoint (sitemap / tool manifest) - only a path-guesser calls it.",
};

function decoyValue(kind: CanaryKind): string {
  const rnd = randomBytes(12).toString("hex");
  switch (kind) {
    case "token": return `wlpk_live_${rnd}`;
    case "route": return `/internal/export-${rnd}`;
    case "row": return `decoy-${rnd}@example.invalid`;
    case "tool": return `admin_bulk_export_${rnd}`;
  }
}

export interface GridDeps {
  /** Active decoys for the workspace (kind is all this needs). */
  listActive: (workspaceId: string) => Promise<{ kind: CanaryKind }[]>;
  /** Seed one decoy. */
  create: (input: { workspaceId: string; kind: CanaryKind; value: string; seededIn: string; createdBy?: string }) => Promise<void>;
}

export function liveGridDeps(): GridDeps {
  return {
    listActive: (workspaceId) => listCanariesForMatching(workspaceId),
    create: async (input) => { await createCanary(input); },
  };
}

export interface GridSeedResult {
  /** Kinds newly seeded this call, with the placement each still needs. */
  seeded: { kind: CanaryKind; placement: string }[];
  /** Kinds that already had an active decoy (left untouched). */
  alreadyPresent: CanaryKind[];
  /** Every kind's placement instruction, so emission is never assumed done. */
  pendingPlacement: { kind: CanaryKind; placement: string }[];
}

/** Idempotently ensure one active decoy of each kind exists. No-op-safe. */
export async function ensureDeceptionGrid(
  input: { workspaceId: string; createdBy?: string },
  deps: GridDeps = liveGridDeps(),
): Promise<GridSeedResult> {
  const existing = await deps.listActive(input.workspaceId);
  const haveKinds = new Set(existing.map((c) => c.kind));

  const seeded: { kind: CanaryKind; placement: string }[] = [];
  for (const kind of CANARY_KINDS) {
    if (haveKinds.has(kind)) continue;
    await deps.create({
      workspaceId: input.workspaceId,
      kind,
      value: decoyValue(kind),
      seededIn: KIND_PLACEMENT[kind],
      createdBy: input.createdBy,
    });
    seeded.push({ kind, placement: KIND_PLACEMENT[kind] });
  }

  return {
    seeded,
    alreadyPresent: CANARY_KINDS.filter((k) => haveKinds.has(k)),
    pendingPlacement: CANARY_KINDS.map((k) => ({ kind: k, placement: KIND_PLACEMENT[k] })),
  };
}
