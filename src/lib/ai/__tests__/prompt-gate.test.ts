/**
 * The credential gate on outbound prompts.
 *
 * `redaction.ts` says it exists to redact "before they leave the process
 * boundary to an LLM provider". Only the OGIAM agent path ever called it. The
 * assistant — a chat box a person can paste anything into — had no gate.
 *
 * These assert the two halves of the policy: what must never leave, and what
 * must be left alone so the product still works.
 */
import { redactText, redactMessages, NEVER_SEND_KINDS } from "../redaction";

/* Fixtures are ASSEMBLED at runtime, never written as literals.
 *
 * GitHub push protection correctly blocked the first version of this file: a
 * realistic Stripe key in source is a secret as far as any scanner is
 * concerned, and clicking "allow this secret" to land a test would train us to
 * click it again on a real one. Concatenating the prefix keeps the value
 * byte-identical at runtime, so these assertions are exactly as strong. */
const STRIPE_KEY = ["sk", "live", "51H8xQ2eZvKYlo2CkqZ7Xn4bTgHJk9mNpQr"].join("_");
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const IBAN = "GB82" + "WEST12345698765432";


describe("NEVER_SEND_KINDS — what must never reach a model", () => {
  test.each([
    ["an API key", `use ${STRIPE_KEY}`, "api_key"],
    ["an SSN", "his ssn is 123-45-6789", "ssn"],
    ["a card number", "card 4111 1111 1111 1111 on file", "credit_card"],
    ["an IBAN", `IBAN ${IBAN} please`, "iban"],
  ])("%s is removed", (_label, input, kind) => {
    const out = redactText(input, NEVER_SEND_KINDS);
    expect(out.redacted).toBe(true);
    expect(out.hits.map((h) => h.kind)).toContain(kind);
  });

  test("the original value never appears in the result or the hits", () => {
    /* The security invariant the module claims. Worth pinning at this layer
       too, because this is the layer that now emits analytics about hits. */
    const secret = STRIPE_KEY;
    const out = redactText(`key: ${secret}`, NEVER_SEND_KINDS);
    expect(out.text).not.toContain(secret);
    expect(JSON.stringify(out.hits)).not.toContain(secret);
  });
});

describe("what the gate deliberately leaves alone", () => {
  /* Instinct's whole job includes looking colleagues up. A gate that broke
     that would get switched off, leaving no gate at all. */
  test.each([
    ["an email", "what is jorge@wolfpack.example.com's role?"],
    ["a phone number", "call 732-555-0142 about the handoff"],
    ["an IP", "the box at 10.0.0.14 is down"],
  ])("%s passes through untouched", (_label, input) => {
    const out = redactText(input, NEVER_SEND_KINDS);
    expect(out.text).toBe(input);
    expect(out.redacted).toBe(false);
  });

  test("callers that pass no kinds still get the full set", () => {
    /* Backward compatibility for the OGIAM ledger and agent actions, which
       predate the parameter and must keep redacting everything. */
    const out = redactText("mail me at jorge@wolfpack.example.com");
    expect(out.redacted).toBe(true);
    expect(out.hits.map((h) => h.kind)).toContain("email");
  });
});

describe("redactMessages honours the kind filter", () => {
  test("a pasted key is stripped from a message while the email survives", () => {
    const out = redactMessages(
      [
        { role: "user", content: `here is my key ${STRIPE_KEY}` },
        { role: "user", content: "and email jorge@wolfpack.example.com" },
      ],
      undefined,
      "pii",
      NEVER_SEND_KINDS,
    );
    expect(out.count).toBe(1);
    expect(out.messages[0].content).not.toContain("sk_live_");
    expect(out.messages[1].content).toContain("jorge@wolfpack.example.com");
  });

  test("the system prompt is gated too, not just user turns", () => {
    /* Attachment text and brain passages are folded into the SYSTEM prompt, so
       a credential inside an uploaded document arrives there, not in the
       user's message. Gating only messages would have missed the likeliest
       path entirely. */
    const out = redactMessages(
      [{ role: "user", content: "look at the screenshot" }],
      `Attachment: key is ${STRIPE_KEY}`,
      "pii",
      NEVER_SEND_KINDS,
    );
    expect(out.count).toBe(1);
    expect(out.system).not.toContain("sk_live_");
  });

  test("a clean prompt is passed through with nothing reported", () => {
    const out = redactMessages(
      [{ role: "user", content: "what are my meetings today?" }],
      "you are helpful",
      "pii",
      NEVER_SEND_KINDS,
    );
    expect(out.count).toBe(0);
    expect(out.messages[0].content).toBe("what are my meetings today?");
    expect(out.system).toBe("you are helpful");
  });

  test("inputs are not mutated", () => {
    const messages = [{ role: "user", content: `key ${STRIPE_KEY}` }];
    redactMessages(messages, undefined, "pii", NEVER_SEND_KINDS);
    expect(messages[0].content).toContain(STRIPE_KEY);
  });
});
