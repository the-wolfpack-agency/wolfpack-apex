/**
 * A ratchet against fetch doubles that model the wrong contract.
 *
 * Three bugs in three pull requests came from hand-rolled fetch fakes, and each
 * time the tests passed while production was broken, because the code and the
 * fake shared the same misunderstanding. A test suite that agrees with the bug
 * is worse than no test: it converts an unknown risk into false confidence.
 *
 * The specific mistake this catches is `ok` computed as `status < 400`. Real
 * fetch sets `ok` for 2xx and nothing else, so such a fake reports a redirect as
 * a success. In #224 that hid a scanner following redirects without checking
 * where they led. Five other suites had the same latent trap; none exercised a
 * 3xx yet, so none had sprung.
 *
 * If you are here because this test failed: use `fakeFetch` from
 * ./fake-fetch.ts rather than writing another one. It encodes the abort
 * contract and the header contract too, which are the other two that bit us.
 *
 * The allowlist may SHRINK, never grow. A stale entry fails as well, so it
 * cannot rot into permanent permission.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..", "..", "..");

/**
 * Suites still computing `ok` the wrong way. Empty, and meant to stay that way.
 * An entry here is a debt, not an exemption.
 */
const KNOWN_OFFENDERS: readonly string[] = [];

/** `ok: <anything> < 400` — the mistake. Tolerates whitespace and parens. */
const WRONG_OK = /\bok\s*:\s*[^,;\n]*<\s*=?\s*400\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("fetch doubles model the real contract", () => {
  const offenders = walk(SRC)
    // This file necessarily contains the pattern: its third test asserts the
    // regex actually matches what it claims to. The detector is not an offender.
    .filter((f) => f !== __filename)
    .filter((f) => WRONG_OK.test(fs.readFileSync(f, "utf-8")))
    .map((f) => path.relative(SRC, f))
    .sort();

  it("no test computes response.ok as status < 400", () => {
    const unexpected = offenders.filter((f) => !KNOWN_OFFENDERS.includes(f));
    expect({
      hint: "Real fetch sets ok for 2xx ONLY. Use fakeFetch from src/lib/platform-scan/__tests__/fake-fetch.ts.",
      files: unexpected,
    }).toEqual({ hint: expect.any(String), files: [] });
  });

  it("the allowlist has no stale entries, so it cannot rot into permission", () => {
    const fixed = KNOWN_OFFENDERS.filter((f) => !offenders.includes(f));
    expect({ hint: "These were fixed. Remove them from KNOWN_OFFENDERS.", files: fixed }).toEqual({
      hint: expect.any(String),
      files: [],
    });
  });

  it("catches the pattern it claims to catch", () => {
    // A guardrail nobody has seen fail is a guardrail nobody knows works.
    expect(WRONG_OK.test("ok: (init.status ?? 200) < 400,")).toBe(true);
    expect(WRONG_OK.test("ok: status<400")).toBe(true);
    expect(WRONG_OK.test("ok: opts.ok ?? (opts.status ?? 200) < 400,")).toBe(true);
    // ...and does not fire on the correct form.
    expect(WRONG_OK.test("ok: status >= 200 && status < 300,")).toBe(false);
    expect(WRONG_OK.test("ok: true,")).toBe(false);
    // Not a fetch fake at all: a plain latency comparison must not trip it.
    expect(WRONG_OK.test("expect(durationMs).toBeLessThan(400);")).toBe(false);
  });
});
