/**
 * The first job worth handing to an agent, reachable by a person too.
 *
 * Every check behind this tool is something that went wrong this month and was
 * found by hand, late. None is a bug in a function; they are facts about
 * accumulated state that somebody has to go and ask for, which is the
 * definition of work to give a schedule.
 *
 * An operator asking "is the brain healthy" gets the same answer, from the
 * same reader, as the agent does. That is the only arrangement in which the
 * two stay honest about each other.
 */

const mockTrack = jest.fn();
const mockRead = jest.fn();

jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/brain/ingestion-health", () => ({
  readIngestionHealth: (...a: unknown[]) => mockRead(...a),
  summarizeHealth: (h: { readable: boolean; findings: unknown[] }) =>
    h.readable ? `${h.findings.length} things to look at.` : "could not be read, not the same as healthy",
}));

import { ingestionHealthTool, matchPipelineHealthIntent } from "@/lib/assistant/tools/ingestion-health-tool";

const CTX = { userId: "u1", userRole: "cto" } as never;

const HEALTHY = { takenAt: "t", readable: true, findings: [] };
const SICK = {
  takenAt: "t",
  readable: true,
  findings: [
    { id: "non_corpus_share", severity: "high", title: "84% are demo", detail: "140 of 884 real", action: "Sync the real libraries", count: 744 },
    { id: "stranded", severity: "medium", title: "2 stuck", detail: "over an hour", count: 2 },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue(HEALTHY);
});

describe("the words people use", () => {
  it.each([
    "is the brain healthy",
    "is the pipeline working",
    "brain health",
    "is anything stuck",
    "are our documents indexed",
    "how many documents failed",
    "health of the library",
  ])("%s reaches it", (p) => {
    expect(matchPipelineHealthIntent(p)).not.toBeNull();
  });

  it.each([
    "what does the SOW say",
    "find the contract",
    "how is the pilot going",
    "upload a document to the brain",
  ])("%s does not", (p) => {
    /* A question about a document's CONTENTS belongs to search. A matcher this
       shape is one careless widening away from eating every document question
       in the product. */
    expect(matchPipelineHealthIntent(p)).toBeNull();
  });
});

describe("the answer", () => {
  it("leads with the summary and names each finding with what to do", async () => {
    mockRead.mockResolvedValue(SICK);
    const res = await ingestionHealthTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toContain("84% are demo");
    expect(res.answer).toContain("Next: Sync the real libraries");
    expect(res.data).toMatchObject({ findingCount: 2, seriousCount: 1 });
  });

  it("spends no tokens, which is why it can run on a schedule", async () => {
    const res = await ingestionHealthTool.handler({}, CTX);
    if (!res.ok) return;
    /* A scheduled job that costs a model call per run is a job somebody turns
       off at the end of the month. */
    expect(res.sources).toBeUndefined();
    expect(ingestionHealthTool.capability).toBe("*");
  });

  it("says nothing is wrong only when it could actually look", async () => {
    const res = await ingestionHealthTool.handler({}, CTX);
    if (!res.ok) return;
    expect(res.answer).toContain("0 things to look at");
  });

  it("reports unreadable rather than clean", async () => {
    /* THE MISTAKE THE WHOLE MODULE EXISTS TO CATCH, made one layer up. An
       empty findings list from a dead database reads as a healthy pipeline. */
    mockRead.mockResolvedValue({ takenAt: "t", readable: false, findings: [] });
    const res = await ingestionHealthTool.handler({}, CTX);
    if (!res.ok) return;
    expect(res.answer).toMatch(/not the same as healthy/);
    expect((res.data as { readable: boolean }).readable).toBe(false);
  });

  it("records which findings fired, so a rising one is nameable in the data", async () => {
    mockRead.mockResolvedValue(SICK);
    await ingestionHealthTool.handler({}, CTX);
    const meta = mockTrack.mock.calls[0][3];
    expect(meta.findings).toBe("non_corpus_share,stranded");
    expect(meta.serious_count).toBe(1);
  });

  it("records 'none' rather than an empty string on a clean run", async () => {
    await ingestionHealthTool.handler({}, CTX);
    expect(mockTrack.mock.calls[0][3].findings).toBe("none");
  });
});
