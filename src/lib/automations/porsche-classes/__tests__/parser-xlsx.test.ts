/**
 * Tests for porsche-classes/parser-xlsx — runs the parser against the
 * REAL Porsche fixture (`__fixtures__/porsche-daily-2026-04-20.xlsx`)
 * and asserts:
 *   - returns ParseSuccess
 *   - finds the expected count of distinct (course, date, location) classes
 *   - spot-checks one well-known class (BA101 · 2026-04-13 · Hilton Hotel)
 *   - rejects malformed input as ParseFailure (no throw)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseXlsx, parseReportDate } from "../parser-xlsx";
import type { ParseInput } from "@/lib/automations/types";

const FIXTURE = path.resolve(
  __dirname,
  "../__fixtures__/porsche-daily-2026-04-20.xlsx",
);

function makeInput(bytes: Buffer): ParseInput {
  return {
    bytes,
    hint: "porsche-daily-2026-04-20.xlsx",
    received_at: "2026-04-20T19:00:00.000Z",
    source_message_id: "msg_test_1",
    source_artifact_id: "artifact_test_1",
  };
}

describe("parseReportDate", () => {
  it("parses Cornerstone date format", () => {
    expect(parseReportDate("Apr 13, 2026 6:00 PM")).toBe("2026-04-13");
  });

  it("handles single-digit days", () => {
    expect(parseReportDate("Apr 1, 2026 6:00 PM")).toBe("2026-04-01");
  });

  it("returns null for unrecognized strings", () => {
    expect(parseReportDate("not a date")).toBeNull();
    expect(parseReportDate("")).toBeNull();
    expect(parseReportDate(null)).toBeNull();
    expect(parseReportDate(undefined)).toBeNull();
  });

  it("accepts ISO `YYYY-MM-DD` prefix", () => {
    expect(parseReportDate("2026-05-04T12:00")).toBe("2026-05-04");
  });
});

describe("parseXlsx — real fixture", () => {
  it("parses the daily report and returns 14 distinct BA101/BA102 classes", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const result = await parseXlsx(makeInput(bytes));

    if (!result.ok) {
      throw new Error(`expected success, got: ${result.error}`);
    }
    expect(result.source_type).toBe("porsche_xlsx");
    // Ground truth: 14 distinct (course, date, location) tuples in the
    // 2026-04-20 fixture. Verified empirically.
    expect(result.snapshots.length).toBe(14);
  });

  it("spot-check: BA101 @ 2026-04-13 Hilton Hotel has 31 unique participants", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) throw new Error(`parse failed: ${result.error}`);

    const target = result.snapshots.find(
      (s) =>
        s.class.course_type === "BA101" &&
        s.class.class_date === "2026-04-13" &&
        s.class.location === "Hilton Hotel",
    );
    expect(target).toBeDefined();
    expect(target!.class.participants.length).toBe(31);
    // Participants are deduped + lowercased + sorted.
    expect(target!.class.participants).toEqual([...target!.class.participants].sort());
    for (const p of target!.class.participants) {
      expect(p).toBe(p.toLowerCase());
    }
  });

  it("every snapshot carries the artifact id + message id from input", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) throw new Error("parse failed");
    for (const s of result.snapshots) {
      expect(s.source_artifact_id).toBe("artifact_test_1");
      expect(s.source_message_id).toBe("msg_test_1");
      expect(s.source_type).toBe("porsche_xlsx");
    }
  });

  it("snapshots include participants_with_ppn in source_payload (auto-split join key)", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) throw new Error(`parse failed: ${result.error}`);
    const target = result.snapshots.find(
      (s) =>
        s.class.course_type === "BA101" &&
        s.class.class_date === "2026-04-13" &&
        s.class.location === "Hilton Hotel",
    );
    expect(target).toBeDefined();
    const payload = target!.source_payload as {
      participants_with_ppn: Array<{
        first: string;
        last: string;
        ppn_id: string | null;
      }>;
    };
    expect(payload.participants_with_ppn).toBeDefined();
    expect(payload.participants_with_ppn.length).toBe(31);
    // Each entry has a first + last; PPN can be null (rare) but the
    // overwhelming majority should be set on the real fixture.
    const withPpn = payload.participants_with_ppn.filter((p) => !!p.ppn_id);
    expect(withPpn.length).toBeGreaterThan(25);
    // PPN IDs are lowercased on the way in.
    for (const p of withPpn) {
      expect(p.ppn_id).toBe(p.ppn_id!.toLowerCase());
    }
    // Parallel cardinality with the canonicalized participants list
    // (post-dedupe). The two lists shouldn't drift in size on a
    // well-formed roster: every roster row should produce one entry
    // in both.
    expect(payload.participants_with_ppn.length).toBe(target!.class.participants.length);
  });
});

describe("parseXlsx — failure modes", () => {
  it("returns ParseFailure for non-xlsx bytes (does not throw)", async () => {
    const result = await parseXlsx(makeInput(Buffer.from("not an xlsx file")));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either xlsx threw (binary garbage) or it parsed into a tiny
      // sheet that fails the header-row check — both are acceptable
      // failure modes; what matters is the typed exception_kind.
      expect(["parse_failure", "missing_field"]).toContain(result.exception_kind);
    }
  });

  it("returns ParseFailure on empty bytes", async () => {
    const result = await parseXlsx(makeInput(Buffer.from("")));
    expect(result.ok).toBe(false);
  });
});
