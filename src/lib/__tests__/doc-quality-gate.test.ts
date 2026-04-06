/**
 * Doc Quality Gate Tests -- PII, security, compliance, quality, analytics.
 *
 * Tests cover:
 *   - PII detection (SSN, credit card, DOB, driver's license)
 *   - Security detection (API keys, AWS keys, connection strings, JWT, private keys)
 *   - Compliance (profanity detection)
 *   - Quality checks (empty, too short, gibberish, repetition)
 *   - Verdict logic (pass, warn, reject)
 *   - PII redaction
 *   - Analytics tracking for gate results
 *   - API route integration with quality gate
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockTrackEvent = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

import {
  checkDocQuality,
  redactPII,
  trackGateResult,
  type GateResult,
} from "@/lib/doc-quality-gate";

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// PII Detection
// ---------------------------------------------------------------------------

describe("PII Detection", () => {
  test("detects SSN (dashed format)", () => {
    const result = checkDocQuality("My SSN is 123-45-6789 on file.");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.category === "pii" && f.message.includes("SSN"))).toBe(true);
  });

  test("detects SSN (space format)", () => {
    const result = checkDocQuality("SSN: 123 45 6789");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("SSN"))).toBe(true);
  });

  test("detects credit card (Visa)", () => {
    const result = checkDocQuality("Card number: 4111-1111-1111-1111");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Credit card"))).toBe(true);
  });

  test("detects credit card (Mastercard)", () => {
    const result = checkDocQuality("Pay with 5500 0000 0000 0004");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Credit card"))).toBe(true);
  });

  test("detects phone number (warns, not rejects)", () => {
    const result = checkDocQuality("Call me at (555) 123-4567 for details about the project.");
    const phoneFlag = result.flags.find((f) => f.message.includes("Phone"));
    expect(phoneFlag).toBeDefined();
    expect(phoneFlag!.severity).toBe("warn");
  });

  test("detects email address (warns, not rejects)", () => {
    const result = checkDocQuality("Contact john.doe@company.com for more information about our services.");
    const emailFlag = result.flags.find((f) => f.message.includes("Email"));
    expect(emailFlag).toBeDefined();
    expect(emailFlag!.severity).toBe("warn");
  });

  test("detects date of birth", () => {
    const result = checkDocQuality("DOB: 03/15/1990");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Date of birth"))).toBe(true);
  });

  test("detects driver's license", () => {
    const result = checkDocQuality("Driver's license: DL#A1234567");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Driver"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security Detection
// ---------------------------------------------------------------------------

describe("Security Detection", () => {
  test("detects API key pattern", () => {
    const result = checkDocQuality("const key = sk_test_FAKE0000000000000000000000000");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.category === "security" && f.message.includes("API key"))).toBe(true);
  });

  test("detects AWS access key", () => {
    const result = checkDocQuality("aws_key = AKIAIOSFODNN7EXAMPLE");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("AWS key"))).toBe(true);
  });

  test("detects connection string", () => {
    const result = checkDocQuality("DATABASE_URL=postgres://user:pass@host:5432/db");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Connection string"))).toBe(true);
  });

  test("detects MongoDB connection string", () => {
    const result = checkDocQuality("MONGO_URI=mongodb://admin:secret@cluster0.example.net/mydb");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Connection string"))).toBe(true);
  });

  test("detects Bearer token", () => {
    const result = checkDocQuality('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    expect(result.verdict).toBe("reject");
  });

  test("detects private key block", () => {
    const result = checkDocQuality("-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Private key"))).toBe(true);
  });

  test("detects password assignment", () => {
    const result = checkDocQuality('password = "supersecret123"');
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("Password"))).toBe(true);
  });

  test("detects JWT token", () => {
    const result = checkDocQuality("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjMifQ.abc123def456");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("JWT"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

describe("Compliance Detection", () => {
  test("detects profanity (warns)", () => {
    const result = checkDocQuality("This damn thing is broken and it pisses me off. I need to fix the configuration settings for the server.");
    const flag = result.flags.find((f) => f.category === "compliance");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn");
  });

  test("clean content passes compliance", () => {
    const result = checkDocQuality("The quarterly report shows a 15% increase in revenue compared to last quarter.");
    const complianceFlags = result.flags.filter((f) => f.category === "compliance");
    expect(complianceFlags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Quality Checks
// ---------------------------------------------------------------------------

describe("Quality Checks", () => {
  test("rejects empty content", () => {
    const result = checkDocQuality("");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("empty"))).toBe(true);
  });

  test("rejects whitespace-only content", () => {
    const result = checkDocQuality("   \n\n   ");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("empty"))).toBe(true);
  });

  test("rejects content shorter than 10 chars", () => {
    const result = checkDocQuality("Hi");
    expect(result.verdict).toBe("reject");
    expect(result.flags.some((f) => f.message.includes("too short"))).toBe(true);
  });

  test("warns on high non-alphanumeric ratio", () => {
    const result = checkDocQuality("!@#$%^&*()_+{}|:<>?!@#$%^&*()");
    const flag = result.flags.find((f) => f.message.includes("non-text"));
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn");
  });

  test("warns on repeated lines", () => {
    const lines = Array(6).fill("This line is repeated").join("\n");
    const result = checkDocQuality(lines);
    const flag = result.flags.find((f) => f.message.includes("Repeated"));
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn");
  });

  test("does not warn on 4 repeated lines (under threshold)", () => {
    const lines = Array(4).fill("Repeated but under limit").join("\n");
    const result = checkDocQuality(lines);
    const flag = result.flags.find((f) => f.message.includes("Repeated"));
    expect(flag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Verdict Logic
// ---------------------------------------------------------------------------

describe("Verdict Logic", () => {
  test("clean content passes", () => {
    const result = checkDocQuality("This is a perfectly normal document about our Q3 sales strategy and upcoming product launches.");
    expect(result.verdict).toBe("pass");
    expect(result.flags).toHaveLength(0);
  });

  test("warnings do not cause rejection", () => {
    const result = checkDocQuality("Contact us at support@example.com for assistance with your order number 12345.");
    expect(result.verdict).toBe("warn");
    expect(result.flags.some((f) => f.severity === "warn")).toBe(true);
    expect(result.flags.some((f) => f.severity === "reject")).toBe(false);
  });

  test("reject overrides warn", () => {
    const result = checkDocQuality("Email support@example.com, SSN 123-45-6789");
    expect(result.verdict).toBe("reject");
  });

  test("multiple flags from different categories", () => {
    const result = checkDocQuality("SSN: 123-45-6789, password = 'secret123', damn it");
    expect(result.verdict).toBe("reject");
    const categories = new Set(result.flags.map((f) => f.category));
    expect(categories.has("pii")).toBe(true);
    expect(categories.has("security")).toBe(true);
  });

  test("sanitizedContent provided on warn (not reject)", () => {
    const result = checkDocQuality("Please email user@example.com about the upcoming project deadline and deliverables for Q3.");
    expect(result.verdict).toBe("warn");
    expect(result.sanitizedContent).toBeDefined();
    expect(result.sanitizedContent).toContain("[REDACTED]");
  });

  test("no sanitizedContent on reject", () => {
    const result = checkDocQuality("My SSN is 123-45-6789 and it needs to be filed.");
    expect(result.verdict).toBe("reject");
    expect(result.sanitizedContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PII Redaction
// ---------------------------------------------------------------------------

describe("PII Redaction", () => {
  test("redacts SSN", () => {
    const redacted = redactPII("SSN: 123-45-6789");
    expect(redacted).not.toContain("123-45-6789");
    expect(redacted).toContain("[REDACTED]");
  });

  test("redacts credit card", () => {
    const redacted = redactPII("Card: 4111-1111-1111-1111");
    expect(redacted).not.toContain("4111");
    expect(redacted).toContain("[REDACTED]");
  });

  test("redacts connection strings", () => {
    const redacted = redactPII("DB: postgres://user:pass@host/db");
    expect(redacted).not.toContain("postgres://");
    expect(redacted).toContain("[REDACTED]");
  });

  test("redacts API keys", () => {
    const redacted = redactPII("key: sk_test_FAKE0000000000000000000000000");
    expect(redacted).not.toContain("sk_live_abc123");
    expect(redacted).toContain("[REDACTED]");
  });

  test("preserves clean content", () => {
    const clean = "This is a normal sentence about our business strategy.";
    expect(redactPII(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Analytics Tracking
// ---------------------------------------------------------------------------

describe("Analytics Tracking", () => {
  test("tracks pass verdict", () => {
    const result: GateResult = { verdict: "pass", flags: [] };
    trackGateResult(result, "user1", "cto", "report.md");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.doc_quality_checked",
      "user1",
      "cto",
      expect.objectContaining({
        file_name: "report.md",
        verdict: "pass",
        flag_count: 0,
      }),
    );
    // Should NOT track rejection event
    const rejectCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.doc_rejected",
    );
    expect(rejectCalls).toHaveLength(0);
  });

  test("tracks reject verdict with reasons", () => {
    const result: GateResult = {
      verdict: "reject",
      flags: [
        { category: "pii", severity: "reject", message: "SSN detected (1 occurrence)" },
        { category: "security", severity: "reject", message: "API key detected (1 occurrence)" },
      ],
    };
    trackGateResult(result, "user2", "dev", "secrets.env");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.doc_quality_checked",
      "user2",
      "dev",
      expect.objectContaining({
        file_name: "secrets.env",
        verdict: "reject",
        flag_count: 2,
        categories: expect.stringContaining("pii"),
      }),
    );

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.doc_rejected",
      "user2",
      "dev",
      expect.objectContaining({
        file_name: "secrets.env",
        reasons: expect.stringContaining("SSN"),
      }),
    );
  });

  test("tracks warn verdict", () => {
    const result: GateResult = {
      verdict: "warn",
      flags: [
        { category: "pii", severity: "warn", message: "Email address detected (1 occurrence)" },
      ],
    };
    trackGateResult(result, "user3", "sales", "contacts.csv");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.doc_quality_checked",
      "user3",
      "sales",
      expect.objectContaining({
        verdict: "warn",
      }),
    );
    // warn does NOT trigger rejection event
    const rejectCalls = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "assistant.doc_rejected",
    );
    expect(rejectCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("Edge Cases", () => {
  test("handles very long content without crashing", () => {
    const longContent = "This is a valid document. ".repeat(5000);
    const result = checkDocQuality(longContent);
    expect(result.verdict).toBe("pass");
  });

  test("does not false-positive on normal numbers", () => {
    const result = checkDocQuality("Our revenue was $1,234,567 last quarter. We had 890 customers and processed 12,345 orders.");
    const piiFlags = result.flags.filter((f) => f.category === "pii" && f.severity === "reject");
    expect(piiFlags).toHaveLength(0);
  });

  test("does not false-positive on code variables", () => {
    const result = checkDocQuality("const apiEndpoint = '/api/v1/users'; function fetchData() { return fetch(apiEndpoint); }");
    expect(result.verdict).toBe("pass");
  });

  test("handles unicode content", () => {
    const result = checkDocQuality("Les revenus du trimestre sont en hausse de 15%. Das Quartalsergebnis zeigt einen Anstieg.");
    expect(result.verdict).toBe("pass");
  });
});
