/**
 * Survey parser stub — guardrail tests.
 *
 * Stream B's survey parser is a deliberate stub until Alicia provides a
 * real fixture. The stub MUST return a structured ParseFailure so the
 * ingest orchestrator surfaces a clear "needs format spec" exception
 * instead of silently dropping the artifact. These tests pin that
 * behaviour.
 */

import { parseSurvey, SURVEY_STUB_MESSAGE } from "../parser-survey";

const baseInput = {
  bytes: Buffer.from("anything"),
  hint: "survey-2026-04-20.pdf",
  received_at: "2026-04-20T22:00:00.000Z",
  source_message_id: null,
  source_artifact_id: "artifact-survey-stub",
};

describe("parseSurvey stub", () => {
  it("returns the contract-shaped ParseFailure", async () => {
    const result = await parseSurvey(baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.source_type).toBe("survey");
    expect(result.exception_kind).toBe("parse_failure");
    expect(result.error).toBe(SURVEY_STUB_MESSAGE);
    expect(result.detail).toMatchObject({
      stub: true,
      hint: "survey-2026-04-20.pdf",
    });
    // The TODO list is part of the contract — the dashboard reads it
    // verbatim into the exception detail panel so Alicia knows what to
    // send.
    const todo = (result.detail as { todo?: string[] } | undefined)?.todo;
    expect(Array.isArray(todo)).toBe(true);
    expect(todo!.length).toBeGreaterThan(0);
  });
});
