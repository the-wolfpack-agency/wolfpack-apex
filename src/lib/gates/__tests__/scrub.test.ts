/**
 * The default secret/PII scrub - the floor under "won't leak data to the LLM".
 * It runs on every prompt regardless of policy, so these shapes must never reach
 * a model. Over-redaction is safe; under-redaction is the harm.
 */
import { scrubForModel } from "@/lib/gates/scrub";

describe("secrets are scrubbed", () => {
  it.each([
    ["OpenAI", "key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"],
    ["Anthropic", "ANTHROPIC=sk-ant-abcdefghijklmnopqrstuvwxyz12345"],
    ["GitHub token", "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["AWS key id", "aws AKIAIOSFODNN7EXAMPLE here"],
    ["JWT", "auth eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4"],
    ["bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
    ["assignment", 'password = "hunter2secret"'],
  ])("%s", (_label, text) => {
    const r = scrubForModel(text);
    expect(r.text).toContain("[REDACTED]");
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).not.toMatch(/sk-proj-abcde|sk-ant-abcde|ghp_ABCDE|AKIAIOSF|hunter2secret/);
  });
});

describe("PII is scrubbed", () => {
  it("email + SSN", () => {
    const r = scrubForModel("contact jane.doe@acme.com ssn 123-45-6789");
    expect(r.text).not.toContain("jane.doe@acme.com");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.count).toBeGreaterThanOrEqual(2);
  });
});

it("leaves ordinary code/prose untouched (no false positives)", () => {
  const src = "export function readingTime(text: string): number { return Math.ceil(words / 200); }";
  const r = scrubForModel(src);
  expect(r.text).toBe(src);
  expect(r.count).toBe(0);
});
