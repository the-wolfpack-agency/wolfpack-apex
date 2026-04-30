/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import {
  detectCorrection,
  extractSubject,
  captureFactFromCorrection,
  findRelevantFacts,
  renderFactsBlock,
} from "@/lib/assistant/learning";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockSafeQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

describe("detectCorrection", () => {
  test("'no, it is Porsche' captures value=Porsche, attribute inferred from prior 'client'", () => {
    const r = detectCorrection(
      "no, it is Porsche",
      "The meeting is associated with the client TWA.",
    );
    expect(r).toEqual({ attribute: "client", value: "Porsche" });
  });

  test("'actually it's Jorge' with prior 'owner' → attribute=owner", () => {
    const r = detectCorrection(
      "actually it's Jorge Colon",
      "The owner of this project is Nick.",
    );
    expect(r).toEqual({ attribute: "owner", value: "Jorge Colon" });
  });

  test("'the client is actually Porsche' explicit attribute", () => {
    const r = detectCorrection("the client is actually Porsche", "");
    expect(r).toEqual({ attribute: "client", value: "Porsche" });
  });

  test("plain unrelated reply returns null", () => {
    const r = detectCorrection("thanks!", "Some prior answer.");
    expect(r).toBeNull();
  });

  test("'correction: Porsche' shorthand", () => {
    const r = detectCorrection("correction: Porsche", "client TWA");
    expect(r?.value).toBe("Porsche");
  });
});

describe("extractSubject", () => {
  test("prefers double-quoted phrase", () => {
    expect(
      extractSubject(
        'On April 30, the meeting was "24G x TWA: PowerBI Access" with team',
      ),
    ).toBe("24G x TWA: PowerBI Access");
  });

  test("falls back to title-cased multi-word phrase", () => {
    expect(
      extractSubject("The Wolfpack Weekly Kickoff happened on Tuesday."),
    ).toContain("Wolfpack Weekly");
  });

  test("skips date-led phrases like 'April 30, 2026'", () => {
    const out = extractSubject("On April 30, 2026, Acme Sync was canceled");
    expect(out).not.toMatch(/^April/);
  });
});

describe("captureFactFromCorrection", () => {
  test("returns null when correction not detected", async () => {
    const r = await captureFactFromCorrection({
      userMessage: "ok thanks",
      priorAssistantContent: "Some prior answer",
      priorAssistantMessageId: "m-1",
      userId: "u-1",
      userRole: "cto",
    });
    expect(r).toBeNull();
  });

  test("inserts a row when correction detected", async () => {
    /* update existing matches → no-op rows: [] */
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [] }) // initial supersede
      .mockResolvedValueOnce({
        rows: [
          {
            id: "f-1",
            subject: "24G x TWA: PowerBI Access",
            attribute: "client",
            value: "Porsche",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // supersede prior facts
    const r = await captureFactFromCorrection({
      userMessage: "no, it is Porsche",
      priorAssistantContent:
        'The meeting "24G x TWA: PowerBI Access" is associated with the client TWA.',
      priorAssistantMessageId: "m-1",
      userId: "u-1",
      userRole: "cto",
    });
    expect(r).toEqual(
      expect.objectContaining({ attribute: "client", value: "Porsche" }),
    );
    expect(mockSafeQuery).toHaveBeenCalledTimes(3);
  });
});

describe("findRelevantFacts + renderFactsBlock", () => {
  test("returns substring matches", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "f-1",
          subject: "24G x TWA: PowerBI Access",
          attribute: "client",
          value: "Porsche",
        },
      ],
    });
    const r = await findRelevantFacts(
      "which client is the 24G x TWA meeting tied to?",
    );
    expect(r).toHaveLength(1);
    expect(r[0].value).toBe("Porsche");
    const block = renderFactsBlock(r);
    expect(block).toContain("ground truth");
    expect(block).toContain("Porsche");
  });

  test("renderFactsBlock returns empty string for no facts", () => {
    expect(renderFactsBlock([])).toBe("");
  });
});
