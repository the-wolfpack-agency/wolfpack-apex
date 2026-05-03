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

/* ------------------------------------------------------------------ */
/* Synthesized fixtures — tolerant header detection                    */
/* ------------------------------------------------------------------ */

/**
 * Build a synthesized PCNA-shape workbook from a header row + N data
 * rows. The header layout is parameterized so we can simulate canonical
 * + drifted variants. Returns the .xlsx bytes.
 */
function buildSynthWorkbook(args: {
  headerRow: (string | null)[];
  /** 0-based row index where the header sits (some real exports prepend
   *  a logo/date row above the header). Defaults to 0. */
  headerAtIndex?: number;
  /** Rows AFTER the header. Each row is an array of cell values. */
  dataRows: (string | null)[][];
}): Buffer {
  const XLSX = require("xlsx") as typeof import("xlsx");
  const aoa: (string | null)[][] = [];
  const at = args.headerAtIndex ?? 0;
  for (let i = 0; i < at; i++) {
    aoa.push([`prelude row ${i}`]);
  }
  aoa.push(args.headerRow);
  for (const r of args.dataRows) aoa.push(r);
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

const CANONICAL_HEADERS: (string | null)[] = [
  null, // col 0 — empty (real exports often have a leading blank)
  null, // col 1 — empty
  "Module Properties-Module Title", // 2
  null, // 3 — empty
  "User Properties-Last Name", // 4
  "User Properties-First Name", // 5
  null, // 6
  "User Properties-Email Address", // 7
  "User Properties-User ID", // 8
  null, // 9..17 — placeholders
  null, null, null, null, null, null, null, null,
  "Training Center-Training Center Name", // 18
  "Session Properties-Facilities", // 19
  null, // 20
  "Session Properties-Start Date", // 21
];

function dataRowFor(args: {
  module: string;
  last: string;
  first: string;
  email: string;
  ppn: string;
  trainingCenter: string;
  facilities: string;
  startDate: string;
}): (string | null)[] {
  const row: (string | null)[] = new Array(22).fill(null);
  row[2] = args.module;
  row[4] = args.last;
  row[5] = args.first;
  row[7] = args.email;
  row[8] = args.ppn;
  row[18] = args.trainingCenter;
  row[19] = args.facilities;
  row[21] = args.startDate;
  return row;
}

describe("parseXlsx — synthesized canonical headers", () => {
  it("parses a canonical-shape workbook into one snapshot", async () => {
    const bytes = buildSynthWorkbook({
      headerRow: CANONICAL_HEADERS,
      headerAtIndex: 6,
      dataRows: [
        dataRowFor({
          module: "Brand Ambassador 101 Skills (Classroom)",
          last: "Smith",
          first: "Alex",
          email: "alex@example.com",
          ppn: "asmith",
          trainingCenter: "Hilton Hotel",
          facilities: "",
          startDate: "May 1, 2026 9:00 AM",
        }),
      ],
    });
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) throw new Error(`parse failed: ${result.error}`);
    expect(result.snapshots.length).toBe(1);
    expect(result.snapshots[0].class.course_type).toBe("BA101");
    expect(result.snapshots[0].class.class_date).toBe("2026-05-01");
    expect(result.snapshots[0].class.location).toBe("Hilton Hotel");
  });
});

describe("parseXlsx — drifted headers (the prod bug fixture)", () => {
  it("parses a workbook where 'Module Properties-Module Title' is empty but 'Module Title' synonym is present elsewhere", async () => {
    /* The real prod failure: header column 2 was empty (""), but the
       canonical "Module Title" name appeared in a different column. The
       legacy by-index parser quarantined; the new by-name parser should
       resolve it from the synonym column instead. */
    const drifted: (string | null)[] = [...CANONICAL_HEADERS];
    drifted[2] = ""; // empty cell (the prod bug shape)
    drifted[3] = "Module Title"; // canonical synonym lands one column to the right
    const dataRow = dataRowFor({
      module: "PLACEHOLDER", // col 2 — won't be read; col 3 is the actual module column now
      last: "Drifted",
      first: "Header",
      email: "d@example.com",
      ppn: "dheader",
      trainingCenter: "Conrad Westlake",
      facilities: "",
      startDate: "May 2, 2026 10:00 AM",
    });
    dataRow[3] = "Brand Ambassador 102 Management (Classroom)";
    dataRow[2] = null; // ensure col 2 doesn't accidentally win
    const bytes = buildSynthWorkbook({
      headerRow: drifted,
      headerAtIndex: 6,
      dataRows: [dataRow],
    });
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) {
      throw new Error(`expected by-name resolution to succeed, got: ${result.error}`);
    }
    expect(result.snapshots.length).toBe(1);
    expect(result.snapshots[0].class.course_type).toBe("BA102");
  });

  it("tolerates header at row 0 (no prelude rows) and resolves synonyms case-insensitively", async () => {
    const lowercase: (string | null)[] = CANONICAL_HEADERS.map((h) =>
      h === null ? null : h.toLowerCase(),
    );
    const bytes = buildSynthWorkbook({
      headerRow: lowercase,
      headerAtIndex: 0, // no prelude
      dataRows: [
        dataRowFor({
          module: "Brand Ambassador 101 Skills",
          last: "Q",
          first: "Z",
          email: "qz@example.com",
          ppn: "qz",
          trainingCenter: "Pendry",
          facilities: "",
          startDate: "May 3, 2026 9:00 AM",
        }),
      ],
    });
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.snapshots.length).toBe(1);
    expect(result.snapshots[0].class.location).toBe("Pendry");
  });
});

describe("parseXlsx — required column genuinely missing", () => {
  it("quarantines with a CLEAR message naming the SPECIFIC missing canonical column(s)", async () => {
    /* Drop the start-date column entirely — required column missing. */
    const noDate: (string | null)[] = [...CANONICAL_HEADERS];
    noDate[21] = null; // remove the start-date header
    const dataRow = dataRowFor({
      module: "Brand Ambassador 101",
      last: "X",
      first: "Y",
      email: "xy@example.com",
      ppn: "xy",
      trainingCenter: "Hilton",
      facilities: "",
      startDate: "May 1, 2026 9:00 AM",
    });
    dataRow[21] = null;
    const bytes = buildSynthWorkbook({
      headerRow: noDate,
      headerAtIndex: 6,
      dataRows: [dataRow],
    });
    const result = await parseXlsx(makeInput(bytes));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exception_kind).toBe("parse_failure");
    // The error message should NAME the missing canonical column, not
    // the misleading "expected X got Y" pattern from the legacy parser.
    expect(result.error).toMatch(/Session Properties-Start Date/);
    // The structured detail should carry the missing-columns list so
    // the reprocess endpoint + dashboard can surface it cleanly.
    const detail = result.detail as
      | { missing_required_columns?: string[] }
      | undefined;
    expect(detail?.missing_required_columns).toEqual(
      expect.arrayContaining(["start_date"]),
    );
  });

  it("ingests with null email when the OPTIONAL email column is missing", async () => {
    /* Email is in OPTIONAL_COLUMNS — its absence must NOT fail the
       artifact. We assert: parser succeeds, snapshot still has the
       row, and the parser doesn't crash on the missing-column read. */
    const noEmail: (string | null)[] = [...CANONICAL_HEADERS];
    noEmail[7] = null; // remove email header
    const dataRow = dataRowFor({
      module: "Brand Ambassador 101",
      last: "OptCol",
      first: "Test",
      email: "",
      ppn: "octst",
      trainingCenter: "Hilton",
      facilities: "",
      startDate: "May 1, 2026 9:00 AM",
    });
    dataRow[7] = null;
    const bytes = buildSynthWorkbook({
      headerRow: noEmail,
      headerAtIndex: 6,
      dataRows: [dataRow],
    });
    const result = await parseXlsx(makeInput(bytes));
    if (!result.ok) {
      throw new Error(
        `expected optional-column-missing path to succeed, got: ${result.error}`,
      );
    }
    expect(result.snapshots.length).toBe(1);
  });
});
