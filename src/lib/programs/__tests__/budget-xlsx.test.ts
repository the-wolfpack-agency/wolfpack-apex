/**
 * xlsx round-trip tests — drive the importer with the actual WPA file
 * the user uploaded so production behavior is verified, not just an
 * idealized fixture. The file is loaded from a stable path under
 * test-fixtures/ so this stays hermetic across machines.
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseBudgetXlsx,
  buildBudgetXlsx,
  type ExportInput,
} from "@/lib/programs/budget-xlsx";

const FIXTURE = path.resolve(
  __dirname,
  "../../../../test-fixtures/wpa-cost-budget-template.xlsx",
);

function fixtureExists(): boolean {
  try {
    fs.accessSync(FIXTURE);
    return true;
  } catch {
    return false;
  }
}

(fixtureExists() ? describe : describe.skip)(
  "parseBudgetXlsx — real WPA template",
  () => {
    test("reads spec block + parses every detail line", async () => {
      const bytes = fs.readFileSync(FIXTURE);
      const parsed = await parseBudgetXlsx(bytes);

      expect(parsed.specs).toBeDefined();

      // The template has 31 categories with detail-line scaffolding —
      // confirm the parser picks up known section headers + every line
      // carries numeric units/rate/total.
      const cats = new Set(parsed.lines.map((l) => l.category.toLowerCase()));
      expect(cats.has("creative / editorial")).toBe(true);
      expect(cats.has("project management & administration")).toBe(true);
      expect(parsed.lines.length).toBeGreaterThan(0);

      for (const ln of parsed.lines) {
        expect(typeof ln.units).toBe("number");
        expect(typeof ln.rate).toBe("number");
        expect(typeof ln.total).toBe("number");
      }
    });
  },
);

describe("parseBudgetXlsx — synthetic minimum", () => {
  test("still extracts known categories from a hand-built fixture", async () => {
    /* Build a small valid xlsx and parse it back. Confirms the parser
       isn't incidentally tied to the WPA file's quirks. */
    const built = await buildBudgetXlsx({
      jobName: "Synthetic",
      jobNumber: "S-1",
      version: "v1",
      specs: {
        jobName: "Synthetic",
        jobNumber: "S-1",
        version: "v1",
        weeks: 1,
        prepEventDays: null,
        markets: 2,
        eventDays: null,
        teams: null,
        hotel: null,
        ballroom: null,
        breakoutRooms: null,
        tents: null,
        clearSpanFrame: null,
        vehicles: null,
        staticDisplay: null,
        drive: null,
        competitors: null,
      },
      fixedSubtotal: 1500,
      variableSubtotal: 500,
      contingencyAmount: 100,
      grandTotal: 2100,
      lines: [
        {
          categoryName: "Creative / Editorial",
          categoryKind: "fixed",
          costCode: 5.0001,
          responsible: "NH",
          lineNumber: "1",
          description: "Designer",
          name: "Jane",
          units: 10,
          rate: 150,
          total: 1500,
        },
        {
          categoryName: "Airline",
          categoryKind: "variable",
          costCode: 11.0001,
          responsible: "NH",
          lineNumber: "1",
          description: "DEN→CLT",
          name: "Crew",
          units: 2,
          rate: 250,
          total: 500,
        },
      ],
    });
    const parsed = await parseBudgetXlsx(built);
    const cats = new Set(parsed.lines.map((l) => l.category.toLowerCase()));
    expect(cats.has("creative / editorial")).toBe(true);
    expect(cats.has("airline")).toBe(true);
    const creative = parsed.lines.find(
      (l) => l.category.toLowerCase() === "creative / editorial",
    )!;
    expect(creative.units).toBe(10);
    expect(creative.rate).toBe(150);
    expect(creative.total).toBe(1500);
  });
});

describe("buildBudgetXlsx", () => {
  const baseInput: ExportInput = {
    jobName: "Demo",
    jobNumber: "D-1",
    version: "v1",
    specs: {
      jobName: "Demo",
      jobNumber: "D-1",
      version: "v1",
      weeks: 2,
      prepEventDays: 3,
      markets: 4,
      eventDays: 5,
      teams: 2,
      hotel: 1,
      ballroom: 1,
      breakoutRooms: 2,
      tents: 0,
      clearSpanFrame: 0,
      vehicles: 4,
      staticDisplay: 1,
      drive: 1,
      competitors: 3,
    },
    fixedSubtotal: 1500,
    variableSubtotal: 500,
    contingencyAmount: 100,
    grandTotal: 2100,
    lines: [],
  };

  test("produces a byte stream with xlsx magic bytes (PK\\x03\\x04)", async () => {
    const out = await buildBudgetXlsx(baseInput);
    expect(out.length).toBeGreaterThan(100);
    expect(out[0]).toBe(0x50);
    expect(out[1]).toBe(0x4b);
  });

  test("output is a valid zip JSZip can re-open", async () => {
    const out = await buildBudgetXlsx(baseInput);
    const JSZip = (await import("jszip")).default;
    const reopened = await JSZip.loadAsync(out);
    expect(reopened.file("xl/workbook.xml")).not.toBeNull();
    expect(reopened.file("xl/worksheets/sheet1.xml")).not.toBeNull();
    const sheet = await reopened.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("Demo");
    expect(sheet).toContain("FIXED COSTS");
    expect(sheet).toContain("VARIABLE COSTS");
    expect(sheet).toContain("GRAND TOTAL");
  });
});
