/**
 * Instructor parser fixture tests — three real instructor reports.
 *
 * The instructor form has fewer questions than the coordinator form
 * but the class-identity contract is identical. We assert each fixture
 * parses, preserves the instructor's name, and captures every section
 * via byLabel + sections.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parseCognitoInstructor } from "../parser-cognito-instructor";
import type { ParseInput } from "../../types";

const FIXTURES = join(__dirname, "..", "__fixtures__");

function fixtureInput(filename: string): ParseInput {
  const bytes = readFileSync(join(FIXTURES, filename));
  return {
    bytes,
    hint: filename,
    received_at: "2026-04-20T22:00:00.000Z",
    source_message_id: null,
    source_artifact_id: `artifact-${filename}`,
  };
}

describe.each([
  ["Instructor Class Report - Jen Eby.eml", "Jen Eby"],
  ["Instructor Class Report - Lorena Norman.eml", "Lorena Norman"],
  ["Instructor Class Report - Scott Leder.eml", "Scott Leder"],
])("parseCognitoInstructor — %s", (filename, expectedInstructor) => {
  let result: Awaited<ReturnType<typeof parseCognitoInstructor>>;

  beforeAll(async () => {
    result = await parseCognitoInstructor(fixtureInput(filename));
  });

  it("returns ok=true with one snapshot tagged cognito_instructor", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshots).toHaveLength(1);
    expect(result.source_type).toBe("cognito_instructor");
    expect(result.snapshots[0].source_type).toBe("cognito_instructor");
  });

  it("parses class identity into the contract shape", () => {
    if (!result.ok) throw new Error("expected ok");
    const snap = result.snapshots[0];
    expect(snap.class.course_type).toMatch(/^BA10[12]$/);
    expect(snap.class.class_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snap.class.location.length).toBeGreaterThan(0);
    expect(snap.class.participants).toEqual([]);
  });

  it("captures the instructor's name + email in source_payload", () => {
    if (!result.ok) throw new Error("expected ok");
    const payload = result.snapshots[0].source_payload!;
    expect(payload.instructor_name).toBe(expectedInstructor);
    expect(payload.instructor_email).toMatch(/@porscheacademy\.us$/);
  });

  it("preserves byLabel + sections", () => {
    if (!result.ok) throw new Error("expected ok");
    const payload = result.snapshots[0].source_payload!;
    const fields = payload.fields as Record<string, string>;
    expect(fields["Class"]).toMatch(/^BA10[12]$/);
    const sections = payload.sections as Array<{ heading: string }>;
    const headings = sections.map((s) => s.heading);
    // "Entry Details" is always present; the rest of the form has free
    // -text questions either inside Entry Details or under their own
    // headings depending on Cognito layout drift. We just assert
    // Entry Details is present.
    expect(headings).toContain("Entry Details");
  });

  it("class_key matches course|date|location", () => {
    if (!result.ok) throw new Error("expected ok");
    const snap = result.snapshots[0];
    const expected = `${snap.class.course_type}|${snap.class.class_date}|${snap.class.location}`;
    expect(snap.source_payload!.class_key).toBe(expected);
  });
});

describe("parseCognitoInstructor — failure paths", () => {
  it("rejects a coordinator email subject", async () => {
    const bytes = readFileSync(
      join(FIXTURES, "Coordinator Class Report - Amy Federman.eml"),
    );
    const result = await parseCognitoInstructor({
      bytes,
      hint: "Coordinator Class Report - Amy Federman.eml",
      received_at: "2026-04-20T22:00:00.000Z",
      source_message_id: null,
      source_artifact_id: "artifact-coordinator-as-instructor",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exception_kind).toBe("parse_failure");
    expect(result.error).toMatch(/Instructor Class Report/);
  });

  it("returns parse_failure when bytes are empty", async () => {
    const result = await parseCognitoInstructor({
      bytes: Buffer.from(""),
      hint: "empty",
      received_at: "2026-04-20T22:00:00.000Z",
      source_message_id: null,
      source_artifact_id: "artifact-empty-instructor",
    });
    expect(result.ok).toBe(false);
  });
});
