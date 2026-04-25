/**
 * Cognito HTML extraction helper — fixture tests.
 *
 * The eml fixtures are real Cognito Forms emails captured from Alicia's
 * inbox. Both the multipart parser and the HTML field extractor are
 * exercised against unmodified bytes so any regression in either path
 * surfaces here.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  buildClassKey,
  collapseWs,
  decodeHeaderWord,
  decodeQuotedPrintable,
  extractEmlParts,
  normalizeClassDate,
  normalizeLocation,
  parseCognitoHtml,
} from "../cognito-html";

const FIXTURES = join(__dirname, "..", "__fixtures__");
const COORDINATOR_AMY = join(
  FIXTURES,
  "Coordinator Class Report - Amy Federman.eml",
);

describe("decodeQuotedPrintable", () => {
  it("decodes hex escapes and soft line breaks", () => {
    const out = decodeQuotedPrintable("Hello=\r\n =3D World");
    expect(out).toBe("Hello = World");
  });

  it("decodes utf-8 multibyte sequences correctly", () => {
    // U+2019 right single quote = E2 80 99 in utf-8
    const out = decodeQuotedPrintable("hello=E2=80=99s");
    expect(out).toBe("hello’s");
  });
});

describe("decodeHeaderWord", () => {
  it("decodes RFC 2047 Q encoding", () => {
    const out = decodeHeaderWord(
      "=?utf-8?Q?Coordinator=20Class=20Report=20-=20Amy=20Federman?=",
    );
    expect(out).toBe("Coordinator Class Report - Amy Federman");
  });

  it("returns plain text unchanged", () => {
    expect(decodeHeaderWord("Plain Subject")).toBe("Plain Subject");
  });

  it("decodes RFC 2047 B encoding", () => {
    // base64 of "Hello"
    const out = decodeHeaderWord("=?utf-8?B?SGVsbG8=?=");
    expect(out).toBe("Hello");
  });
});

describe("extractEmlParts on a real Cognito coordinator fixture", () => {
  const raw = readFileSync(COORDINATOR_AMY);

  it("recovers the subject", () => {
    const parts = extractEmlParts(raw);
    expect(parts.subject).toBe(
      "Coordinator Class Report - Amy Federman",
    );
  });

  it("recovers the From header", () => {
    const parts = extractEmlParts(raw);
    expect(parts.from).toContain("notifications@cognitoforms.com");
  });

  it("recovers the Date header", () => {
    const parts = extractEmlParts(raw);
    expect(parts.date).toBeTruthy();
    expect(new Date(parts.date!).toISOString()).toMatch(/2026-04-20/);
  });

  it("strips angle brackets from Message-Id", () => {
    const parts = extractEmlParts(raw);
    expect(parts.message_id).toBeTruthy();
    expect(parts.message_id).not.toMatch(/^</);
    expect(parts.message_id).not.toMatch(/>$/);
  });

  it("extracts both text/plain and text/html parts", () => {
    const parts = extractEmlParts(raw);
    expect(parts.text).toBeTruthy();
    expect(parts.html).toBeTruthy();
    expect(parts.text!.length).toBeGreaterThan(500);
    expect(parts.html!.length).toBeGreaterThan(5000);
  });

  it("decodes quoted-printable in the html body", () => {
    const parts = extractEmlParts(raw);
    // After decoding, the soft line breaks are gone and `=3D` -> `=`.
    expect(parts.html!).toContain('class="real-table-container"');
    expect(parts.html!).not.toContain("=3D");
  });
});

describe("parseCognitoHtml on the Amy Federman coordinator fixture", () => {
  const raw = readFileSync(COORDINATOR_AMY);
  const parts = extractEmlParts(raw);
  const fields = parseCognitoHtml(parts.html!);

  it("identifies the form title", () => {
    expect(fields.formTitle).toBe("Coordinator Class Report");
  });

  it("captures the Entry Details section as the first section", () => {
    expect(fields.sections[0].heading).toBe("Entry Details");
  });

  it("captures every expected coordinator section heading", () => {
    const headings = fields.sections.map((s) => s.heading);
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

  it("extracts every class identity field via byLabel", () => {
    expect(fields.byLabel["Name"]).toBe("Amy Federman");
    expect(fields.byLabel["Email"]).toBe("amy@porscheacademy.us");
    expect(fields.byLabel["Class Date"]).toBe("4/13/2026");
    expect(fields.byLabel["Class"]).toBe("BA101");
    expect(fields.byLabel["Class Location"]).toBe("Westlake");
    expect(fields.byLabel["Total number of participants"]).toBe("29");
  });

  it("captures free-text answers verbatim", () => {
    expect(fields.byLabel["Were there any no shows?"]).toBe("Yes");
    expect(
      fields.byLabel["Please list name & dealership of no shows"],
    ).toContain("Eli Acosta");
  });

  it("preserves section grouping for free-text answers", () => {
    const dinner = fields.sections.find((s) => s.heading === "Dinner Outing");
    expect(dinner).toBeDefined();
    const labels = dinner!.fields.map((f) => f.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Were there any issues with dinner event?",
      ]),
    );
  });
});

describe("normalizers", () => {
  it("normalizeClassDate accepts US M/D/YYYY", () => {
    expect(normalizeClassDate("4/13/2026")).toBe("2026-04-13");
    expect(normalizeClassDate("04/13/2026")).toBe("2026-04-13");
  });

  it("normalizeClassDate accepts ISO already", () => {
    expect(normalizeClassDate("2026-04-13")).toBe("2026-04-13");
  });

  it("normalizeClassDate returns null for garbage", () => {
    expect(normalizeClassDate("April 13, 2026")).toBeNull();
    expect(normalizeClassDate("")).toBeNull();
  });

  it("normalizeLocation title-cases multi-word locations", () => {
    expect(normalizeLocation("westlake")).toBe("Westlake");
    expect(normalizeLocation("LOS ANGELES")).toBe("Los Angeles");
    expect(normalizeLocation(" san  francisco ")).toBe("San Francisco");
  });

  it("normalizeLocation strips trailing punctuation", () => {
    expect(normalizeLocation("Westlake.")).toBe("Westlake");
  });

  it("collapseWs trims and collapses internal whitespace", () => {
    expect(collapseWs("  a   b\n c  ")).toBe("a b c");
  });

  it("buildClassKey produces course|date|location", () => {
    expect(buildClassKey("BA101", "2026-04-13", "Westlake")).toBe(
      "BA101|2026-04-13|Westlake",
    );
  });
});
