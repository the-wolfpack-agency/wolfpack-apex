/* eslint-disable @typescript-eslint/no-explicit-any */
const mockSearchBrain = jest.fn();
jest.mock("@/lib/brain/repo", () => ({
  keywordSearch: (...a: any[]) => mockSearchBrain(...a),
}));

import { runBrainHistory } from "@/lib/assistant/tools/brain-history";

beforeEach(() => {
  mockSearchBrain.mockReset();
});

describe("runBrainHistory", () => {
  test("returns null when subject is blank", async () => {
    expect(await runBrainHistory({ subject: "   " })).toBeNull();
    expect(mockSearchBrain).not.toHaveBeenCalled();
  });

  test("returns null when search throws", async () => {
    mockSearchBrain.mockRejectedValue(new Error("qdrant down"));
    expect(await runBrainHistory({ subject: "Porsche engagement" })).toBeNull();
  });

  test("returns null when zero hits", async () => {
    mockSearchBrain.mockResolvedValue([]);
    expect(await runBrainHistory({ subject: "Porsche" })).toBeNull();
  });

  test("formats top hits + preview in the answer", async () => {
    mockSearchBrain.mockResolvedValue([
      {
        chunk_id: "c1",
        document_id: "doc-1",
        chunk_idx: 0,
        filename: "prebrief.md",
        kind: "ms365.prebrief",
        content: "Porsche engagement ran 14 days in Q3 2025 across 4 test drives.",
        score: 0.92,
        headline: "Porsche engagement ran 14 days in Q3 2025 across 4 test drives.",
      },
      {
        chunk_id: "c2",
        document_id: "doc-2",
        chunk_idx: 0,
        filename: "calendar.md",
        kind: "calendar.range",
        content: "Follow-up: Porsche scheduled a second engagement for Q4.",
        score: 0.81,
        headline: "Follow-up: Porsche scheduled a second engagement for Q4.",
      },
    ]);
    const out = await runBrainHistory({ subject: "Porsche engagement" });
    expect(out?.hits).toHaveLength(2);
    expect(out?.hits[0].content).toContain("14 days");
    expect(out?.answer).toContain("Porsche engagement");
  });
});
