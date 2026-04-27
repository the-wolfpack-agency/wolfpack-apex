/**
 * Coordinator parser fixture tests.
 *
 * Real Cognito Forms emails captured from Alicia's inbox. We assert on
 * every contract field: identity (course_type / class_date / location),
 * source_payload shape, the snapshot stays empty for participants
 * (xlsx is the canonical roster), and the failure paths behave well on
 * malformed input.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parseCognitoCoordinator } from "../parser-cognito-coordinator";
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

describe("parseCognitoCoordinator — Amy Federman fixture", () => {
  let result: Awaited<ReturnType<typeof parseCognitoCoordinator>>;

  beforeAll(async () => {
    result = await parseCognitoCoordinator(
      fixtureInput("Coordinator Class Report - Amy Federman.eml"),
    );
  });

  it("returns ok=true with one snapshot", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshots).toHaveLength(1);
    expect(result.source_type).toBe("cognito_coordinator");
  });

  it("derives course_type, class_date, location correctly", () => {
    if (!result.ok) throw new Error("expected ok");
    const snap = result.snapshots[0];
    expect(snap.class.course_type).toBe("BA101");
    expect(snap.class.class_date).toBe("2026-04-13");
    expect(snap.class.location).toBe("Westlake");
  });

  it("leaves participants empty (canonical list comes from xlsx)", () => {
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshots[0].class.participants).toEqual([]);
  });

  it("captures coordinator identity in source_payload", () => {
    if (!result.ok) throw new Error("expected ok");
    const payload = result.snapshots[0].source_payload!;
    expect(payload.coordinator_name).toBe("Amy Federman");
    expect(payload.coordinator_email).toBe("amy@porscheacademy.us");
    expect(payload.participant_count).toBe(29);
  });

  it("preserves the full byLabel field map", () => {
    if (!result.ok) throw new Error("expected ok");
    const fields = result.snapshots[0].source_payload!.fields as Record<string, string>;
    expect(fields["Class"]).toBe("BA101");
    expect(fields["Were there any no shows?"]).toBe("Yes");
    expect(fields["Please list name & dealership of no shows"]).toContain(
      "Eli Acosta",
    );
  });

  it("preserves section grouping for the renderer", () => {
    if (!result.ok) throw new Error("expected ok");
    const sections = result.snapshots[0].source_payload!.sections as Array<{
      heading: string;
      fields: Array<{ label: string; value: string }>;
    }>;
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual(
      expect.arrayContaining([
        "Entry Details",
        "Hotel Experience",
        "Dinner Outing",
        "Transportation",
        "General Class Logistics",
      ]),
    );
  });

  it("captures the message id from the email envelope", () => {
    if (!result.ok) throw new Error("expected ok");
    const snap = result.snapshots[0];
    expect(snap.source_message_id).toBeTruthy();
    expect(snap.source_message_id).not.toMatch(/^</);
  });

  it("captures captured_at from the email Date header (not received_at)", () => {
    if (!result.ok) throw new Error("expected ok");
    const snap = result.snapshots[0];
    // Email Date is 2026-04-20 21:24:31 UTC.
    expect(snap.captured_at).toMatch(/2026-04-20/);
  });

  it("includes the canonical class_key in source_payload", () => {
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshots[0].source_payload!.class_key).toBe(
      "BA101|2026-04-13|Westlake",
    );
  });
});

describe("parseCognitoCoordinator — Corrine DeArmitt fixture", () => {
  it("parses the second coordinator report cleanly", async () => {
    const result = await parseCognitoCoordinator(
      fixtureInput("Coordinator Class Report - Corrine DeArmitt.eml"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const snap = result.snapshots[0];
    // Class identity must parse — we don't assert specific values
    // because Corrine's class might be in a different city/date than
    // Amy's. We just assert all three required fields are present and
    // well-formed.
    expect(snap.class.course_type).toMatch(/^BA10[12]$/);
    expect(snap.class.class_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snap.class.location.length).toBeGreaterThan(0);
    const payload = snap.source_payload!;
    expect(payload.coordinator_name).toBe("Corrine DeArmitt");
  });
});

describe("parseCognitoCoordinator — failure paths", () => {
  it("rejects an instructor email subject", async () => {
    const bytes = readFileSync(
      join(FIXTURES, "Instructor Class Report - Jen Eby.eml"),
    );
    const result = await parseCognitoCoordinator({
      bytes,
      hint: "Instructor Class Report - Jen Eby.eml",
      received_at: "2026-04-20T22:00:00.000Z",
      source_message_id: null,
      source_artifact_id: "artifact-instructor-as-coordinator",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exception_kind).toBe("parse_failure");
    expect(result.error).toMatch(/Coordinator Class Report/);
  });

  it("returns parse_failure when the body is empty", async () => {
    const result = await parseCognitoCoordinator({
      bytes: Buffer.from(""),
      hint: "empty",
      received_at: "2026-04-20T22:00:00.000Z",
      source_message_id: null,
      source_artifact_id: "artifact-empty",
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseCognitoCoordinator — Outlook 'Save as .eml' resilience", () => {
  // Regression — 2026-04-27. Outlook web's "Save as .eml" save path
  // strips the original Cognito form-title <h2> from the HTML such
  // that no <h2> in the resulting body matches /Class Report/i.
  // Confirmed against the BA101 2026-04-20 Corrine DeArmitt .eml:
  // 3 separate Backfill uploads (content_sha256 9f5e254c...) all
  // quarantined with `Form title does not match Coordinator Class
  // Report: "Hotel Experience"`. Subject was correct, all field
  // labels were correct — only the form title h2 was missing.
  // The fix relaxes form-title to a soft signal and trusts the
  // already-validated subject + field-presence checks.
  //
  // Test strategy: take the real Amy Federman fixture (which has
  // both the form-title h2 AND the field tables), strip the form-
  // title h2 from its HTML, and confirm the parser STILL succeeds
  // because subject + field-presence pass.

  it("parses a real-shape .eml after the form-title h2 is stripped", async () => {
    const fixturePath = join(
      FIXTURES,
      "Coordinator Class Report - Amy Federman.eml",
    );
    const raw = readFileSync(fixturePath, "utf8");
    // Remove any <h2>...Coordinator Class Report...</h2> from the body.
    const stripped = raw.replace(
      /<h2[^>]*>[^<]*Coordinator Class Report[^<]*<\/h2>/gi,
      "",
    );
    const result = await parseCognitoCoordinator({
      bytes: Buffer.from(stripped, "utf8"),
      hint: "Coordinator Class Report - Amy Federman.eml",
      received_at: "2026-04-20T22:00:00.000Z",
      source_message_id: null,
      source_artifact_id: "artifact-outlook-saved",
    });
    if (!result.ok) {
      throw new Error(
        `expected ok=true; got error="${result.error}" exception_kind="${result.exception_kind}"`,
      );
    }
    expect(result.snapshots).toHaveLength(1);
    const snap = result.snapshots[0];
    expect(snap.class.course_type).toBe("BA101");
    expect(snap.class.class_date).toBe("2026-04-13");
    expect(snap.class.location).toBe("Westlake");
  });
});
