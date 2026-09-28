/**
 * The canonical factory chain - the whole workflow as a composition of gates,
 * ending at the ONE human touchpoint before production.
 *
 *   safe-review(diff)      allow ->  the change is deterministically clean
 *   preview-verify(url)    allow ->  the green PR's preview actually serves
 *   prod-promote           HUMAN ->  the only required human step: approve prod
 *
 * runChain advances on allow and STOPS at prod-promote's require_human - so a
 * passing change flows all the way to "awaiting human production approval" with
 * no other human step. A deny (safe-review) or a broken preview (preview-verify
 * require_human) stops earlier, with a client-visible reason. The CI-autofix gate
 * is NOT in this forward chain - it runs during the PR to make CI green; this
 * chain is the green-PR -> preview -> prod promotion path.
 *
 * This is a pure builder (returns the ChainStep[]); the caller runs it with
 * runChain, so it stays testable without any IO.
 */
import type { ChainStep } from "./chain";
import { safeReviewGate } from "./safe-review-gate";
import { previewVerifyGate } from "./preview-verify-gate";
import { prodPromoteGate } from "./prod-promote-gate";

export interface FactoryChainParams {
  /** The change under review. */
  diff: string;
  /** The preview URL the green PR deployed to. */
  previewUrl: string;
  /** Optional content markers the preview must render (the full treatment). */
  requiredMarkers?: string[];
}

/** Build the green-PR -> preview -> production-promotion chain. */
export function buildFactoryChain(params: FactoryChainParams): ChainStep[] {
  return [
    { gate: safeReviewGate as ChainStep["gate"], input: () => ({ diff: params.diff }) },
    { gate: previewVerifyGate as ChainStep["gate"], input: () => ({ url: params.previewUrl, requiredMarkers: params.requiredMarkers }) },
    {
      gate: prodPromoteGate as ChainStep["gate"],
      input: () => ({ previewUrl: params.previewUrl, evidence: "safe-review clean + preview verified" }),
    },
  ];
}
