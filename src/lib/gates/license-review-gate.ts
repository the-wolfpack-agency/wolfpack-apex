/**
 * license-review gate - catch a restrictive / copyleft license being introduced
 * into the codebase (a model copy-pasting GPL/AGPL/SSPL code, or a dependency's
 * license field flipping to copyleft) before it reaches a proprietary product. A
 * real legal + supply-chain risk. Deterministic: scans the diff's ADDED lines for
 * SPDX identifiers and license-header text; reuses the same added-line parser as
 * the code detectors. No model.
 *
 *   no restrictive license signal   -> allow
 *   copyleft/restrictive introduced  -> require_human (confirm compatibility with
 *                                       the project's license before merge)
 */
import { parseAddedLines } from "@/lib/ai-code/detect";
import type { GateDefinition, GateResult } from "./types";

/** Restrictive / copyleft license signals in added lines. Precision-first: SPDX
 *  ids and canonical license-header phrases, so ordinary prose does not match. */
const RESTRICTIVE_LICENSE: { id: string; re: RegExp }[] = [
  { id: "spdx-copyleft", re: /SPDX-License-Identifier:\s*\(?\s*(?:GPL|AGPL|LGPL|SSPL|CC-BY-SA|EUPL|OSL|CPAL|MPL-1)/i },
  { id: "gpl-header", re: /\bGNU\s+(?:General|Affero|Lesser)\s+Public\s+License\b/i },
  { id: "sspl-header", re: /\bServer\s+Side\s+Public\s+License\b/i },
  { id: "cc-by-sa", re: /\bCreative\s+Commons\s+Attribution-ShareAlike\b/i },
  { id: "package-license-copyleft", re: /"license"\s*:\s*"\(?\s*(?:GPL|AGPL|LGPL|SSPL)/i },
];

export interface LicenseReviewInput {
  diff: string;
}

export interface LicenseReviewOutput {
  signals: { id: string; file: string; line: number }[];
}

export const licenseReviewGate: GateDefinition<LicenseReviewInput, LicenseReviewOutput> = {
  name: "license-review",
  entitlement: "secure_agent",
  purpose: "Catch a restrictive/copyleft license (GPL/AGPL/SSPL/CC-BY-SA) being introduced into the codebase - copied code or a dependency license flip - before it reaches a proprietary product. A human confirms compatibility.",
  async evaluate(input, ctx): Promise<GateResult<LicenseReviewOutput>> {
    const added = parseAddedLines(input.diff);
    const signals: LicenseReviewOutput["signals"] = [];
    for (const a of added) {
      for (const r of RESTRICTIVE_LICENSE) if (r.re.test(a.text)) signals.push({ id: r.id, file: a.file, line: a.line });
    }
    const output = { signals };
    const dataSeen = "The diff's added lines (SPDX ids + license headers). No model invoked.";
    const checks = ["copyleft-license-scan (SPDX + headers)"];

    if (signals.length === 0) {
      return {
        verdict: "allow",
        output,
        findings: [],
        reason: "No restrictive/copyleft license signal introduced.",
        transparency: { checksRun: checks, dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: "No restrictive license." },
        audit: { gate: "license-review", verdict: "allow", ruleId: "GATE-license-review-clean", reason: "no restrictive license", workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    }

    const ids = [...new Set(signals.map((s) => s.id))].join(", ");
    const reason = `A restrictive/copyleft license signal was introduced (${ids}). Copyleft code (GPL/AGPL/SSPL) in a proprietary product has real legal consequences, so a human should confirm it is compatible with the project's license before merge.`;
    return {
      verdict: "require_human",
      output,
      findings: signals.map((s) => ({ id: s.id, severity: "high" as const, detail: `${s.id} at ${s.file}:${s.line}` })),
      reason,
      transparency: { checksRun: checks, dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
      audit: { gate: "license-review", verdict: "require_human", ruleId: "GATE-license-review-restrictive", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
