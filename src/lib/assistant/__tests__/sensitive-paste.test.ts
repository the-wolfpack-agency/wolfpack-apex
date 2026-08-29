/**
 * Somebody pasted a secret and nothing else.
 *
 * MEASURED 2026-08-29: typing "my card is 4111 1111 1111 1111" cost 1,532
 * tokens and a model round trip to answer "I can't process credit card
 * information directly."
 *
 * The router had already removed the number before the prompt left the
 * process, and the analytics row proves it fired. So the system knew a card
 * had been pasted, knew it had stripped it, and then paid a model to improvise
 * a sentence about that. Same waste as paying a model to say "no results
 * found": the deterministic layer had already established the fact.
 *
 * A safety answer in particular should not be improvised. The same paste
 * deserves the same reply today and next week.
 */
import { detectSensitivePaste } from "@/lib/assistant/sensitive-paste";

describe("a bare paste of something we never send on", () => {
  it.each([
    "my card is 4111 1111 1111 1111",
    "4111111111111111",
    "  5500005555555559  ",
  ])("answers %j without a model", (message) => {
    const r = detectSensitivePaste(message);
    expect(r).not.toBeNull();
    expect(r!.kinds).toContain("credit_card");
  });

  /* SAYS THE REASSURING THING. "I can't process credit card information"
     leaves somebody wondering what happened to the number they typed. The fact
     worth telling them is that it never went anywhere. */
  it("tells them it was removed before it went anywhere", () => {
    const r = detectSensitivePaste("my card is 4111 1111 1111 1111")!;
    expect(r.answer).toMatch(/removed before it went anywhere/i);
    expect(r.answer).toMatch(/no model or outside service received it/i);
  });

  /* One card pasted twice is still "a card number". Listing it twice reads as
     a system counting rather than a person being answered. */
  it("does not repeat the kind when the same value appears twice", () => {
    const r = detectSensitivePaste("4111111111111111 4111111111111111")!;
    expect(r.kinds).toEqual(["credit_card"]);
    expect(r.answer.match(/a card number/g)).toHaveLength(1);
  });
});

describe("what must still reach the normal path", () => {
  /* THE CASE THAT WOULD MAKE THIS A WORSE PRODUCT. A real question with a card
     in it is a real question. Refusing it to save tokens would trade a useful
     answer for a canned one, and the card is redacted on that path anyway. */
  it("lets a genuine question through even when it contains a card", () => {
    expect(
      detectSensitivePaste(
        "my card 4111 1111 1111 1111 was declined, what does the sow say about payment terms",
      ),
    ).toBeNull();
  });

  it.each([
    "what does the sow say about payment terms",
    "how many open tasks do I have",
    "",
    "   ",
  ])("ignores %j, which carries nothing sensitive", (message) => {
    expect(detectSensitivePaste(message)).toBeNull();
  });

  /* A 16-digit number that is not a card must not trigger a safety answer.
     Luhn validation is what separates an invoice number from a card, and this
     asserts the distinction survives at this layer too. */
  it("ignores a long number that is not actually a card", () => {
    expect(detectSensitivePaste("6601354223758494")).toBeNull();
    expect(detectSensitivePaste("invoice 1453674323456767")).toBeNull();
  });
});
