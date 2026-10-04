/**
 * Failure/pattern memory store: the pure normalizer (REDACTS summaries so the
 * memory can never hold a secret, dedupes, caps) + the upsert/read SQL over a
 * mocked db. Real-schema landing + times_seen bump is in the .db.test.ts.
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  normalizeFailures,
  failureSignature,
  rememberFailures,
  loadUnembeddedFailures,
  countFailures,
  MAX_FAILURE_WRITE,
} from "@/lib/ai-code/factory-failure-store";

beforeEach(() => jest.clearAllMocks());

describe("normalizeFailures", () => {
  it("drops entries missing a class or summary", () => {
    const out = normalizeFailures([
      { findingClass: "", summary: "x" },
      { findingClass: "y", summary: "" },
      { findingClass: "logged_credential", summary: "secret written to a log" },
    ]);
    expect(out.map((r) => r.findingClass)).toEqual(["logged_credential"]);
  });

  it("REDACTS a secret/PII out of the stored summary (never a secret store)", () => {
    const out = normalizeFailures([
      { findingClass: "pii_exposure", summary: "leaked contact user@example.com in a log line" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].summary).not.toContain("user@example.com"); // redacted
  });

  it("dedupes by signature (class + redacted summary)", () => {
    const out = normalizeFailures([
      { findingClass: "sql_injection", summary: "string-built query in repo A" },
      { findingClass: "sql_injection", summary: "string-built query in repo A" },
    ]);
    expect(out).toHaveLength(1);
  });

  it("caps at MAX_FAILURE_WRITE", () => {
    const many = Array.from({ length: MAX_FAILURE_WRITE + 20 }, (_, i) => ({ findingClass: `c${i}`, summary: `s${i}` }));
    expect(normalizeFailures(many).length).toBe(MAX_FAILURE_WRITE);
  });
});

test("failureSignature is deterministic + class/summary sensitive", () => {
  expect(failureSignature("a", "b")).toBe(failureSignature("a", "b"));
  expect(failureSignature("a", "b")).not.toBe(failureSignature("a", "c"));
});

describe("rememberFailures", () => {
  it("upserts with a times_seen bump on conflict, workspace+repo scoped", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await rememberFailures({ workspaceId: "w1", repo: "o/r", docs: [
      { findingClass: "logged_credential", summary: "secret in a log", severity: "critical", path: "src/x.ts" },
    ] });
    expect(r.written).toBe(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_factory_failure_memory/);
    expect(sql).toMatch(/times_seen = instinct_factory_failure_memory\.times_seen \+ 1/);
    expect(sql).toMatch(/embedded = false/);
    expect(params.slice(0, 2)).toEqual(["w1", "o/r"]);
    expect(params).toContain("logged_credential");
  });
  it("no write + 0 when nothing usable", async () => {
    const r = await rememberFailures({ workspaceId: "w1", repo: "o/r", docs: [{ findingClass: "", summary: "" }] });
    expect(r.written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("propagates a write failure (never a silent drop)", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(rememberFailures({ workspaceId: "w1", repo: "o/r", docs: [{ findingClass: "c", summary: "s" }] }))
      .rejects.toThrow("db down");
  });
});

describe("reads degrade", () => {
  it("loadUnembeddedFailures maps rows + is scoped", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ signature: "sig", finding_class: "c", summary: "s", path: "p", severity: "high", times_seen: 3, embedded: false, updated_at: "t" }] });
    const rows = await loadUnembeddedFailures("w1", "o/r");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["w1", "o/r"]);
    expect(rows[0]).toMatchObject({ findingClass: "c", timesSeen: 3, repo: "o/r" });
  });
  it("countFailures returns 0 on empty", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await countFailures("w1")).toBe(0);
  });
});
