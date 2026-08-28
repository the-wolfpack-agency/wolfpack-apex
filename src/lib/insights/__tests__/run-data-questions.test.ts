/**
 * The insight agent: asking a client's data the questions worth asking.
 *
 * WHAT MATTERS HERE. Two properties carry the whole feature. It must ask as the
 * READER, because an insight panel that surfaced a document somebody was not
 * allowed to open would be a disclosure. And it must REPORT an empty answer
 * rather than dropping it, because the questions we cannot answer are the gap a
 * pilot exists to close, and a panel that silently hides them teaches a client
 * to distrust the findings it did show.
 */
import { runDataQuestions } from "@/lib/insights/run-data-questions";
import { DATA_QUESTIONS, isEmptyAnswer } from "@/lib/insights/data-questions";

const mockChat = jest.fn();
jest.mock("@/lib/assistant", () => ({ chat: (...a: unknown[]) => mockChat(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: () => undefined }));

beforeEach(() => jest.clearAllMocks());

describe("it asks as the reader, never with privilege", () => {
  it("passes the caller's own id and role to every question", async () => {
    mockChat.mockResolvedValue({ response: "Found 3 documents.", source: "tool" });
    await runDataQuestions("user-42", "sales");

    const callers = mockChat.mock.calls.map(([, id, role]) => `${id}:${role}`);
    expect(new Set(callers)).toEqual(new Set(["user-42:sales"]));
  });

  /* Two different readers must produce two different runs. A cached or shared
     result would hand one person another's documents. */
  it("does not reuse one reader's run for another", async () => {
    mockChat.mockResolvedValue({ response: "ok", source: "tool" });
    await runDataQuestions("user-a", "ops");
    await runDataQuestions("user-b", "ops");

    const ids = new Set(mockChat.mock.calls.map(([, id]) => id));
    expect(ids).toEqual(new Set(["user-a", "user-b"]));
  });
});

describe("an unanswered question is reported, not hidden", () => {
  it.each([
    "No results found for that.",
    "I don't have a confident answer for that.",
    "financials are not connected yet, so there is no figure to read",
    "Your Microsoft tasks have not been synced yet.",
    "I don't have any verified facts about that yet.",
    "",
  ])("marks %j as empty", (answer) => {
    expect(isEmptyAnswer(answer)).toBe(true);
  });

  it.each([
    "Found 3 results for \"sow payment terms\": 3 documents.",
    "9 on the team: Alicia Zulker (ops), Jorge Colon (vp)",
    "You have 6 meetings this week.",
  ])("does not mark a real answer %j as empty", (answer) => {
    expect(isEmptyAnswer(answer)).toBe(false);
  });

  /* THE ASSERTION THE PANEL RESTS ON. An empty finding stays in the list, with
     its question, so a reader can see what we could not answer and act on it. */
  it("keeps an empty finding in the results rather than dropping it", async () => {
    mockChat.mockResolvedValue({ response: "No results found.", source: "tool" });
    const run = await runDataQuestions("u1", "cto");

    expect(run.findings).toHaveLength(DATA_QUESTIONS.length);
    expect(run.findings.every((f) => f.empty)).toBe(true);
  });
});

describe("it survives a bad day without taking the panel down", () => {
  it("turns a thrown question into a finding that says so", async () => {
    mockChat.mockRejectedValue(new Error("retrieval exploded"));
    const run = await runDataQuestions("u1", "cto");

    expect(run.findings).toHaveLength(DATA_QUESTIONS.length);
    expect(run.findings[0].answer).toMatch(/could not be answered/i);
    expect(run.findings[0].empty).toBe(true);
    expect(run.findings[0].source).toBe("error");
  });

  /* One failure must not stop the rest: five answers and one honest failure is
     a more useful panel than an error page. */
  it("keeps going after one question fails", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("one bad question"))
      .mockResolvedValue({ response: "Found 2 documents.", source: "tool" });

    const run = await runDataQuestions("u1", "cto");
    expect(run.findings.filter((f) => !f.empty).length).toBe(DATA_QUESTIONS.length - 1);
  });
});

describe("the question set itself", () => {
  /* Every question needs a reason a client can read. A panel of answers with no
     explanation of why they were asked is a magic trick, not an insight. */
  it("explains why each question is worth asking", () => {
    for (const q of DATA_QUESTIONS) {
      expect(q.why.length).toBeGreaterThan(20);
      expect(q.title.length).toBeGreaterThan(2);
      expect(q.ask.length).toBeGreaterThan(5);
    }
  });

  it("has no duplicate ids, so a finding can be tracked across runs", () => {
    const ids = DATA_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
