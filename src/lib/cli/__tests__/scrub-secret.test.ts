/**
 * A secret is safe only if every exit is safe.
 *
 * NOT HYPOTHETICAL. On 2026-08-30 the mapper failed to sign in and Playwright
 * reported it faithfully:
 *
 *     page.fill: Timeout 30000ms exceeded.
 *       - locator resolved to <input type="password" hidden="hidden"/>
 *       - fill("<the actual password>")
 *
 * The prompt had done its job. The password was never echoed, never in argv,
 * never in shell history. Then the FAILURE path printed it to a terminal, and
 * from there into a chat window, and it had to be rotated.
 *
 * One path protected and another not, where the unprotected one runs only
 * after something has already gone wrong. The exit nobody rehearses is the
 * error.
 */

import { scrubSecret, withSecret } from "@/lib/cli/scrub-secret";

const SECRET = "sazxUp-wehmyf-7dexpe";

describe("removing a secret from text", () => {
  /* The exact shape that leaked. */
  it("removes it from a library error quoting what it filled", () => {
    const real =
      'page.fill: Timeout 30000ms exceeded.\n  - locator resolved to <input type="password" hidden/>\n  - fill("' +
      SECRET +
      '")';
    const out = scrubSecret(real, SECRET);
    expect(out).not.toContain(SECRET);
    /* The message still has to be useful, or somebody will print the raw one. */
    expect(out).toContain("Timeout 30000ms exceeded");
    expect(out).toContain("hidden");
  });

  it("removes every occurrence, not just the first", () => {
    expect(scrubSecret(`${SECRET} and again ${SECRET}`, SECRET)).not.toContain(SECRET);
  });

  /* A network layer may have encoded it on the way through, and a redactor
     that only matched the literal would pass those straight out. */
  it("removes the url-encoded form", () => {
    const secret = "p@ss word/+=";
    const text = `POST /login?password=${encodeURIComponent(secret)}`;
    expect(scrubSecret(text, secret)).not.toContain(encodeURIComponent(secret));
  });

  it("removes the json-escaped form", () => {
    const secret = 'has"quote\\slash';
    const text = `body: {"password":"${JSON.stringify(secret).slice(1, -1)}"}`;
    expect(scrubSecret(text, secret)).not.toContain(JSON.stringify(secret).slice(1, -1));
  });

  it("leaves text alone when there is no secret to remove", () => {
    expect(scrubSecret("nothing to see", "")).toBe("nothing to see");
  });

  /* A very short secret would match everywhere and turn the message into
     nonsense, which is its own way of hiding what went wrong. */
  it("refuses to scrub a secret too short to be one", () => {
    expect(scrubSecret("a cat sat on a mat", "at")).toBe("a cat sat on a mat");
  });
});

describe("running work that handles a secret", () => {
  it("returns the value when nothing fails", async () => {
    expect(await withSecret(SECRET, async () => "fine")).toBe("fine");
  });

  it("scrubs a thrown error before it escapes", async () => {
    await expect(
      withSecret(SECRET, async () => {
        throw new Error(`fill("${SECRET}") failed`);
      }),
    ).rejects.toThrow(/<redacted>/);

    await expect(
      withSecret(SECRET, async () => {
        throw new Error(`fill("${SECRET}") failed`);
      }),
    ).rejects.not.toThrow(new RegExp(SECRET));
  });

  /* A library error can carry the value in properties a message-only scrub
     would miss, so what comes out is a plain Error rather than the original. */
  it("does not re-throw the original error object", async () => {
    const original = Object.assign(new Error(`bad ${SECRET}`), { detail: SECRET });
    const caught = await withSecret(SECRET, async () => {
      throw original;
    }).catch((e) => e as Error & { detail?: string });
    expect(caught).not.toBe(original);
    expect(caught.detail).toBeUndefined();
    expect(caught.message).not.toContain(SECRET);
  });

  it("handles something thrown that is not an Error", async () => {
    const caught = await withSecret(SECRET, async () => {
      throw `raw string with ${SECRET}`;
    }).catch((e) => e as Error);
    expect(caught.message).not.toContain(SECRET);
  });
});
