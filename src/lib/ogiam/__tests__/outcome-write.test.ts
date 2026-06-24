/**
 * recordActionOutcome write-path tests. The outcome is the RESULT half of the
 * audit trail, appended to ogiam_action_outcomes and linked to its decision by
 * seq. This exercises: the no-database short circuit, the INSERT shape, the
 * redact + hard-truncate of the result string (security), and best-effort
 * swallowing of any write error (never throws into dispatch).
 */

const mockConnect = jest.fn();
jest.mock("@/lib/db", () => ({ pool: { connect: (...a: unknown[]) => mockConnect(...a) } }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import {
  recordActionOutcome,
  redactAndTruncateResult,
  OGIAM_RESULT_MAX_CHARS,
} from "@/lib/ogiam/ledger";

function fakeClient() {
  const inserts: { sql: string; params: unknown[] }[] = [];
  const client = {
    inserts,
    release: jest.fn(),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      inserts.push({ sql, params: params ?? [] });
      return { rows: [] };
    }),
  };
  return client;
}

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockConnect.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

const base = {
  workspaceId: "ws-1",
  decisionSeq: 7,
  agentId: "a_1",
  ok: true,
  code: "ok",
  resultRedacted: "all green",
  durationMs: 12,
};

describe("redactAndTruncateResult", () => {
  it("redacts PII / secrets out of the result", () => {
    const out = redactAndTruncateResult("reach me at jane@acme.com now");
    expect(out).not.toContain("jane@acme.com");
  });

  it("hard-truncates beyond the cap and appends an ellipsis", () => {
    // Natural prose (not a single token run, which the redactor would mask to a
    // short placeholder) so the length cap is what actually fires.
    const long = "the agent completed the task successfully and ".repeat(40);
    expect(long.length).toBeGreaterThan(OGIAM_RESULT_MAX_CHARS);
    const out = redactAndTruncateResult(long);
    expect(out.length).toBeLessThanOrEqual(OGIAM_RESULT_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("respects a custom max", () => {
    const out = redactAndTruncateResult("the agent did some work here today", 10);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out.endsWith("…")).toBe(true);
  });

  it("tolerates a non-string input without throwing", () => {
    expect(() => redactAndTruncateResult(undefined)).not.toThrow();
    expect(redactAndTruncateResult(undefined)).toBe("");
  });
});

describe("recordActionOutcome: no database", () => {
  it("short-circuits without connecting when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await recordActionOutcome(base);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe("recordActionOutcome: write", () => {
  it("inserts the outcome linked to the decision seq", async () => {
    const client = fakeClient();
    mockConnect.mockResolvedValue(client);

    await recordActionOutcome(base);

    expect(client.inserts).toHaveLength(1);
    const { sql, params } = client.inserts[0];
    expect(sql).toMatch(/INSERT INTO ogiam_action_outcomes/);
    expect(params).toEqual(["ws-1", 7, "a_1", true, "ok", "all green", 12]);
    expect(client.release).toHaveBeenCalled();
  });

  it("redacts the stored result string", async () => {
    const client = fakeClient();
    mockConnect.mockResolvedValue(client);

    await recordActionOutcome({ ...base, resultRedacted: "card 4111 1111 1111 1111 used" });

    const stored = client.inserts[0].params[5] as string;
    expect(stored).not.toContain("4111 1111 1111 1111");
  });
});

describe("recordActionOutcome: best effort", () => {
  it("swallows a connect failure (never throws)", async () => {
    mockConnect.mockRejectedValue(new Error("no conn"));
    await expect(recordActionOutcome(base)).resolves.toBeUndefined();
  });

  it("swallows an insert failure and still releases the client", async () => {
    const client = {
      release: jest.fn(),
      query: jest.fn(async () => {
        throw new Error("boom");
      }),
    };
    mockConnect.mockResolvedValue(client);
    await expect(recordActionOutcome(base)).resolves.toBeUndefined();
    expect(client.release).toHaveBeenCalled();
  });
});
