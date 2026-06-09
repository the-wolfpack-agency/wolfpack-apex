/**
 * Pure unit tests for the survey validation core.
 *
 * SECURITY: validateAnswers gates the unauthenticated public submit path,
 * so its tests are deliberately exhaustive — every type, the required/optional
 * branch, choice membership, dedupe, the 5000-char text cap, rating range,
 * and the unknown-question rejection that stops attackers stuffing arbitrary
 * keys into a stored response.
 */

import {
  validateSchema,
  validateAnswers,
  aggregateResponses,
  generateSurveySlug,
} from "../validate";
import type { SurveySchema } from "../types";

/** A schema that exercises every question type. */
function fullSchema(): SurveySchema {
  return {
    questions: [
      { id: "name", type: "short_text", label: "Your name", required: true },
      { id: "bio", type: "long_text", label: "About you", required: false },
      {
        id: "color",
        type: "single_choice",
        label: "Favorite color",
        required: true,
        options: ["red", "green", "blue"],
      },
      {
        id: "langs",
        type: "multiple_choice",
        label: "Languages",
        required: false,
        options: ["en", "es", "fr"],
      },
      { id: "score", type: "rating", label: "Rate us", required: false, max: 5 },
    ],
  };
}

describe("validateSchema", () => {
  test("a valid schema passes", () => {
    expect(validateSchema(fullSchema())).toEqual({ ok: true });
  });

  test("non-object schema fails", () => {
    expect(validateSchema(null).ok).toBe(false);
    expect(validateSchema("nope").ok).toBe(false);
    expect(validateSchema(42).ok).toBe(false);
  });

  test("empty questions list fails", () => {
    const r = validateSchema({ questions: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one question/);
  });

  test("missing questions array fails", () => {
    expect(validateSchema({}).ok).toBe(false);
  });

  test("a non-object question fails", () => {
    expect(validateSchema({ questions: [null] }).ok).toBe(false);
  });

  test("missing/empty id fails", () => {
    const r = validateSchema({
      questions: [{ type: "short_text", label: "x", required: true }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty id/);
    expect(
      validateSchema({
        questions: [{ id: "", type: "short_text", label: "x", required: true }],
      }).ok,
    ).toBe(false);
  });

  test("duplicate id fails", () => {
    const r = validateSchema({
      questions: [
        { id: "dup", type: "short_text", label: "a", required: true },
        { id: "dup", type: "short_text", label: "b", required: true },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate question id: dup/);
  });

  test("unknown type fails", () => {
    const r = validateSchema({
      questions: [{ id: "q", type: "essay", label: "x", required: true }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown question type/);
  });

  test("missing/blank label fails", () => {
    expect(
      validateSchema({
        questions: [{ id: "q", type: "short_text", required: true }],
      }).ok,
    ).toBe(false);
    expect(
      validateSchema({
        questions: [{ id: "q", type: "short_text", label: "   ", required: true }],
      }).ok,
    ).toBe(false);
  });

  test("non-boolean required fails", () => {
    expect(
      validateSchema({
        questions: [{ id: "q", type: "short_text", label: "x", required: "yes" }],
      }).ok,
    ).toBe(false);
  });

  test("choice question without options fails", () => {
    const r = validateSchema({
      questions: [
        { id: "q", type: "single_choice", label: "x", required: true },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/needs options/);
  });

  test("choice question with an empty option fails", () => {
    const r = validateSchema({
      questions: [
        {
          id: "q",
          type: "multiple_choice",
          label: "x",
          required: true,
          options: ["a", ""],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty option/);
  });

  test("rating with out-of-bounds max fails", () => {
    expect(
      validateSchema({
        questions: [{ id: "q", type: "rating", label: "x", required: true, max: 1 }],
      }).ok,
    ).toBe(false);
    expect(
      validateSchema({
        questions: [{ id: "q", type: "rating", label: "x", required: true, max: 11 }],
      }).ok,
    ).toBe(false);
  });

  test("rating without max is allowed (defaults to 5)", () => {
    expect(
      validateSchema({
        questions: [{ id: "q", type: "rating", label: "x", required: true }],
      }).ok,
    ).toBe(true);
  });
});

describe("validateAnswers", () => {
  const schema = fullSchema();

  test("non-object answers fail", () => {
    expect(validateAnswers(schema, null).ok).toBe(false);
    expect(validateAnswers(schema, []).ok).toBe(false);
    expect(validateAnswers(schema, "x").ok).toBe(false);
  });

  test("a fully valid answer map passes", () => {
    const r = validateAnswers(schema, {
      name: "Nick",
      bio: "hello",
      color: "blue",
      langs: ["en", "fr"],
      score: 4,
    });
    expect(r).toEqual({ ok: true });
  });

  test("required missing fails; optional missing is ok", () => {
    // name (required) omitted → fail
    const r = validateAnswers(schema, { color: "blue" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/);

    // only the two required answered, optionals omitted → ok
    expect(validateAnswers(schema, { name: "Nick", color: "red" })).toEqual({
      ok: true,
    });
  });

  test("required present-but-blank string fails", () => {
    const r = validateAnswers(schema, { name: "   ", color: "red" });
    expect(r.ok).toBe(false);
  });

  test("unknown question key fails", () => {
    const r = validateAnswers(schema, {
      name: "Nick",
      color: "red",
      injected: "evil",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown question: injected/);
  });

  test("short_text wrong type fails", () => {
    const r = validateAnswers(schema, { name: 123, color: "red" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expected text/);
  });

  test("text over the 5000-char cap fails; at the cap passes", () => {
    const over = validateAnswers(schema, {
      name: "Nick",
      color: "red",
      bio: "a".repeat(5001),
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/too long/);

    expect(
      validateAnswers(schema, {
        name: "Nick",
        color: "red",
        bio: "a".repeat(5000),
      }).ok,
    ).toBe(true);
  });

  test("single_choice must be one of the offered options", () => {
    expect(
      validateAnswers(schema, { name: "Nick", color: "purple" }).ok,
    ).toBe(false);
    expect(
      validateAnswers(schema, { name: "Nick", color: ["red"] }).ok,
    ).toBe(false);
  });

  test("multiple_choice must be an array of offered options, no dupes", () => {
    // not an array
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", langs: "en" }).ok,
    ).toBe(false);
    // contains an option not offered
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", langs: ["en", "de"] }).ok,
    ).toBe(false);
    // duplicate selection
    const dup = validateAnswers(schema, {
      name: "Nick",
      color: "red",
      langs: ["en", "en"],
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/duplicate/);
    // valid subset
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", langs: ["en", "es"] }).ok,
    ).toBe(true);
  });

  test("rating must be a whole number within 1..max", () => {
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", score: 0 }).ok,
    ).toBe(false);
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", score: 6 }).ok,
    ).toBe(false);
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", score: 3.5 }).ok,
    ).toBe(false);
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", score: "5" }).ok,
    ).toBe(false);
    expect(
      validateAnswers(schema, { name: "Nick", color: "red", score: 5 }).ok,
    ).toBe(true);
  });

  test("rating defaults max to 5 when unspecified", () => {
    const s: SurveySchema = {
      questions: [{ id: "r", type: "rating", label: "Rate", required: true }],
    };
    expect(validateAnswers(s, { r: 5 }).ok).toBe(true);
    expect(validateAnswers(s, { r: 6 }).ok).toBe(false);
  });
});

describe("aggregateResponses", () => {
  const schema = fullSchema();

  test("option counts, rating average, and text samples", () => {
    const rows = aggregateResponses(schema, [
      { name: "A", color: "red", langs: ["en"], score: 5, bio: "first" },
      { name: "B", color: "red", langs: ["en", "fr"], score: 3, bio: "second" },
      { name: "C", color: "blue", langs: [], score: 4 },
    ]);

    const byId = Object.fromEntries(rows.map((r) => [r.questionId, r]));

    // single_choice counts
    expect(byId.color.optionCounts).toEqual({ red: 2, green: 0, blue: 1 });
    expect(byId.color.answered).toBe(3);

    // multiple_choice counts (empty array isn't counted as answered)
    expect(byId.langs.optionCounts).toEqual({ en: 2, es: 0, fr: 1 });

    // rating average = (5+3+4)/3 = 4
    expect(byId.score.average).toBe(4);
    expect(byId.score.answered).toBe(3);

    // text samples
    expect(byId.name.textSamples).toEqual(["A", "B", "C"]);
    expect(byId.bio.textSamples).toEqual(["first", "second"]);
  });

  test("empty response set yields zeroed aggregates", () => {
    const rows = aggregateResponses(schema, []);
    const byId = Object.fromEntries(rows.map((r) => [r.questionId, r]));
    expect(byId.color.optionCounts).toEqual({ red: 0, green: 0, blue: 0 });
    expect(byId.score.average).toBe(0);
    expect(byId.name.textSamples).toEqual([]);
    rows.forEach((r) => expect(r.answered).toBe(0));
  });
});

describe("generateSurveySlug", () => {
  test("produces a 7-char slug from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      const slug = generateSurveySlug();
      expect(slug).toHaveLength(7);
      expect(slug).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{7}$/);
    }
  });
});
