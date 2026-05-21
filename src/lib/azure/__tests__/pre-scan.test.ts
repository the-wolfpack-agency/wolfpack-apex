import { preScanForBlockingPII } from "@/lib/azure/pre-scan";

describe("preScanForBlockingPII", () => {
  it("passes a clean buffer", () => {
    const r = preScanForBlockingPII(Buffer.from("clean receipt text from Acme Hardware $10.00"));
    expect(r.ok).toBe(true);
    expect(r.blockedBy).toEqual([]);
  });

  it("blocks an embedded SSN", () => {
    const r = preScanForBlockingPII(Buffer.from("Employee SSN 123-45-6789 on file"));
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toContain("pii_ssn");
  });

  it("blocks a Luhn-valid credit card", () => {
    /* 4111 1111 1111 1111 is a published-for-testing card that
       passes Luhn — used by every payment SDK as a test card. */
    const r = preScanForBlockingPII(Buffer.from("Card 4111 1111 1111 1111 exp 12/26"));
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toContain("pii_credit_card");
  });

  it("blocks an AWS access key", () => {
    const r = preScanForBlockingPII(Buffer.from("AKIAIOSFODNN7EXAMPLE in vendor README"));
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toContain("secret_aws_access_key");
  });

  it("blocks an Anthropic key", () => {
    const r = preScanForBlockingPII(Buffer.from("api key sk-ant-api03-fake-key-for-testing-purposes-only-x"));
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toContain("secret_anthropic_key");
  });

  it("does NOT block a 13-19 digit run that fails Luhn (random number)", () => {
    const r = preScanForBlockingPII(Buffer.from("Order 1234567890123 confirmed"));
    expect(r.ok).toBe(true);
  });

  it("returns all matches when multiple PII shapes are present", () => {
    const r = preScanForBlockingPII(Buffer.from("SSN 123-45-6789 and card 4111 1111 1111 1111"));
    expect(r.ok).toBe(false);
    expect(r.blockedBy).toEqual(expect.arrayContaining(["pii_ssn", "pii_credit_card"]));
  });
});
