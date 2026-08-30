/**
 * Keep a secret out of an error message.
 *
 * WHY THIS EXISTS, AND IT IS NOT HYPOTHETICAL. On 2026-08-30 the mapper failed
 * to sign in and Playwright reported it faithfully:
 *
 *     page.fill: Timeout 30000ms exceeded.
 *       - locator resolved to <input type="password" hidden="hidden"/>
 *       - fill("<the actual password>")
 *
 * The prompt had done its job: the password was never echoed, never in argv,
 * never in shell history. Then the failure path printed it to the terminal,
 * and from there it went into a chat window and had to be rotated.
 *
 * That is the shape this codebase keeps finding: one path protected, another
 * one not, and the unprotected one only runs when something has already gone
 * wrong. A secret is safe only if EVERY exit is safe, and the exit nobody
 * rehearses is the error.
 *
 * So anything that handles a secret runs inside this, and what comes out
 * carries the message without the value.
 */

/** What replaces the value, so a reader can see that something was removed. */
const MASK = "<redacted>";

/**
 * Remove every occurrence of a secret from a string.
 *
 * Also removes the URI-encoded and JSON-escaped forms, because an error from a
 * network layer may have encoded it on the way through, and a redactor that
 * only matches the literal would pass those straight out.
 */
export function scrubSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  const forms = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  let out = text;
  for (const form of forms) {
    if (!form) continue;
    out = out.split(form).join(MASK);
  }
  return out;
}

/**
 * Run something that handles a secret, and scrub anything it throws.
 *
 * Returns a plain Error rather than the original: a library error can carry
 * the value in properties a message-only scrub would miss, and the stack is
 * from inside the library rather than from anywhere useful.
 */
export async function withSecret<T>(secret: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(scrubSecret(message, secret));
  }
}
