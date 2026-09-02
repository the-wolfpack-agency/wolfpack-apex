/** @jest-environment node */
/**
 * A routine's narration step is kept short, on purpose.
 *
 * Measured 2026-09-02: the "read it all together" step averaged 463 output
 * tokens and 4.8 seconds, up to 18.8s, and was the dominant cost of "run my
 * morning" (16 seconds, reported). gpt-4o-mini generates tokens one at a time,
 * so the length of the answer IS the latency. It was also the readability
 * complaint: the brief came back as an essay with headings when a person
 * wanted the few things that matter.
 *
 * Two things keep it short and both are pinned here, because a later edit that
 * loosens either one brings the slow, bloated answer straight back:
 *   - the prompt asks for at most three short lines, no headings, no preamble;
 *   - the model call caps output tokens so an ignored instruction cannot run long.
 */

import { draftRoutine, type DayPlan } from "../day-plan";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the generated narration prompt asks for brevity", () => {
  /* buildDayPlan turns a described day into steps; the model step's prompt is
     where the length limit has to live, because that is what the model reads. */
  it("tells the model to keep it to a few short lines with no headings", () => {
    /* Two tool steps, so draftRoutine adds the 'read it all together' model
       step whose prompt carries the length limit. */
    const plan: DayPlan = {
      steps: [
        { kind: "tool", text: "the brief", tool: "good_morning_widget", description: "" },
        { kind: "tool", text: "my tasks", tool: "task_list_widget", description: "" },
      ],
      covered: 2,
      humanOnly: 0,
      gaps: 0,
    };
    const routine = draftRoutine(plan, "r1", "my morning");
    const modelStep = routine?.steps.find((s) => s.kind === "model");
    expect(modelStep).toBeTruthy();
    const prompt = (modelStep as { prompt: string }).prompt.toLowerCase();
    expect(prompt).toMatch(/three short|short points|one line each/);
    expect(prompt).toMatch(/no headings|no preamble/);
  });
});

describe("the model call caps the output length", () => {
  /* The ceiling is the backstop for a prompt the model does not fully obey.
     Asserted against the source so a bump back to 700 is caught in review. */
  it("keeps max_tokens well under the old 700", () => {
    const src = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    const m = src.match(/max_tokens:\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(400);
  });
});
