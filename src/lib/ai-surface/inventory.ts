/**
 * AI Surface discovery orchestrator: detect AI usage across a set of source
 * files, persist the touchpoints to the workspace inventory, and return the
 * freshly-discovered set plus a summary. Source-agnostic (it takes SourceFile[],
 * so a repo connector, an upload, or a paste all feed the same path).
 */
import { detectAiSurfaces, type SourceFile } from "./detect";
import { upsertSurfaces, summarize, type AiSurfaceRecord } from "./store";
import { remediationFor, type Remediation } from "./remediation";
import type { AiSurface, AiSurfaceSummary } from "./types";

export interface DiscoveryResult {
  target: string;
  surfaces: AiSurface[];
  written: number;
  summary: AiSurfaceSummary;
  /** Deterministic remediation for each UNGOVERNED surface, in surface order.
   *  Detection is not a dead end: every gap ships with its fix. */
  remediations: Remediation[];
}

export async function runDiscovery(args: {
  workspaceId: string;
  target: string;
  files: SourceFile[];
}): Promise<DiscoveryResult> {
  const surfaces = args.files.flatMap((f) => detectAiSurfaces(f));
  const written = await upsertSurfaces(args.workspaceId, args.target, surfaces);
  // Summarize the just-discovered set with the same pure rollup the inventory
  // dashboard uses (records-shaped; ids/timestamps are irrelevant to the rollup).
  const asRecords: AiSurfaceRecord[] = surfaces.map((s, i) => ({
    ...s,
    id: String(i),
    target: args.target,
    firstSeenAt: "",
    lastSeenAt: "",
  }));
  // Remediation only for the ungoverned gap — governed surfaces need no fix.
  const remediations = surfaces.filter((s) => !s.governed).map(remediationFor);
  return { target: args.target, surfaces, written, summary: summarize(asRecords), remediations };
}
