/**
 * Multi-model matrix: ANY MODEL, SAME GOVERNANCE.
 *
 * The product claim is that governance lives in the gate, not the model, so it
 * holds no matter who wrote the code - including a model a client brings via
 * their own key. This proves it as a deterministic matrix over the REAL model
 * registry (Anthropic, OpenAI, Meta/Llama, DeepSeek today), not by asserting it
 * in prose:
 *
 *   1. Every registered model has an INDEPENDENT-FAMILY judge in the registry -
 *      no model is un-governable for lack of a different-lineage checker.
 *   2. Every registered model is ROUTABLE and of a KNOWN lineage - an unknown
 *      lineage would silently break the independence guarantee.
 *   3. The gate VERDICT is invariant to the authoring model - the same corpus
 *      case run "as" every model in the registry yields the same status, and it
 *      equals the corpus expectation. Bad code is rejected whoever wrote it.
 *
 * All deterministic, no network: the gate + conformance are real, the author is
 * a label, and the repair is a no-op fix so a bad case can only end needs_human.
 * (Live REACHABILITY of a brought model is a separate, already-shipped surface:
 * the /admin/ai-router probe + BYO keys. This proves the decision itself is
 * model-independent, which no number of live calls can establish.)
 */
import { runPipeline } from "../pipeline";
import { reviewDiff } from "../detect";
import { decideCodeGate } from "../gate";
import type { CodeReviewResult } from "../types";
import type { RepairComplete } from "../repair";
import { listModels } from "@/lib/ai/models/registry";
import {
  chooseIndependentJudge,
  lineageOf,
  LINEAGE_UNKNOWN,
  type JudgeCandidate,
} from "@/lib/ai/judge-selection";
import { CORPUS } from "./corpus";

const MODELS = listModels();
// The judge pool IS the registry: a real Claude author is checked by a real
// OpenAI/Meta/DeepSeek model, and vice versa. chooseIndependentJudge skips
// same-lineage candidates (including the author itself).
const REGISTRY_CANDIDATES: JudgeCandidate[] = MODELS.map((m) => ({ model: m.id, provider: m.provider }));
const NOW = "2026-09-17T00:00:00.000Z";

function realReview(diff: string): Promise<CodeReviewResult> {
  const findings = reviewDiff(diff);
  return Promise.resolve({ ref: "r", author: "a", findings, verdict: decideCodeGate(findings), bySeverity: {} });
}
const noFixRepair: RepairComplete = async () => "";

describe("multi-model matrix — any model, same governance", () => {
  it("the registry actually spans more than one lineage (independence is possible)", () => {
    const lineages = new Set(MODELS.map((m) => lineageOf({ model: m.id, provider: m.provider })));
    expect(lineages.size).toBeGreaterThanOrEqual(2);
    expect(lineages.has(LINEAGE_UNKNOWN)).toBe(false);
  });

  describe("every registered model is independently checkable and routable", () => {
    for (const m of MODELS) {
      it(`${m.id}: has a different-lineage judge and a known lineage + tier`, () => {
        const author: JudgeCandidate = { model: m.id, provider: m.provider };
        const authorLineage = lineageOf(author);
        expect(authorLineage).not.toBe(LINEAGE_UNKNOWN); // routable + checkable

        const choice = chooseIndependentJudge(author, REGISTRY_CANDIDATES);
        expect(choice.reason).toBe("independent");
        expect(choice.candidate).not.toBeNull();
        expect(choice.judgeLineage).not.toBe(choice.authorLineage);

        expect(m.capabilityTier).toBeTruthy();
        expect(m.provider).toBeTruthy();
      });
    }
  });

  describe("the gate verdict is invariant to the authoring model", () => {
    for (const c of CORPUS) {
      it(`"${c.name}": same status from every model, equal to the corpus expectation`, async () => {
        const statuses = await Promise.all(
          MODELS.map((m) =>
            runPipeline({
              ref: "matrix",
              prompt: "task",
              answers: c.answers,
              diff: c.diff,
              author: m.id,
              nowIso: NOW,
              review: realReview,
              repair: noFixRepair,
              candidates: REGISTRY_CANDIDATES,
            }).then((r) => r.status),
          ),
        );
        // One outcome across the whole registry, and it is the expected one.
        expect(new Set(statuses).size).toBe(1);
        expect(statuses[0]).toBe(c.expect.status);
        // Bad code never rides through as ready, whoever authored it.
        if (c.expect.status === "needs_human") {
          expect(statuses.every((s) => s !== "ready_for_pr")).toBe(true);
        }
      });
    }
  });
});
