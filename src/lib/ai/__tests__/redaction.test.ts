/**
 * src/lib/ai/__tests__/redaction.test.ts
 *
 * Unit tests for the PII/PHI redaction guardrail.
 * No mocks needed, pure deterministic functions.
 *
 * Coverage:
 *  1.  email detected + replaced
 *  2.  phone (NANP) detected + replaced
 *  3.  phone (E.164) detected + replaced
 *  4.  SSN detected + replaced
 *  5.  credit card (valid Luhn) detected + replaced
 *  6.  credit card (invalid Luhn 16-digit) not replaced
 *  7.  IPv4 detected + replaced
 *  8.  IBAN detected + replaced
 *  9.  api_key (sk- prefix) detected + replaced
 * 10.  api_key (hex token) detected + replaced
 * 11.  stable placeholder coreference: same raw value → same placeholder
 * 12.  per-kind numbering: two distinct emails → EMAIL_1 and EMAIL_2
 * 13.  no original PII value appears in hits
 * 14.  empty/falsy input passthrough
 * 15.  redacted=false when nothing found
 * 16.  public sensitivity → passthrough (no redaction)
 * 17.  phi sensitivity behaves like pii
 * 18.  undefined sensitivity → redacts
 * 19.  redactMessages: multi-message redaction
 * 20.  redactMessages: system prompt redacted
 * 21.  redactMessages: aggregate hit dedup (same PII in two messages → one hit)
 * 22.  redactMessages: count equals unique placeholders across all fields
 * 23.  idempotent-ish: running redactText twice on the output doesn't double-wrap
 * 24.  inputs not mutated by redactMessages
 */

import { redactMessages, redactText } from "../redaction";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function noOriginalPii(
  hits: { kind: string; placeholder: string }[],
  originals: string[],
): void {
  for (const h of hits) {
    for (const orig of originals) {
      expect(h.placeholder).not.toContain(orig);
    }
    /* placeholder must match [KIND_N] pattern */
    expect(h.placeholder).toMatch(/^\[[A-Z_]+_\d+\]$/);
  }
}

/* ------------------------------------------------------------------ */
/* redactText, per-kind tests                                         */
/* ------------------------------------------------------------------ */

describe("redactText, email", () => {
  test("detects and replaces an email address", () => {
    const r = redactText("Contact us at alice@example.com for support.");
    expect(r.text).not.toContain("alice@example.com");
    expect(r.text).toContain("[EMAIL_1]");
    expect(r.redacted).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].kind).toBe("email");
    noOriginalPii(r.hits, ["alice@example.com"]);
  });
});

describe("redactText, phone", () => {
  test("detects NANP phone number", () => {
    const r = redactText("Call me at (555) 867-5309 anytime.");
    expect(r.text).not.toContain("555");
    expect(r.text).toContain("[PHONE_1]");
    expect(r.hits[0].kind).toBe("phone");
  });

  test("detects E.164 phone number", () => {
    const r = redactText("International: +14155551234");
    expect(r.text).not.toContain("+14155551234");
    expect(r.text).toContain("[PHONE_1]");
    expect(r.hits[0].kind).toBe("phone");
  });
});

describe("redactText, SSN", () => {
  test("detects dashed SSN", () => {
    const r = redactText("SSN: 123-45-6789.");
    expect(r.text).not.toContain("123-45-6789");
    expect(r.text).toContain("[SSN_1]");
    expect(r.hits[0].kind).toBe("ssn");
  });
});

describe("redactText, credit_card", () => {
  test("detects valid Luhn credit card", () => {
    /* Visa test number 4111111111111111, passes Luhn */
    const r = redactText("Card: 4111 1111 1111 1111 expires 12/26.");
    expect(r.text).not.toContain("4111");
    expect(r.text).toContain("[CREDIT_CARD_1]");
    expect(r.hits[0].kind).toBe("credit_card");
  });

  test("does NOT redact a 16-digit number that fails Luhn", () => {
    /* 1234567890123456 fails Luhn */
    const r = redactText("Number: 1234567890123456");
    /* SSN might or might not fire on sub-sequences, but no CREDIT_CARD hit */
    const ccHit = r.hits.find((h) => h.kind === "credit_card");
    expect(ccHit).toBeUndefined();
  });
});

describe("redactText, ip", () => {
  test("detects IPv4 address", () => {
    const r = redactText("Server at 192.168.1.100 is down.");
    expect(r.text).not.toContain("192.168.1.100");
    expect(r.text).toContain("[IP_1]");
    expect(r.hits[0].kind).toBe("ip");
  });
});

describe("redactText, iban", () => {
  test("detects IBAN", () => {
    const r = redactText("Pay to GB29 NWBK 6016 1331 9268 19.");
    expect(r.text).not.toContain("GB29");
    const ibanHit = r.hits.find((h) => h.kind === "iban");
    expect(ibanHit).toBeDefined();
  });
});

describe("redactText, api_key", () => {
  test("detects sk- style API key", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const r = redactText(`Authorization: Bearer ${key}`);
    expect(r.text).not.toContain(key);
    const apiHit = r.hits.find((h) => h.kind === "api_key");
    expect(apiHit).toBeDefined();
  });

  test("detects 32-char hex token", () => {
    const token = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const r = redactText(`Token: ${token}`);
    expect(r.text).not.toContain(token);
    const apiHit = r.hits.find((h) => h.kind === "api_key");
    expect(apiHit).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Stable placeholder coreference                                      */
/* ------------------------------------------------------------------ */

describe("stable placeholder coreference", () => {
  test("same email twice maps to the same placeholder", () => {
    const r = redactText(
      "From: alice@example.com, replied to alice@example.com.",
    );
    /* Should appear exactly twice in the text */
    const count = (r.text.match(/\[EMAIL_1\]/g) ?? []).length;
    expect(count).toBe(2);
    /* Only one distinct hit */
    const emailHits = r.hits.filter((h) => h.kind === "email");
    expect(emailHits).toHaveLength(1);
  });

  test("two distinct emails get EMAIL_1 and EMAIL_2", () => {
    const r = redactText("alice@example.com and bob@test.org");
    expect(r.text).toContain("[EMAIL_1]");
    expect(r.text).toContain("[EMAIL_2]");
    const emailHits = r.hits.filter((h) => h.kind === "email");
    expect(emailHits).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Security: no original value in hits                                 */
/* ------------------------------------------------------------------ */

test("hits never contain the original PII value", () => {
  const pii = "secret@domain.com";
  const r = redactText(`Send to ${pii} ASAP.`);
  noOriginalPii(r.hits, [pii]);
});

/* ------------------------------------------------------------------ */
/* Edge cases                                                          */
/* ------------------------------------------------------------------ */

test("empty string returns passthrough", () => {
  const r = redactText("");
  expect(r.text).toBe("");
  expect(r.hits).toHaveLength(0);
  expect(r.redacted).toBe(false);
});

test("clean text returns redacted=false", () => {
  const r = redactText("Hello world, nothing sensitive here.");
  expect(r.redacted).toBe(false);
  expect(r.hits).toHaveLength(0);
});

/* ------------------------------------------------------------------ */
/* Idempotence                                                         */
/* ------------------------------------------------------------------ */

test("running redactText twice on the output doesn't double-wrap", () => {
  const r1 = redactText("alice@example.com");
  expect(r1.text).toBe("[EMAIL_1]");
  /* Second pass: [EMAIL_1] is not an email, should come back unchanged */
  const r2 = redactText(r1.text);
  expect(r2.text).toBe("[EMAIL_1]");
  expect(r2.redacted).toBe(false);
});

/* ------------------------------------------------------------------ */
/* redactMessages, sensitivity gating                                */
/* ------------------------------------------------------------------ */

describe("redactMessages, sensitivity", () => {
  const msgs = [{ role: "user", content: "My email is alice@example.com" }];

  test("public → passthrough, no hits", () => {
    const result = redactMessages(msgs, undefined, "public");
    expect(result.messages[0].content).toBe("My email is alice@example.com");
    expect(result.hits).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  test("pii → redacts", () => {
    const result = redactMessages(msgs, undefined, "pii");
    expect(result.messages[0].content).not.toContain("alice@example.com");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("phi → redacts (same as pii)", () => {
    const result = redactMessages(msgs, undefined, "phi");
    expect(result.messages[0].content).not.toContain("alice@example.com");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("undefined sensitivity → redacts", () => {
    const result = redactMessages(msgs, undefined, undefined);
    expect(result.messages[0].content).not.toContain("alice@example.com");
  });
});

/* ------------------------------------------------------------------ */
/* redactMessages, system prompt                                      */
/* ------------------------------------------------------------------ */

test("system prompt is redacted", () => {
  const result = redactMessages(
    [],
    "System context: internal IP 10.0.0.1",
    "pii",
  );
  expect(result.system).not.toContain("10.0.0.1");
  expect(result.system).toContain("[IP_1]");
});

test("undefined system prompt stays undefined", () => {
  const result = redactMessages([], undefined, "pii");
  expect(result.system).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* redactMessages, multi-message + dedup                             */
/* ------------------------------------------------------------------ */

test("multi-message redaction: each message is independently redacted", () => {
  const msgs = [
    { role: "user", content: "From alice@example.com" },
    { role: "assistant", content: "Reply to bob@test.org" },
  ];
  const result = redactMessages(msgs, undefined, "pii");
  /* Shared context: alice → [EMAIL_1], bob → [EMAIL_2] */
  expect(result.messages[0].content).not.toContain("alice@example.com");
  expect(result.messages[1].content).not.toContain("bob@test.org");
  /* Two distinct emails → two hits */
  const emailHits = result.hits.filter((h) => h.kind === "email");
  expect(emailHits).toHaveLength(2);
});

test("same PII in two messages deduped in aggregate hits", () => {
  const email = "shared@example.com";
  const msgs = [
    { role: "user", content: `Contact ${email}` },
    { role: "user", content: `Follow up with ${email}` },
  ];
  const result = redactMessages(msgs, undefined, "pii");
  /* Two messages both have the placeholder, but hits list has it once */
  const emailHits = result.hits.filter((h) => h.kind === "email");
  expect(emailHits).toHaveLength(1);
  expect(result.count).toBe(1);
});

test("count equals number of unique placeholders across all fields", () => {
  const msgs = [
    { role: "user", content: "Email: alice@example.com, SSN: 123-45-6789" },
  ];
  const result = redactMessages(msgs, undefined, "pii");
  /* email + ssn → 2 distinct placeholders */
  expect(result.count).toBe(result.hits.length);
  expect(result.count).toBeGreaterThanOrEqual(2);
});

/* ------------------------------------------------------------------ */
/* Mutation safety                                                     */
/* ------------------------------------------------------------------ */

test("redactMessages does not mutate input messages", () => {
  const original = [{ role: "user", content: "email: test@example.com" }];
  const copy = original[0].content;
  redactMessages(original, undefined, "pii");
  expect(original[0].content).toBe(copy);
});
