/**
 * Somebody pasted a secret and nothing else. Answer without buying an answer.
 *
 * WHAT THIS REPLACES. Typing "my card is 4111 1111 1111 1111" cost 1,532
 * tokens and a model round trip to produce "I can't process credit card
 * information directly." Measured 2026-08-29.
 *
 * The router had already done the important work: the number was redacted
 * before the prompt left the process, and the analytics row proves it
 * (kinds: credit_card, redacted_count: 3). So the system KNEW a card had been
 * pasted, knew it had removed it, and then paid a model to improvise a
 * sentence about it.
 *
 * That is the same waste as paying a model to say "no results found": the
 * deterministic layer already established the fact, and asking a model to
 * phrase it adds latency, cost, and variation to something that should be
 * identical every time. A safety response in particular should not be
 * improvised: a reader deserves the same answer today and next week.
 *
 * NARROW ON PURPOSE, AND THIS IS THE WHOLE DESIGN. It fires only when the
 * message is ESSENTIALLY JUST the sensitive value. "My card 4111 1111 1111
 * 1111 was declined, what does our refund policy say?" is a real question with
 * a card in it, and refusing it would be a worse product than the one this
 * replaces. Those still go through the normal path, where the card is redacted
 * and the question is answered.
 *
 * SAYS THE REASSURING THING, which the model's version did not. "I can't
 * process credit card information" leaves somebody wondering what happened to
 * the number they just typed. The fact worth telling them is that it was
 * removed before it went anywhere.
 */

import { redactText, NEVER_SEND_KINDS, type RedactionKind } from "@/lib/ai/redaction";

/** How much real text can sit alongside the value and still count as "just a paste". */
const MEANINGFUL_CHARS = 24;

/** What a person calls each kind, for a sentence they will actually read. */
const KIND_LABEL: Partial<Record<RedactionKind, string>> = {
  credit_card: "a card number",
  ssn: "a social security number",
  national_id: "a national insurance number",
  api_key: "an API key or token",
};

export interface SensitivePaste {
  kinds: RedactionKind[];
  answer: string;
}

/**
 * Decide whether this message is a bare paste of something we never send on.
 *
 * Returns null when it is not, and the caller proceeds normally.
 */
export function detectSensitivePaste(message: string): SensitivePaste | null {
  const text = (message ?? "").trim();
  if (!text) return null;

  const result = redactText(text);
  const hits = result.hits.filter((h) => NEVER_SEND_KINDS.has(h.kind));
  if (hits.length === 0) return null;

  /* What is left once the placeholders are taken out. A message that is a card
     number and the words "my card is" has almost nothing left; a message that
     asks a question has the question left. */
  const remainder = result.text
    .replace(/\[[A-Z_]+_\d+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (remainder.length > MEANINGFUL_CHARS) return null;

  /* Deduplicated: one card pasted twice is still "a card number", and listing
     it twice reads as a system counting rather than a person being answered. */
  const kinds = [...new Set(hits.map((h) => h.kind))];
  const names = kinds.map((k) => KIND_LABEL[k] ?? "sensitive information");
  const subject =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  return {
    kinds,
    answer:
      `That looked like ${subject}, so it was removed before it went anywhere: ` +
      `no model or outside service received it, and it is not stored in this conversation. ` +
      `I do not need it for anything I can do. If you have a question about a payment, an ` +
      `account or a document, ask it in words and I will answer from your connected systems.`,
  };
}
